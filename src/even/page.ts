import { makeT } from '../i18n'
import { buildView, type View } from '../view/build'
import { createTarget, type GlassesTarget, type MenuItem } from './adapter'
import { anchorId, chatById, initialState, reduce, replyActionOf, unreadMsgs, visibleChats } from '../state/reducer'
import { MOCK_HEARD_LONG, MOCK_HEARD_TEXT } from '../state/data'
import type {
  AppEvent,
  AppState,
  FeedStatus,
  Gesture,
  Lang,
  MockChat,
  MockMessage,
} from '../state/types'
import * as LINES from '../state/limits'
import { lineCount } from '../state/wrap'

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
  /**
   * SENDING opened and a real message is behind it: the WebView sends the text
   * and answers through `applySend`. The page holds no token and no network.
   */
  onSend(
    cb: ((chatId: string, messageId: string, text: string, mode: 'reply' | 'quick') => void) | null,
  ): void
  /**
   * The send is over: `true` — SENT (with Telegram's time), `false` — OFFLINE;
   * `gone` — the message is not there any more, so SENDING is left without a
   * retry. `chatId`/`messageId` name the attempt the answer belongs to.
   */
  applySend(result: {
    chatId: string
    messageId: string
    ok: boolean
    at?: string
    gone?: boolean
  }): void
  /** A read mark did not reach Telegram: stop hiding that chat's messages. */
  applyUnread(chatId: string, messageId?: string): void
  /**
   * A message was skipped on the glasses and is read now; Telegram must be
   * told. Viewing a chat never calls this — просмотр ≠ прочтение.
   */
  onMark(cb: ((chatId: string, messageId: string) => void) | null): void
  /**
   * The recording stopped and its PCM must be recognized. The page holds no
   * network: the WebView sends the bytes and answers with `applyTranscript`.
   * `attempt` names the recording (its start time).
   */
  onTranscript(cb: ((chatId: string, attempt: number, pcm: Uint8Array) => void) | null): void
  /** The recognizer answered (or refused) for one recording. */
  applyTranscript(chatId: string, attempt: number, result: { ok: boolean; text: string }): void
  /** A voice message of the feed needs a transcript (once per message). */
  onIncomingTranscript(cb: ((chatId: string, messageId: string) => void) | null): void
  /** The transcript for an incoming voice message arrived, or did not. */
  applyIncomingTranscript(
    chatId: string,
    messageId: string,
    result: { ok: boolean; text: string },
  ): void
  /**
   * HEARD → SENDING voice: the WebView uploads the same recording as a voice
   * note. The page keeps the PCM of the last recording for exactly this.
   */
  onSendVoice(
    cb: ((chatId: string, messageId: string, pcm: Uint8Array) => void) | null,
  ): void
  subscribe(cb: (s: AppState) => void): () => void
  state(): AppState
  /** true — the page lives inside Even App (glasses), false — browser. */
  readonly native: boolean
}

/** Telegram id (or the demo id) of one message of a chat's unread window. */
function messageIdIn(s: AppState, chatId: string, msgIndex: number): string | null {
  const chat = chatById(s, chatId)
  if (!chat) return null
  const message = unreadMsgs(chat, s.read)[msgIndex]
  // One rule for "which id does this row mean", shared with the reducer.
  return message ? anchorId(message) : null
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
  /** Set by the WebView: it owns `sendReply`, the page shows SENDING. */
  let sendHandler:
    | ((chatId: string, messageId: string, text: string, mode: 'reply' | 'quick') => void)
    | null = null
  /** Set by the WebView: SKIP? marks the message read on Telegram. */
  let readHandler: ((chatId: string, messageId: string) => void) | null = null
  /** Set by the WebView: it recognizes the recording (no STT in the page). */
  let transcriptHandler: ((chatId: string, attempt: number, pcm: Uint8Array) => void) | null = null
  /** Set by the WebView: it transcribes an incoming voice message. */
  let incomingTranscriptHandler: ((chatId: string, messageId: string) => void) | null = null
  /** Set by the WebView: it uploads the recording as a voice note. */
  let voiceHandler: ((chatId: string, messageId: string, pcm: Uint8Array) => void) | null = null
  /** Requests already sent, so a tick does not ask twice for one message. */
  const repliesInFlight = new Set<string>()
  /** Sends in flight, keyed by `chatId#messageId`: the clock must not resolve them. */
  const sendsInFlight = new Set<string>()
  /** Voice messages whose transcript was already asked for. */
  const transcriptsInFlight = new Set<string>()
  /** The last recording: HEARD can send it as a voice note (task v0.7 §7). */
  let lastPcm: Uint8Array | null = null
  let lastRecordMs = 0

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
   * The microphone is one resource with one owner: this page. Only the glasses
   * microphone exists in this product (Антон, 27.11): a refusal ends the
   * recording with an honest "did not catch it", it does not switch devices.
   */
  let micSeq = 0
  let recordTimer: number | null = null
  /** Wall-clock marks for the 2 s silence rule (task v0.7 §6). */
  let lastChunkAt = 0
  let lastSoundAt = 0

  function stopMic(): void {
    micSeq++
    void target.audio(false)
  }

  /**
   * Open the glasses microphone. `seq` invalidates the answers of attempts that
   * are already over: the user may leave LISTENING mid-call.
   */
  async function openMic(): Promise<void> {
    const seq = ++micSeq
    // A re-arm after suspend must not inherit the pre-suspend silence clock.
    lastChunkAt = Date.now()
    lastSoundAt = lastChunkAt
    const ok = await target.audio(true)
    if (seq !== micSeq || s.screen.kind !== 'listening') return

    if (!ok) {
      // Refused (permission, or no capture on this host). There is no fallback
      // microphone. A dictated reply ends on HEARD "did not catch it"; a voice
      // note has nothing to send, so it returns to the options instead of
      // posting a silent recording.
      console.warn('[teleglass] microphone refused')
      void target.audio(false)
      if (s.screen.outcome === 'voice') {
        apply({ type: 'gesture', gesture: 'swipeUp' })
        return
      }
      apply({
        type: 'gesture',
        gesture: s.screen.mode === 'hold' ? 'longPressRelease' : 'click',
      })
    }
  }

  /**
   * Hard cap on one recording: the hold is a press/release pair and the OS may
   * swallow the release (ux-flow.md § Что может не сойтись). The synthetic
   * gesture is the same one the user would send. Dictation stops at 45 s so it
   * fits the recognition budget; a voice note is sent as recorded and follows
   * Telegram's own 120 s limit.
   */
  function armRecordWatchdog(): void {
    clearRecordWatchdog()
    // A voice note is sent as is, so only the dictation cap has to fit the
    // recognition budget; the note itself follows Telegram's limit.
    const cap =
      s.screen.kind === 'listening' && s.screen.outcome === 'voice'
        ? LINES.MAX_VOICE_RECORD_MS
        : LINES.MAX_RECORD_MS
    recordTimer = window.setTimeout(() => {
      recordTimer = null
      if (s.screen.kind !== 'listening') return
      console.warn('[teleglass] recording stopped at the cap:', cap, 'ms')
      apply({
        type: 'gesture',
        gesture: s.screen.mode === 'hold' ? 'longPressRelease' : 'click',
      })
    }, cap)
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

    // Microphone follows the LISTENING screen. A new recording starts with an
    // empty buffer; leaving the screen closes the capture but keeps the bytes
    // until the page hands them over.
    if (s.screen.kind === 'listening') {
      if (prev.screen.kind !== 'listening') {
        target.clearPcm()
        void openMic()
        armRecordWatchdog()
      } else if (s.screen.phase === 'recognizing' && prev.screen.phase !== 'recognizing') {
        // Dictation stopped, whisper takes over: the microphone closes, the
        // footer says "recognizing…", and the PCM leaves the adapter once.
        stopMic()
        clearRecordWatchdog()
        finishRecording(prev.screen)
      }
    } else if (prev.screen.kind === 'listening') {
      stopMic()
      clearRecordWatchdog()
      // Whatever the reducer decided (HEARD for a too-short tap, or SENDING a
      // voice note), the bytes leave the adapter exactly once. Leaving the
      // recognizing phase means the answer already arrived.
      if (
        prev.screen.phase !== 'recognizing' &&
        (s.screen.kind === 'heard' ||
          (s.screen.kind === 'sending' && s.screen.mode === 'voice'))
      ) {
        finishRecording(prev.screen)
      }
    }

    // Language is a host preference: store it where a WebView restart cannot lose it.
    if (prev.lang !== s.lang) void target.saveLang(s.lang)

    requestRender()
    for (const l of [...listeners]) l(s)
    maybeRequestReplies()
    maybeRequestSend()
    maybeRequestVoice()
    maybeRequestIncomingTranscript()
  }

  /**
   * The recording ended. In a browser there is no microphone, so HEARD keeps
   * its labelled mock text (the demo rules: under a second is a failure, a long
   * hold shows a long transcript so scrolling is reachable). On the glasses the
   * PCM goes to the backend; an empty buffer is an honest failure.
   */
  function finishRecording(rec: Extract<AppState['screen'], { kind: 'listening' }>): void {
    const pcm = target.takePcm()
    // The watchdog stops a voice note at 120 s, but a chunk may still land
    // between the timer and the stop. The backend rejects anything longer, so
    // the payload is cut to the cap instead of losing the whole note to a 400.
    const maxBytes = (LINES.MAX_VOICE_RECORD_MS / 1000) * 32_000
    lastPcm = pcm.byteLength > maxBytes ? pcm.slice(0, maxBytes) : pcm
    lastRecordMs = Math.max(0, Date.now() - rec.startAt)
    const scr = s.screen
    // Only a dictation that is waiting for whisper hands its PCM over. A voice
    // note is uploaded by `maybeRequestVoice`; a short failed tap has nothing.
    if (scr.kind !== 'listening' || scr.phase !== 'recognizing') return
    const attempt = scr.startAt

    const resolve = (ok: boolean, text: string): void => {
      publish(reduce(s, { type: 'heardResult', chatId: scr.chatId, attempt, ok, text }))
    }

    if (!target.native) {
      resolve(true, lastRecordMs > 4_000 ? MOCK_HEARD_LONG : MOCK_HEARD_TEXT)
      return
    }
    if (pcm.byteLength < 3_200) {
      // Less than 0.1 s: nothing to recognize (refused capture, dead mic).
      console.warn('[teleglass] recording is empty')
      resolve(false, '')
      return
    }
    if (transcriptHandler === null) {
      console.warn('[teleglass] recording was not sent: no recognizer')
      resolve(false, '')
      return
    }
    transcriptHandler(scr.chatId, attempt, pcm)
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
    // Options for a voice note must answer the spoken words, not the label
    // "Voice message". The scan transcribes unread notes in the background and
    // puts the message on screen first; while it has no verdict the skeleton
    // waits. `failed` is a verdict too: then the label is all we have.
    if (msg.voice && msg.transcript === undefined && incomingTranscriptHandler !== null) return
    repliesInFlight.add(key)
    replyHandler(scr.chatId, msg.remoteId)
  }

  /**
   * SENDING is resolved by the WebView's answer, not by the clock: the request
   * leaves the moment the state says `sending`, and `applySend` is the way back.
   * The clock only fails the demo lever "backend not responding".
   */
  function maybeRequestSend(): void {
    const scr = s.screen
    if (scr.kind !== 'sending') return
    // A voice note is a different request (and a different payload): see
    // `maybeRequestVoice`.
    if (scr.mode === 'voice') return
    // The lever: no request leaves, and the clock turns SENDING into OFFLINE.
    if (s.backendDown) return
    const fail = (why: string): void => {
      console.warn(`[teleglass] send was not attempted: ${why}`)
      publish(
        reduce(s, {
          type: 'sendResult',
          chatId: scr.chatId,
          messageId: scr.messageId,
          ok: false,
        }),
      )
    }
    if (sendHandler === null) {
      // No way to send: never let the clock pretend it went through.
      fail('no handler')
      return
    }
    if (!scr.messageId) {
      // The message left the feed before the tap was committed; there is
      // nothing to anchor `random_id` to, and a retry would hit the same wall.
      console.warn('[teleglass] send was not attempted: no anchor')
      publish(
        reduce(s, {
          type: 'sendResult',
          chatId: scr.chatId,
          messageId: scr.messageId,
          ok: false,
          gone: true,
        }),
      )
      return
    }
    const key = `${scr.chatId}#${scr.messageId}`
    if (sendsInFlight.has(key)) return
    sendsInFlight.add(key)
    sendHandler(scr.chatId, scr.messageId, scr.reply, scr.mode)
  }

  /**
   * HEARD → SENDING (voice): the WebView uploads the recording. The page keeps
   * the last PCM; without it there is nothing to retry, and the screen leaves
   * SENDING the same way a gone message does.
   */
  function maybeRequestVoice(): void {
    const scr = s.screen
    if (scr.kind !== 'sending' || scr.mode !== 'voice') return
    if (s.backendDown) return
    const fail = (gone: boolean): void => {
      console.warn('[teleglass] voice send was not attempted')
      publish(
        reduce(s, {
          type: 'sendResult',
          chatId: scr.chatId,
          messageId: scr.messageId,
          ok: false,
          gone,
        }),
      )
    }
    if (!scr.messageId || voiceHandler === null) {
      fail(true)
      return
    }
    if (target.native && (!lastPcm || lastPcm.byteLength < 3_200)) {
      // The microphone answered but delivered no PCM: nothing to upload. CHATS
      // would look like a sent message, OFFLINE would retry the same empty
      // file — the options are the only honest place.
      console.warn('[teleglass] voice send was not attempted: no recording')
      publish(reduce(s, { type: 'voiceEmpty' }))
      return
    }
    const key = `${scr.chatId}#${scr.messageId}`
    if (sendsInFlight.has(key)) return
    sendsInFlight.add(key)
    voiceHandler(scr.chatId, scr.messageId, lastPcm ?? new Uint8Array())
  }

  /**
   * Incoming voice notes are transcribed as soon as the feed arrives, not when
   * the message is opened: CHAT must show the words at once (owner's call,
   * 27.11). Two at a time — whisper is one model on one machine, and a burst of
   * notes would otherwise queue for a minute. One attempt per message: a
   * failure leaves the media word and is retried only after the feed is
   * reloaded.
   */
  function maybeRequestIncomingTranscript(): void {
    const handler = incomingTranscriptHandler
    if (handler === null) return
    if (transcriptsInFlight.size >= LINES.TRANSCRIPTS_AT_ONCE) return

    const ask = (chatId: string, msg: MockMessage): boolean => {
      if (!msg.voice || msg.transcript || !msg.remoteId) return false
      const key = `${chatId}#${msg.remoteId}`
      if (transcriptsInFlight.has(key)) return false
      transcriptsInFlight.add(key)
      handler(chatId, msg.remoteId)
      return true
    }
    const full = (): boolean => transcriptsInFlight.size >= LINES.TRANSCRIPTS_AT_ONCE

    // The message on screen first: the reply options wait for its transcript,
    // and two busy slots taken by other notes would stretch that wait.
    const scr = s.screen
    if (
      scr.kind === 'chat' ||
      scr.kind === 'fulltext' ||
      scr.kind === 'replies' ||
      scr.kind === 'repliesLoading'
    ) {
      const chat = chatById(s, scr.chatId)
      const msg = chat ? unreadMsgs(chat, s.read)[scr.msgIndex] : undefined
      if (chat && msg && ask(chat.id, msg) && full()) return
    }
    for (const chat of s.chats) {
      for (const msg of unreadMsgs(chat, s.read)) {
        if (ask(chat.id, msg) && full()) return
      }
    }
  }

  /**
   * Microphone chunks arrive far faster than the screen refreshes. They change
   * only the indicator, so the state is updated on every chunk while the
   * framebuffer is refreshed at AUDIO_FPS — the same rate a person can read.
   */
  let lastAudioRender = 0

  function applyAudio(e: AppEvent): void {
    if (s.screen.kind === 'listening' && s.screen.phase !== 'recognizing') {
      const now = Date.now()
      lastChunkAt = now
      if (e.type === 'audio' && e.level >= LINES.SILENCE_LEVEL) lastSoundAt = now
    }
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
      // A double tap may follow — wait out CLICK_DELAY. That is also what makes
      // "double tap on SEND? cancels" true: the second tap kills this callback
      // before any request leaves.
      scheduleClick(() => {
        // SKIP? is a read mark: it must reach Telegram. Viewing a chat is not,
        // and nothing here is called for a plain double tap out of CHAT.
        const skipping = s.screen.kind === 'skipConfirm' ? s.screen : null
        const skipped = skipping
          ? messageIdIn(s, skipping.chatId, skipping.msgIndex)
          : null
        // ux-flow: a tap on an empty CHATS means "check again". With real chats
        // that is a backend round-trip, so the page asks the WebView for it.
        const idle =
          s.telegramConnected && s.screen.kind === 'chats' && visibleChats(s).length === 0
        apply({ type: 'gesture', gesture: 'click' })
        if (skipping && skipped) readHandler?.(skipping.chatId, skipped)
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
      // HEARD promises "swipe ↑ — voice" only when the recording is still in
      // hand. A long text uses the swipe for the firmware's own scroll, which
      // the reducer already knows.
      if (g === 'swipeUp' && s.screen.kind === 'heard') {
        const scrolls =
          s.screen.variant === 'ok' && lineCount(s.screen.text) > LINES.BODY_LINES
        if (!scrolls && target.native && (!lastPcm || lastPcm.byteLength < 3_200)) {
          console.warn('[teleglass] the swipe was ignored: no recording to send')
          return
        }
      }
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
        // to cancel opening the item. "Just read" is a read mark, so it goes to
        // the backend through the same handler as SKIP?; the reducer only keeps
        // the local read map and moves the screen.
        scheduleClick(() => {
          const scr = s.screen
          const chat = scr.kind === 'replies' ? chatById(s, scr.chatId) : null
          const msg =
            scr.kind === 'replies' && chat ? unreadMsgs(chat, s.read)[scr.msgIndex] : undefined
          // The host sometimes reports no index (the reducer then uses the
          // mirrored selection); the read mark must follow the same row.
          const index = scr.kind === 'replies' ? (e.index >= 0 ? e.index : scr.sel) : -1
          const action = msg ? replyActionOf(msg, index) : null
          const messageId = msg ? anchorId(msg) : ''
          apply(e)
          if (scr.kind === 'replies' && action?.kind === 'read' && messageId) {
            readHandler?.(scr.chatId, messageId)
          }
        })
        return
      case 'audio':
        applyAudio(e)
        return
      case 'foreground':
        apply(e)
        // Audio capture stops while the WebView is suspended
        // (background-lifecycle.md): ask for the glasses microphone again, but
        // not while the page is waiting for whisper with the mic closed.
        if (s.screen.kind === 'listening' && s.screen.phase !== 'recognizing') void openMic()
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

  /** The send is over. The answer names its attempt; a stale one is ignored. */
  function applySend(result: {
    chatId: string
    messageId: string
    ok: boolean
    at?: string
    gone?: boolean
  }): void {
    sendsInFlight.delete(`${result.chatId}#${result.messageId}`)
    publish(reduce(s, { type: 'sendResult', ...result }))
  }

  /**
   * The read mark did not reach Telegram: that message is still unread there.
   * Hiding it here would make the glasses' counter disagree with the phone.
   */
  function applyUnread(chatId: string, messageId?: string): void {
    publish(reduce(s, { type: 'unread', chatId, messageId }))
  }

  function onSend(
    cb: ((chatId: string, messageId: string, text: string, mode: 'reply' | 'quick') => void) | null,
  ): void {
    sendHandler = cb
    // A handler that arrives while SENDING is already on screen still gets the
    // message: the first frame must not wait for the next tap.
    if (cb !== null) maybeRequestSend()
  }

  function onMark(cb: ((chatId: string, messageId: string) => void) | null): void {
    readHandler = cb
  }

  function onTranscript(cb: ((chatId: string, attempt: number, pcm: Uint8Array) => void) | null): void {
    transcriptHandler = cb
    // The recording may already be on screen waiting (the handler arrived late).
    if (cb !== null && s.screen.kind === 'listening' && s.screen.phase === 'recognizing') {
      if (lastPcm) cb(s.screen.chatId, s.screen.startAt, lastPcm)
    }
  }

  function applyTranscript(
    chatId: string,
    attempt: number,
    result: { ok: boolean; text: string },
  ): void {
    publish(
      reduce(s, {
        type: 'heardResult',
        chatId,
        attempt,
        ok: result.ok,
        text: result.text,
      }),
    )
  }

  function onIncomingTranscript(
    cb: ((chatId: string, messageId: string) => void) | null,
  ): void {
    incomingTranscriptHandler = cb
    if (cb !== null) maybeRequestIncomingTranscript()
  }

  function applyIncomingTranscript(
    chatId: string,
    messageId: string,
    result: { ok: boolean; text: string },
  ): void {
    transcriptsInFlight.delete(`${chatId}#${messageId}`)
    publish(reduce(s, { type: 'incomingTranscript', chatId, messageId, ...result }))
  }

  function onSendVoice(
    cb: ((chatId: string, messageId: string, pcm: Uint8Array) => void) | null,
  ): void {
    voiceHandler = cb
    if (cb !== null) maybeRequestVoice()
  }

  /**
   * The 2 s silence rule (task v0.7 §6): recording stops when the wearer stops
   * talking, not only when the finger lifts. A missing PCM stream counts as
   * silence too — a dead capture must not record until the cap.
   */
  function checkSilence(): void {
    if (s.screen.kind !== 'listening' || !target.native) return
    // Whisper owns the screen now; the microphone is already closed.
    if (s.screen.phase === 'recognizing') return
    // A dictated reply ends on a pause: the thought is over. A voice note ends
    // when the finger says so — a pause inside a spoken message is not its end.
    if (s.screen.outcome === 'voice') return
    const started = s.screen.startAt
    const last = Math.max(started, lastChunkAt, lastSoundAt)
    if (Date.now() - last < LINES.SILENCE_MS) return
    console.warn('[teleglass] silence for', LINES.SILENCE_MS, 'ms — stopping the recording')
    apply({
      type: 'gesture',
      gesture: s.screen.mode === 'hold' ? 'longPressRelease' : 'click',
    })
  }

  // First screen and ticks. StrictMode mounts components twice —
  // createPage is called once per page (see App.tsx).
  requestRender()
  window.setInterval(() => {
    apply({ type: 'tick', now: Date.now() })
    checkSilence()
  }, TICK_MS)

  return {
    dispatch,
    gesture,
    applySettings,
    applyChats,
    onRefresh,
    onReplies,
    applyReplies,
    onSend,
    applySend,
    applyUnread,
    onMark,
    onTranscript,
    applyTranscript,
    onIncomingTranscript,
    applyIncomingTranscript,
    onSendVoice,
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
