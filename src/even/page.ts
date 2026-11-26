import { makeT } from '../i18n'
import { buildView, type View } from '../view/build'
import { createTarget, type GlassesTarget, type MenuItem } from './adapter'
import { chatById, initialState, reduce, unreadMsgs, visibleChats } from '../state/reducer'
import type {
  AppEvent,
  AppState,
  AudioSource,
  FeedStatus,
  Gesture,
  Lang,
  MockChat,
} from '../state/types'
import * as LINES from '../state/limits'

/**
 * Orchestrator: holds the state, runs the reducer, writes the picture to target.
 *
 * Duties that do not belong to the pure logic:
 *
 * 1. Root page: double tap = system exit dialog
 *    (shutDownPageContainer(1), Even Hub QA requirement). On other screens
 *    a double tap is "back", decided by the reducer.
 *
 * 2. Tap debounce: if a double tap follows a tap, the single one must be
 *    cancelled. A lone tap fires after CLICK_DELAY. Check on hardware whether
 *    the host disambiguates by itself: if it does, drop the delay.
 *
 * 3. Swipes are cooled down by SWIPE_COOLDOWN: the firmware may emit several
 *    SCROLL events in a row for one movement (community-notes quirk).
 *
 * 4. Side effects of the screen: the microphone follows LISTENING (SDK
 *    audioControl) and the language is stored in the host storage
 *    (setLocalStorage), so both survive a WebView restart on Android.
 */

const CLICK_DELAY = 250
const SWIPE_COOLDOWN = 250
/** Timer resolution for mock sending (1.5 s) and the "sent · X" flash. */
const TICK_MS = 200
/** The microphone indicator is redrawn at most 5 times per second. */
const AUDIO_RENDER_MS = 200

export interface GlassesSettings {
  lang: Lang
  quickReply: string
  telegramConnected: boolean
  selectedChats: string[] | null
  /** Backend has an LLM key: REPLIES may ask for options. */
  llmConfigured: boolean
}

export interface Page {
  /** Event straight into the logic (list, menu, tick). */
  dispatch(e: AppEvent): void
  /** Gesture — through the debounce and the exit interceptor. */
  gesture(g: Gesture): void
  /** Phone settings (T1/T3) pushed into the screen state. */
  applySettings(settings: GlassesSettings): void
  /** Real chats from the backend; `status` says whether they are real at all. */
  applyChats(status: FeedStatus, chats: MockChat[] | null, merge?: boolean): void
  /**
   * The screen asked for fresh data (tap on an empty CHATS, or the WebView came
   * back to the foreground). The page has no network — the WebView fetches and
   * calls `applyChats` with the result. `null` removes the handler.
   */
  onRefresh(cb: (() => void) | null): void
  /** REPLIES opened on a real message and needs options from the backend. */
  onReplies(cb: ((chatId: string, messageId: string) => void) | null): void
  /** The LLM answered (or refused): options for one message, `null` = failed. */
  applyReplies(
    chatId: string,
    messageId: string,
    result: { summary: string; replies: string[] } | null,
  ): void
  subscribe(cb: (s: AppState) => void): () => void
  state(): AppState
  /** true — the page lives inside Even App (glasses), false — browser. */
  readonly native: boolean
}

export function createPage(target: GlassesTarget, start: AppState = initialState()): Page {
  let s = start
  const listeners = new Set<(s: AppState) => void>()

  let pending: { timer: number; run: () => void } | null = null
  let lastSwipe = 0
  /** Set by the WebView: it owns `fetch`, the page only says "data is stale". */
  let refreshHandler: (() => void) | null = null
  /** Set by the WebView: it fetches LLM options, the page shows the skeleton. */
  let replyHandler: ((chatId: string, messageId: string) => void) | null = null
  /** Requests already sent, so a tick does not ask twice for one message. */
  const repliesInFlight = new Set<string>()

  function menuItems(): MenuItem[] {
    const t = makeT(s.lang)
    return [
      { id: 1, name: t('demo.lang', { value: s.lang.toUpperCase() }) },
      {
        id: 2,
        name: t('demo.backend', {
          value: t(s.backendDown ? 'demo.value.down' : 'demo.value.up'),
        }),
      },
      {
        id: 3,
        name: t('demo.mic', {
          value: t(s.phoneMic ? 'demo.value.phone' : 'demo.value.glasses'),
        }),
      },
      {
        id: 4,
        name: t('demo.telegram', {
          value: t(s.telegramConnected ? 'demo.value.on' : 'demo.value.off'),
        }),
      },
      { id: 5, name: t('demo.read') },
    ]
  }

  /**
   * Renders are serialized: the bridge takes one page at a time, and the PCM
   * stream can request a redraw while the previous one is still in flight.
   * Only the newest pending picture is kept — intermediate indicator frames
   * are worthless.
   */
  let rendering = false
  let queued: View | null = null

  async function drain(): Promise<void> {
    if (rendering) return
    rendering = true
    try {
      while (queued !== null) {
        const view = queued
        queued = null
        await target.render(view, menuItems())
      }
    } finally {
      rendering = false
    }
  }

  function requestRender(): void {
    queued = buildView(s, makeT(s.lang))
    void drain()
  }

  /**
   * The microphone is one resource with one owner: this page. The screen only
   * says which source it believes in; the page opens it, watches for silence
   * and falls back to the phone microphone when the glasses give nothing.
   */
  let micSeq = 0
  let micTimer: number | null = null
  /** A chunk arrived for the current attempt — the 2 s fallback is not needed. */
  let micHeard = false
  let recordTimer: number | null = null

  function clearMicTimer(): void {
    if (micTimer !== null) {
      window.clearTimeout(micTimer)
      micTimer = null
    }
  }

  function stopMic(source: AudioSource): void {
    micSeq++
    clearMicTimer()
    void target.audio(false, source)
  }

  /**
   * Open the microphone and arm the fallback. `seq` invalidates the answers of
   * attempts that are already over: the user may leave LISTENING mid-call.
   */
  async function openMic(source: AudioSource): Promise<void> {
    const seq = ++micSeq
    clearMicTimer()
    micHeard = false

    const ok = await target.audio(true, source)
    if (seq !== micSeq || s.screen.kind !== 'listening') return

    if (!ok) {
      // Refused (permission, or no capture on this host). The glasses one is the
      // default, so its refusal is what the phone fallback exists for.
      console.warn('[teleglass] microphone refused:', source)
      if (source === 'glasses') {
        void target.audio(false, 'glasses')
        apply({ type: 'micSource', source: 'phone' })
      }
      return
    }

    // No glasses in a browser: there is nothing to fall back from.
    if (source !== 'glasses' || !target.native) return

    micTimer = window.setTimeout(() => {
      micTimer = null
      if (seq !== micSeq || micHeard || s.screen.kind !== 'listening') return
      // 2 s without a single chunk: the glasses are not recording. Take the
      // phone microphone and say so in the footer (design-system.md §5.1).
      console.warn('[teleglass] no audio in 2 s — switching to the phone microphone')
      void target.audio(false, 'glasses')
      apply({ type: 'micSource', source: 'phone' })
    }, LINES.MIC_FALLBACK_MS)
  }

  /**
   * Hard cap on one recording: the hold is a press/release pair and the OS may
   * swallow the release (ux-flow.md § Что может не сойтись). The synthetic
   * gesture is the same one the user would send.
   */
  function armRecordWatchdog(): void {
    clearRecordWatchdog()
    recordTimer = window.setTimeout(() => {
      recordTimer = null
      if (s.screen.kind !== 'listening') return
      console.warn('[teleglass] recording stopped at the cap:', LINES.MAX_RECORD_MS, 'ms')
      apply({
        type: 'gesture',
        gesture: s.screen.mode === 'hold' ? 'longPressRelease' : 'click',
      })
    }, LINES.MAX_RECORD_MS)
  }

  function clearRecordWatchdog(): void {
    if (recordTimer !== null) {
      window.clearTimeout(recordTimer)
      recordTimer = null
    }
  }

  function publish(next: AppState): void {
    if (next === s) return
    const prev = s
    s = next

    // Screen transitions in the WebView console: the phone panel shows them too,
    // but during on-device testing there is only the console.
    if (prev.screen.kind !== s.screen.kind) {
      console.log(`[teleglass] screen: ${prev.screen.kind} → ${s.screen.kind}`)
    }

    // Microphone follows the LISTENING screen and the source it shows.
    if (s.screen.kind === 'listening') {
      const prevSource = prev.screen.kind === 'listening' ? prev.screen.source : null
      if (prevSource !== s.screen.source) {
        if (prevSource !== null) stopMic(prevSource)
        void openMic(s.screen.source)
      }
      if (prev.screen.kind !== 'listening') armRecordWatchdog()
    } else if (prev.screen.kind === 'listening') {
      stopMic(prev.screen.source)
      clearRecordWatchdog()
    }

    // Language is a host preference: store it where a WebView restart cannot lose it.
    if (prev.lang !== s.lang) void target.saveLang(s.lang)

    requestRender()
    for (const l of [...listeners]) l(s)
    maybeRequestReplies()
  }

  /**
   * REPLIES opens on a skeleton and asks the WebView for options. The page owns
   * the decision (configured? real message?), the WebView owns the request; the
   * in-flight set keeps the 200 ms tick from asking twice for one message.
   */
  function maybeRequestReplies(): void {
    const scr = s.screen
    if (scr.kind !== 'repliesLoading') return
    const chat = chatById(s, scr.chatId)
    const msg = chat ? unreadMsgs(chat, s.read)[scr.msgIndex] : undefined
    if (!msg?.remoteId || replyHandler === null) {
      // Nothing to ask: never leave the skeleton spinning forever.
      console.warn('[teleglass] replies were requested with no way to fetch them')
      publish(reduce(s, { type: 'gesture', gesture: 'doubleClick' }))
      return
    }
    const key = `${scr.chatId}#${msg.remoteId}`
    if (repliesInFlight.has(key)) return
    repliesInFlight.add(key)
    replyHandler(scr.chatId, msg.remoteId)
  }

  /**
   * Microphone chunks arrive far faster than the screen refreshes. They change
   * only the indicator, so the state is updated on every chunk while the
   * framebuffer is refreshed at AUDIO_FPS — the same rate a person can read.
   */
  let lastAudioRender = 0

  function applyAudio(e: AppEvent): void {
    if (s.screen.kind === 'listening') micHeard = true
    const next = reduce(s, e)
    if (next === s) return
    s = next
    const now = Date.now()
    if (now - lastAudioRender >= AUDIO_RENDER_MS) {
      lastAudioRender = now
      requestRender()
    }
    for (const l of [...listeners]) l(s)
  }

  function apply(e: AppEvent): void {
    publish(reduce(s, e))
  }

  function scheduleClick(run: () => void): void {
    if (pending !== null) window.clearTimeout(pending.timer)
    pending = {
      timer: window.setTimeout(() => {
        pending = null
        run()
      }, CLICK_DELAY),
      run,
    }
  }

  function cancelPending(): void {
    if (pending !== null) {
      window.clearTimeout(pending.timer)
      pending = null
    }
  }

  const gesture = (g: Gesture): void => {
    if (g === 'click') {
      // A double tap may follow — wait out CLICK_DELAY.
      scheduleClick(() => {
        // ux-flow: a tap on an empty CHATS means "check again". With real chats
        // that is a backend round-trip, so the page asks the WebView for it.
        const idle =
          s.telegramConnected && s.screen.kind === 'chats' && visibleChats(s).length === 0
        apply({ type: 'gesture', gesture: 'click' })
        if (idle) refreshHandler?.()
      })
      return
    }
    if (g === 'doubleClick') {
      cancelPending()
      // Double tap on the root page = exit, not "back".
      if (s.screen.kind === 'chats') {
        target.exit()
        return
      }
      apply({ type: 'gesture', gesture: 'doubleClick' })
      return
    }
    if (g === 'swipeUp' || g === 'swipeDown') {
      const now = Date.now()
      if (now - lastSwipe < SWIPE_COOLDOWN) return
      lastSwipe = now
    }
    apply({ type: 'gesture', gesture: g })
  }

  function dispatch(e: AppEvent): void {
    switch (e.type) {
      case 'gesture':
        gesture(e.gesture)
        return
      case 'listClick':
        // Like a single tap: a double tap on the list must get a chance
        // to cancel opening the item.
        scheduleClick(() => apply(e))
        return
      case 'audio':
        applyAudio(e)
        return
      case 'foreground':
        apply(e)
        // Audio capture stops while the WebView is suspended
        // (background-lifecycle.md): ask for the same source again.
        if (s.screen.kind === 'listening') void openMic(s.screen.source)
        // The glasses were off the head: unread may have arrived meanwhile.
        if (s.telegramConnected) refreshHandler?.()
        return
      default:
        apply(e)
    }
  }

  target.onEvent((e) => dispatch(e))

  /**
   * Phone settings → glasses state. The merge lives in `mergeSettings` so the
   * very first page can be built correct: a fresh install opens on "connect
   * Telegram" instead of flashing the mock chat list for one frame.
   */
  function applySettings(v: GlassesSettings): void {
    publish(mergeSettings(s, v))
  }

  /**
   * A feed is a full snapshot of what the glasses may show; the reducer decides
   * how the current screen survives it. `demo` restores the mock set, `loading`
   * and `error` clear the list — a connected account is never shown mocks.
   */
  function applyChats(status: FeedStatus, chats: MockChat[] | null, merge = false): void {
    publish(reduce(s, { type: 'feed', status, chats, merge }))
  }

  function onRefresh(cb: (() => void) | null): void {
    refreshHandler = cb
  }

  function onReplies(cb: ((chatId: string, messageId: string) => void) | null): void {
    replyHandler = cb
  }

  function applyReplies(
    chatId: string,
    messageId: string,
    result: { summary: string; replies: string[] } | null,
  ): void {
    repliesInFlight.delete(`${chatId}#${messageId}`)
    const ok = result !== null && result.replies.length === 3
    const next = reduce(s, {
      type: 'llmReplies',
      chatId,
      messageId,
      ok,
      summary: result?.summary ?? '',
      replies: result?.replies ?? [],
    })
    if (next === s) {
      // The message left the feed while the request ran (the phone read the chat
      // or the feed refreshed). Nothing will show and no new request will start,
      // so do not leave the skeleton on screen: go back to the chat, as the
      // double tap would. If the screen already moved to another message of the
      // same chat, that message has its own request - leave it alone.
      if (s.screen.kind === 'repliesLoading' && s.screen.chatId === chatId) {
        const chat = chatById(s, chatId)
        const shown = chat ? unreadMsgs(chat, s.read)[s.screen.msgIndex] : undefined
        const busy = shown?.remoteId
          ? repliesInFlight.has(`${chatId}#${shown.remoteId}`)
          : false
        if (!busy) {
          console.warn('[teleglass] replies arrived for a message no longer in the feed')
          publish(reduce(s, { type: 'gesture', gesture: 'doubleClick' }))
        }
      }
      return
    }
    publish(next)
  }

  // First screen and ticks. StrictMode mounts components twice —
  // createPage is called once per page (see App.tsx).
  requestRender()
  window.setInterval(() => apply({ type: 'tick', now: Date.now() }), TICK_MS)

  return {
    dispatch,
    gesture,
    applySettings,
    applyChats,
    onRefresh,
    onReplies,
    applyReplies,
    subscribe(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    state: () => s,
    native: target.native,
  }
}

/** Order-insensitive comparison: the selection is a set, not a list. */
function sameIds(a: string[] | null, b: string[] | null): boolean {
  if (a === b) return true
  if (a === null || b === null || a.length !== b.length) return false
  const set = new Set(a)
  return b.every((id) => set.has(id))
}

/**
 * One merge point for the phone settings. A change from T1 or T3 cannot leave
 * the screen on a chat the phone has excluded, and a disconnect always lands on
 * CHATS (the same rule as the demo menu lever).
 */
function mergeSettings(s: AppState, v: GlassesSettings): AppState {
  let next = s

  if (next.lang !== v.lang) next = { ...next, lang: v.lang }
  if (next.quickReplyText !== v.quickReply) next = { ...next, quickReplyText: v.quickReply }
  if (next.llmConfigured !== v.llmConfigured) next = { ...next, llmConfigured: v.llmConfigured }

  if (next.telegramConnected !== v.telegramConnected) {
    next = v.telegramConnected
      ? next.feedStatus === 'demo'
        ? // A fresh link: the demo chats are not this account's. Open on
          // "checking" and wait for the real feed instead of showing them.
          { ...next, telegramConnected: true, feedStatus: 'loading', chats: [], read: {} }
        : { ...next, telegramConnected: true }
      : {
          ...next,
          telegramConnected: false,
          screen: { kind: 'chats' },
          flash: null,
          sendingRow: null,
        }
  }

  if (!sameIds(next.selectedChats, v.selectedChats)) {
    next = { ...next, selectedChats: v.selectedChats }
    const count = visibleChats(next).length
    next = { ...next, selChat: count === 0 ? 0 : Math.min(next.selChat, count - 1) }
  }

  return next
}

/** One target and one page for the whole app (StrictMode mounts twice). */
let singleton: Promise<Page> | null = null

export function getPage(start?: GlassesSettings): Promise<Page> {
  singleton ??= createTarget().then(async (target) => {
    // Language from the host storage (official persistence path) is the fallback;
    // the phone settings, when passed, win because they are the user's choice.
    const saved = await target.loadLang()
    let base = saved ? { ...initialState(), lang: saved } : initialState()
    if (start) {
      base = mergeSettings(base, start)
      // A saved "connected" flag opens on "checking", never on the demo chats:
      // the first frame must not show someone else's conversations as real.
      if (start.telegramConnected && base.feedStatus === 'demo') {
        base = { ...base, feedStatus: 'loading', chats: [], read: {} }
      }
    }
    const page = createPage(target, base)
    console.log('[teleglass] target:', target.native ? 'glasses bridge' : 'browser mock')
    return page
  })
  return singleton
}
