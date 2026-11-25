import {
  MOCK_CHATS,
  MOCK_HEARD_LONG,
  MOCK_HEARD_TEXT,
  MOCK_INBOX,
  MOCK_QUICK_REPLY,
} from './data'
import type { AppEvent, AppState, AudioSource, Gesture, MockChat, MockMessage } from './types'
import { lineCount } from './wrap'
import * as LINES from './limits'
/**
 * Reducer: all transition logic, verbatim from the ux-flow.md gesture table.
 *
 * The module cannot be fully pure: timers (sending, listening, the "sent · X"
 * flash) take time from Date.now() right here. For a mock app this is cheaper
 * than threading now through every event; once the backend is connected, its
 * responses will supply the time and this will go away.
 *
 * Invariant for the orchestrator: when a transition changes nothing, the SAME
 * object is returned — the page sees the reference and knows there is nothing
 * to draw.
 */

/** How many body lines fit on CHAT (shared with the view). */
const BODY_LINES = LINES.BODY_LINES
/** Indicator columns kept in state (shared with the view). */
const WAVE_LEN = LINES.WAVE_LEN
/** Mock "sending to Telegram" delay. */
const SEND_MS = 1500
/** A recording shorter than 0.8 s counts as failed (demo rule for HEARD "did not catch it"). */
const MIN_RECORD_MS = 800
/**
 * Demo rule for the scroll: a hold longer than 4 s returns a long transcript,
 * so the scrolling HEARD screen is reachable without real STT.
 */
const LONG_RECORD_MS = 4000

export function initialState(): AppState {
  return {
    lang: 'en',
    screen: { kind: 'chats' },
    chats: MOCK_CHATS,
    read: {},
    selChat: 0,
    quickReplyText: MOCK_QUICK_REPLY,
    backendDown: false,
    phoneMic: false,
    telegramConnected: true,
    phoneRead: null,
    lastChecked: '19:42',
    flash: null,
    sendingRow: null,
    inboxQueue: MOCK_INBOX.map((x) => ({ chatId: x.chatId, message: { ...x.message } })),
  }
}

// ---------------------------------------------------------------------------
// Model: read only through these functions, so the "read" semantics
// is written in one place (ux-flow.md «Что происходит с сообщением»).
// ---------------------------------------------------------------------------

export function chatById(s: AppState, id: string): MockChat | undefined {
  return s.chats.find((c) => c.id === id)
}

export function unreadMsgs(chat: MockChat, read: Record<string, true>): MockMessage[] {
  return chat.messages.filter((m) => !read[m.id])
}

export function visibleChats(s: AppState): MockChat[] {
  return s.chats.filter((c) => unreadMsgs(c, s.read).length > 0)
}

/** 'Ivan · Project' / 'Mom' — as in the screen body (to Ivan · Project). */
export function chatLabel(chat: MockChat): string {
  return chat.project ? `${chat.person} · ${chat.project}` : chat.person
}

export function timeStr(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function markAllRead(s: AppState, chatId: string): Record<string, true> {
  const chat = chatById(s, chatId)
  if (!chat) return s.read
  const read = { ...s.read }
  for (const m of chat.messages) read[m.id] = true
  return read
}

/** Telegram marks the answered message read — the rest of the chat stays unread. */
function markMessageRead(s: AppState, chatId: string, msgIndex: number): Record<string, true> {
  const chat = chatById(s, chatId)
  if (!chat) return s.read
  const msg = unreadMsgs(chat, s.read)[msgIndex]
  if (!msg) return s.read
  return { ...s.read, [msg.id]: true }
}

function isLongMessage(msg: MockMessage): boolean {
  // Length only: a summary may be missing (LLM not ready, chat without summaries),
  // and the full text must stay reachable anyway.
  return lineCount(msg.text) > BODY_LINES
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export function reduce(s: AppState, e: AppEvent): AppState {
  switch (e.type) {
    case 'gesture':
      return onGesture(s, e.gesture)
    case 'listSelect':
      return onListSelect(s, e.index)
    case 'listClick':
      return onListClick(s, e.index)
    case 'menu':
      return onMenu(s, e.item)
    case 'audio':
      return onAudio(s, e.level)
    case 'micSource':
      return onMicSource(s, e.source)
    case 'foreground':
      // Re-arming the microphone is a page duty (it owns the SDK calls); the
      // logic has nothing to change, the screen stays as it was.
      return s
    case 'tick':
      return onTick(s, e.now)
  }
}

function onGesture(s: AppState, g: Gesture): AppState {
  switch (s.screen.kind) {
    case 'chats':
      return onChats(s, g)
    case 'chat':
      return onChat(s, g)
    case 'chatEmpty':
      // ux-flow: double tap back only.
      return g === 'doubleClick' ? chatsScreen(s) : s
    case 'fulltext':
      return onFulltext(s, g)
    case 'replies':
      return onReplies(s, g)
    case 'repliesEmpty':
      return onRepliesEmpty(s, g)
    case 'confirm':
      return onConfirm(s, g)
    case 'quickConfirm':
      return onQuickConfirm(s, g)
    case 'skipConfirm':
      return onSkipConfirm(s, g)
    case 'sending':
      // Waiting for Telegram's answer, no gestures (ux-flow: footer without actions).
      return s
    case 'sent':
      return g === 'click' || g === 'doubleClick' ? chatsScreen(s) : s
    case 'offline':
      return onOffline(s, g)
    case 'listening':
      return onListening(s, g)
    case 'heard':
      return onHeard(s, g)
  }
}

// ---------------------------------------------------------------------------
// CHATS.
// ---------------------------------------------------------------------------

function chatsScreen(s: AppState): AppState {
  return { ...s, screen: { kind: 'chats' } }
}

function onChats(s: AppState, g: Gesture): AppState {
  // Not linked to Telegram: there is nothing to open and nothing to send —
  // the screen only says what to do on the phone (ux-flow.md inventory).
  if (!s.telegramConnected) return s

  const visible = visibleChats(s)

  switch (g) {
    case 'click': {
      // Empty: tap = "check again" (idle.hint).
      if (visible.length === 0) return checkAgain(s)
      return openChat(s, clampSel(s, visible.length))
    }
    case 'doubleClick':
      // Root page: intercepted in page.ts, which calls
      // shutDownPageContainer(1). The event reaches here only if the bridge
      // stub failed to close the page — then we simply stay put.
      return s
    case 'longPress': {
      // A quick reply is being sent — the gesture is dead (ux-flow: «— (в строке sending…)»).
      if (s.sendingRow !== null) return s
      // It did not go through — holding retries the send (chats.notSent).
      if (s.flash?.key === 'notSent') {
        const chat = chatById(s, s.flash.chatId)
        if (!chat) return { ...s, flash: null }
        return {
          ...s,
          flash: null,
          sendingRow: chat.id,
          screen: {
            kind: 'sending',
            chatId: chat.id,
            reply: s.quickReplyText,
            mode: 'quick',
            startAt: Date.now(),
          },
        }
      }
      // Normal case: quick reply into the selected chat.
      if (visible.length === 0) return s
      const chat = visible[clampSel(s, visible.length)]
      if (!chat) return s
      return { ...s, screen: { kind: 'quickConfirm', chatId: chat.id } }
    }
    case 'swipeUp':
    case 'swipeDown': {
      // The firmware moves the highlight silently; this is an approximate sync
      // of our copy for the cases when the index did not come with the event.
      if (visible.length === 0) return s
      const delta = g === 'swipeUp' ? -1 : 1
      const next = Math.min(Math.max(s.selChat + delta, 0), visible.length - 1)
      return next === s.selChat ? s : { ...s, selChat: next }
    }
    default:
      return s
  }
}

/**
 * Our copy of the native highlight can point past the end after a chat leaves
 * the list; the firmware always has a row selected, so we clamp instead of
 * falling back to the first chat (that sent quick replies to the wrong person).
 */
function clampSel(s: AppState, length: number): number {
  return Math.min(Math.max(s.selChat, 0), length - 1)
}

function checkAgain(s: AppState): AppState {
  const now = timeStr()
  const [head, ...rest] = s.inboxQueue
  if (!head) return { ...s, lastChecked: now }
  const chats = s.chats.map((c) =>
    c.id === head.chatId ? { ...c, messages: [...c.messages, head.message] } : c,
  )
  return { ...s, chats, inboxQueue: rest, lastChecked: now }
}

function openChat(s: AppState, index: number): AppState {
  const visible = visibleChats(s)
  const chat = visible[index]
  if (!chat) return s
  // The phone may have read this chat while the glasses list still showed it.
  // Then the tap lands on a chat with nothing unread — that is the
  // «CHAT — непрочитанных нет» state from the ux-flow inventory.
  if (s.phoneRead === chat.id) {
    return {
      ...s,
      read: markAllRead(s, chat.id),
      phoneRead: null,
      selChat: index,
      screen: { kind: 'chatEmpty', chatId: chat.id },
    }
  }
  const msgs = unreadMsgs(chat, s.read)
  if (msgs.length === 0) {
    return { ...s, selChat: index, screen: { kind: 'chatEmpty', chatId: chat.id } }
  }
  return { ...s, selChat: index, screen: { kind: 'chat', chatId: chat.id, msgIndex: 0 } }
}

// ---------------------------------------------------------------------------
// CHAT and FULL TEXT.
// ---------------------------------------------------------------------------

function onChat(s: AppState, g: Gesture): AppState {
  const scr = s.screen
  if (scr.kind !== 'chat') return s
  const chat = chatById(s, scr.chatId)
  if (!chat) return s
  const msgs = unreadMsgs(chat, s.read)
  const msg = msgs[scr.msgIndex]
  if (msgs.length === 0) return chatsScreen(s)

  switch (g) {
    case 'click':
      return msg ? toReplies(s, scr.chatId, scr.msgIndex) : s
    case 'doubleClick':
      // Back to CHATS, the message stays unread (ux-flow).
      return chatsScreen(s)
    case 'swipeUp': {
      // Cyclic paging: after the first message comes the last.
      const prev = scr.msgIndex <= 0 ? msgs.length - 1 : scr.msgIndex - 1
      return { ...s, screen: { ...scr, msgIndex: prev } }
    }
    case 'swipeDown': {
      // Cyclic paging: after the last comes the first (24.11 fix from testing).
      const next = scr.msgIndex + 1 < msgs.length ? scr.msgIndex + 1 : 0
      return { ...s, screen: { ...scr, msgIndex: next } }
    }
    case 'longPress': {
      if (!msg) return s
      // One gesture, two meanings: long message — full text, short one — skip.
      if (isLongMessage(msg)) {
        return { ...s, screen: { kind: 'fulltext', chatId: scr.chatId, msgIndex: scr.msgIndex } }
      }
      return {
        ...s,
        screen: {
          kind: 'skipConfirm',
          chatId: scr.chatId,
          msgIndex: scr.msgIndex,
          from: 'chat',
        },
      }
    }
    default:
      return s
  }
}

function onFulltext(s: AppState, g: Gesture): AppState {
  const scr = s.screen
  if (scr.kind !== 'fulltext') return s

  // Text overflows the body and the firmware scrolls it natively, so swipes are
  // not ours here. Tap — reply, double tap — back to CHAT, hold — skip.
  switch (g) {
    case 'click':
      return toReplies(s, scr.chatId, scr.msgIndex)
    case 'doubleClick':
      // Back to CHAT, still unread (ux-flow).
      return { ...s, screen: { kind: 'chat', chatId: scr.chatId, msgIndex: scr.msgIndex } }
    case 'longPress':
      return {
        ...s,
        screen: {
          kind: 'skipConfirm',
          chatId: scr.chatId,
          msgIndex: scr.msgIndex,
          from: 'fulltext',
        },
      }
    default:
      return s
  }
}

// ---------------------------------------------------------------------------
// REPLIES.
// ---------------------------------------------------------------------------

function toReplies(s: AppState, chatId: string, msgIndex: number): AppState {
  const chat = chatById(s, chatId)
  if (!chat) return s
  const msg = unreadMsgs(chat, s.read)[msgIndex]
  if (!msg) return s
  if (msg.replies.length === 0) {
    return { ...s, screen: { kind: 'repliesEmpty', chatId, msgIndex } }
  }
  return { ...s, screen: { kind: 'replies', chatId, msgIndex, sel: 0 } }
}

function onReplies(s: AppState, g: Gesture): AppState {
  const scr = s.screen
  if (scr.kind !== 'replies') return s

  switch (g) {
    case 'click':
      // On the glasses a list tap arrives as listClick; this path is the
      // fallback for when the index did not make it (simulator quirk).
      return onListClick(s, scr.sel)
    case 'doubleClick':
      // Back to CHAT, still unread (ux-flow).
      return { ...s, screen: { kind: 'chat', chatId: scr.chatId, msgIndex: scr.msgIndex } }
    case 'longPress':
      // Holding the temple arm starts a voice recording (design-system.md §5.1).
      return {
        ...s,
        screen: {
          kind: 'listening',
          chatId: scr.chatId,
          msgIndex: scr.msgIndex,
          mode: 'hold',
          source: s.phoneMic ? 'phone' : 'glasses',
          startAt: Date.now(),
          levels: [],
        },
      }
    case 'swipeUp':
    case 'swipeDown': {
      // Approximate selection sync (as in CHATS).
      const chat = chatById(s, scr.chatId)
      const msg = chat ? unreadMsgs(chat, s.read)[scr.msgIndex] : undefined
      const n = (msg?.replies.length ?? 0) + 1
      const delta = g === 'swipeUp' ? -1 : 1
      const next = Math.min(Math.max(scr.sel + delta, 0), n - 1)
      return next === scr.sel ? s : { ...s, screen: { ...scr, sel: next } }
    }
    default:
      return s
  }
}

function onRepliesEmpty(s: AppState, g: Gesture): AppState {
  const scr = s.screen
  if (scr.kind !== 'repliesEmpty') return s
  // ux-flow: double tap — back to CHAT; the footer still promises swipe ↑ back.
  // Back to the message we came from, not to the first one in the queue.
  if (g === 'doubleClick' || g === 'swipeUp') {
    return { ...s, screen: { kind: 'chat', chatId: scr.chatId, msgIndex: scr.msgIndex } }
  }
  return s
}

// ---------------------------------------------------------------------------
// Confirmations: SEND?, QUICK REPLY?, SKIP?.
// ---------------------------------------------------------------------------

function onConfirm(s: AppState, g: Gesture): AppState {
  const scr = s.screen
  if (scr.kind !== 'confirm') return s
  switch (g) {
    case 'click':
      return {
        ...s,
        screen: {
          kind: 'sending',
          chatId: scr.chatId,
          msgIndex: scr.msgIndex,
          reply: scr.reply,
          mode: 'reply',
          startAt: Date.now(),
        },
      }
    case 'doubleClick':
    case 'swipeUp':
      // "No" — back where the reply came from: the transcript must not be lost
      // because someone changed their mind on the confirmation.
      if (scr.from === 'heard') {
        return {
          ...s,
          screen: {
            kind: 'heard',
            chatId: scr.chatId,
            msgIndex: scr.msgIndex,
            variant: scr.heardVariant ?? 'ok',
            text: scr.reply,
          },
        }
      }
      return toReplies(s, scr.chatId, scr.msgIndex)
    default:
      return s
  }
}

function onQuickConfirm(s: AppState, g: Gesture): AppState {
  const scr = s.screen
  if (scr.kind !== 'quickConfirm') return s
  switch (g) {
    case 'click':
      return {
        ...s,
        sendingRow: scr.chatId,
        screen: {
          kind: 'sending',
          chatId: scr.chatId,
          reply: s.quickReplyText,
          mode: 'quick',
          startAt: Date.now(),
        },
      }
    case 'doubleClick':
    case 'swipeUp':
      return chatsScreen(s)
    default:
      return s
  }
}

function onSkipConfirm(s: AppState, g: Gesture): AppState {
  const scr = s.screen
  if (scr.kind !== 'skipConfirm') return s
  switch (g) {
    case 'click': {
      // Skip: mark as read and drop from the list. The other messages of the
      // chat are untouched — the chat disappears once the unread pool runs out.
      const chat = chatById(s, scr.chatId)
      const msg = chat ? unreadMsgs(chat, s.read)[scr.msgIndex] : undefined
      if (!msg) return chatsScreen(s)
      return { ...s, read: { ...s.read, [msg.id]: true }, screen: { kind: 'chats' } }
    }
    case 'doubleClick':
    case 'swipeUp':
      // "No" returns where we came from (ux-flow § Подтверждения).
      if (scr.from === 'fulltext') {
        return {
          ...s,
          screen: { kind: 'fulltext', chatId: scr.chatId, msgIndex: scr.msgIndex },
        }
      }
      return { ...s, screen: { kind: 'chat', chatId: scr.chatId, msgIndex: scr.msgIndex } }
    default:
      return s
  }
}

// ---------------------------------------------------------------------------
// Send result: SENT / OFFLINE.
// ---------------------------------------------------------------------------

function onOffline(s: AppState, g: Gesture): AppState {
  const scr = s.screen
  if (scr.kind !== 'offline') return s
  switch (g) {
    case 'click':
      // Tap — retry (error.hint).
      return {
        ...s,
        screen: {
          kind: 'sending',
          chatId: scr.chatId,
          msgIndex: scr.msgIndex,
          reply: scr.reply,
          mode: 'reply',
          startAt: Date.now(),
        },
      }
    case 'swipeDown':
    case 'doubleClick':
      // Swipe ↓ — leave; the table does not describe a double tap, so it goes
      // to the same place.
      return chatsScreen(s)
    default:
      return s
  }
}

// ---------------------------------------------------------------------------
// Voice: LISTENING and HEARD. There is no recognition in v0.1 — the text comes
// from mock constants, and the rules below are honestly demo rules, not STT.
// ---------------------------------------------------------------------------

function onListening(s: AppState, g: Gesture): AppState {
  const scr = s.screen
  if (scr.kind !== 'listening') return s

  switch (g) {
    case 'click':
      // Say it mode: a tap ends the recording. Hold mode: the finger is on the
      // temple arm, a tap never arrives here; ignore it just in case.
      if (scr.mode === 'tap') return stopListening(s)
      return s
    case 'longPressRelease':
      // Hold mode: released — stop and "recognize".
      if (scr.mode === 'hold') return stopListening(s)
      return s
    case 'swipeUp':
      // Cancel without recognition — back to the options (ux-flow).
      return toReplies(s, scr.chatId, scr.msgIndex)
    default:
      return s
  }
}

function stopListening(s: AppState): AppState {
  const scr = s.screen
  if (scr.kind !== 'listening') return s
  const dur = Date.now() - scr.startAt
  const base = { chatId: scr.chatId, msgIndex: scr.msgIndex }

  if (dur < MIN_RECORD_MS) {
    return {
      ...s,
      screen: { kind: 'heard', ...base, variant: 'error', text: '' },
    }
  }
  // Long hold — long transcript; the text itself is shown in full and scrolls.
  // The caption follows the microphone that actually recorded, not the lever.
  return {
    ...s,
    screen: {
      kind: 'heard',
      ...base,
      variant: scr.source === 'phone' ? 'phoneMic' : 'ok',
      text: dur > LONG_RECORD_MS ? MOCK_HEARD_LONG : MOCK_HEARD_TEXT,
    },
  }
}

function onHeard(s: AppState, g: Gesture): AppState {
  const scr = s.screen
  if (scr.kind !== 'heard') return s

  if (scr.variant === 'error') {
    switch (g) {
      case 'click':
        // 24.11 decision: from the error go to REPLIES, not CHAT.
        return toReplies(s, scr.chatId, scr.msgIndex)
      case 'longPress':
        return startListeningAgain(s, 'hold')
      default:
        return s
    }
  }

  // Recognized text: the firmware scrolls the body natively while it overflows,
  // so swipes are not our business here. When the text fits, they do nothing.
  switch (g) {
    case 'click':
      return {
        ...s,
        screen: {
          kind: 'confirm',
          chatId: scr.chatId,
          msgIndex: scr.msgIndex,
          reply: scr.text,
          from: 'heard',
          // Keep the caption: after "no" the transcript returns as it was.
          heardVariant: scr.variant === 'phoneMic' ? 'phoneMic' : 'ok',
        },
      }
    case 'longPress':
      return startListeningAgain(s, 'hold')
    case 'doubleClick':
      // Back to CHAT, still unread (ux-flow: HEARD returns to the message).
      return { ...s, screen: { kind: 'chat', chatId: scr.chatId, msgIndex: scr.msgIndex } }
    default:
      return s
  }
}

function startListeningAgain(s: AppState, mode: 'hold' | 'tap'): AppState {
  const scr = s.screen
  if (scr.kind !== 'heard') return s
  return {
    ...s,
    screen: {
      kind: 'listening',
      chatId: scr.chatId,
      msgIndex: scr.msgIndex,
      mode,
      source: s.phoneMic ? 'phone' : 'glasses',
      startAt: Date.now(),
      levels: [],
    },
  }
}

// ---------------------------------------------------------------------------
// List: firmware events.
// ---------------------------------------------------------------------------

function onListSelect(s: AppState, index: number): AppState {
  if (index < 0) return s
  switch (s.screen.kind) {
    case 'chats': {
      const n = visibleChats(s).length
      if (n === 0) return s
      const next = Math.min(index, n - 1)
      return next === s.selChat ? s : { ...s, selChat: next }
    }
    case 'replies': {
      const scr = s.screen
      const chat = chatById(s, scr.chatId)
      const msg = chat ? unreadMsgs(chat, s.read)[scr.msgIndex] : undefined
      const n = (msg?.replies.length ?? 0) + 1
      const next = Math.min(index, n - 1)
      return next === scr.sel ? s : { ...s, screen: { ...scr, sel: next } }
    }
    default:
      return s
  }
}

function onListClick(s: AppState, index: number): AppState {
  switch (s.screen.kind) {
    case 'chats': {
      const visible = visibleChats(s)
      // Simulator quirk: the index does not arrive for the first item (index 0).
      // Then the tap means the selected chat — but the selection is ours, and it
      // may be left with a big number after the list shrank (reply, skip).
      // So clamp to the bounds, otherwise the tap is silently dropped.
      const raw = index >= 0 ? index : s.selChat
      const i = Math.min(Math.max(raw, 0), visible.length - 1)
      const chat = visible[i]
      if (!chat) return s
      return openChat(s, i)
    }
    case 'replies': {
      const scr = s.screen
      const chat = chatById(s, scr.chatId)
      const msg = chat ? unreadMsgs(chat, s.read)[scr.msgIndex] : undefined
      if (!msg) return s
      const i = index >= 0 ? index : scr.sel
      // Last item is "Say it": tap starts, tap ends (design-system §5.1).
      if (i === msg.replies.length) {
        return {
          ...s,
          screen: {
            kind: 'listening',
            chatId: scr.chatId,
            msgIndex: scr.msgIndex,
            mode: 'tap',
            source: s.phoneMic ? 'phone' : 'glasses',
            startAt: Date.now(),
            levels: [],
          },
        }
      }
      const reply = msg.replies[i]
      if (reply === undefined) return s
      return {
        ...s,
        screen: {
          kind: 'confirm',
          chatId: scr.chatId,
          msgIndex: scr.msgIndex,
          reply,
          from: 'replies',
        },
      }
    }
    default:
      return s
  }
}

// ---------------------------------------------------------------------------
// Context menu (demo levers) and timers.
// ---------------------------------------------------------------------------

function onMenu(s: AppState, item: number): AppState {
  switch (item) {
    case 1:
      return { ...s, lang: s.lang === 'en' ? 'ru' : 'en' }
    case 2:
      return { ...s, backendDown: !s.backendDown }
    case 3:
      return { ...s, phoneMic: !s.phoneMic }
    case 4: {
      // The backend reporting "not linked" takes the glasses back to CHATS:
      // every inner screen belongs to a conversation that cannot be reached.
      const telegramConnected = !s.telegramConnected
      if (telegramConnected) return { ...s, telegramConnected }
      return {
        ...s,
        telegramConnected,
        screen: { kind: 'chats' },
        flash: null,
        sendingRow: null,
      }
    }
    case 5: {
      // "The phone read the selected chat": the list is one tap behind, the
      // tap opens CHAT with nothing unread. Toggling again takes it back.
      const visible = visibleChats(s)
      if (visible.length === 0) return s
      const chat = visible[clampSel(s, visible.length)]
      if (!chat) return s
      return { ...s, phoneRead: s.phoneRead === chat.id ? null : chat.id }
    }
    default:
      return s
  }
}

function onTick(s: AppState, now: number): AppState {
  let next = s

  if (next.screen.kind === 'sending' && now - next.screen.startAt >= SEND_MS) {
    next = resolveSending(next, now)
  }

  // The LISTENING indicator is driven by microphone chunks (`audio` events);
  // the tick only keeps the screen alive and resolves timers.
  if (next.flash && next.flash.until > 0 && now >= next.flash.until) {
    next = { ...next, flash: null }
  }

  return next
}

/** One microphone chunk → one column of the indicator; the window is 26 columns. */
function onAudio(s: AppState, level: number): AppState {
  const scr = s.screen
  if (scr.kind !== 'listening') return s
  const levels = [...scr.levels, Math.min(Math.max(level, 0), 1)]
  if (levels.length > WAVE_LEN) levels.splice(0, levels.length - WAVE_LEN)
  return { ...s, screen: { ...scr, levels } }
}

/**
 * The page switched the microphone (glasses refused, or 2 s without data).
 * LISTENING shows which source is live, and HEARD keeps that caption.
 */
function onMicSource(s: AppState, source: AudioSource): AppState {
  const scr = s.screen
  if (scr.kind !== 'listening' || scr.source === source) return s
  return { ...s, screen: { ...scr, source } }
}

function resolveSending(s: AppState, now: number): AppState {
  const scr = s.screen
  if (scr.kind !== 'sending') return s
  const chat = chatById(s, scr.chatId)
  const person = chat?.person ?? ''

  if (s.backendDown) {
    if (scr.mode === 'reply') {
      return {
        ...s,
        screen: {
          kind: 'offline',
          chatId: scr.chatId,
          msgIndex: scr.msgIndex,
          reply: scr.reply,
        },
      }
    }
    // The quick reply did not go through: the chat stays, the footer shows
    // "not sent · hold to retry" for NOT_SENT_MS — long enough to read and to
    // retry, short enough not to become a permanent screen state.
    return {
      ...s,
      sendingRow: null,
      flash: { key: 'notSent', person, chatId: scr.chatId, until: now + LINES.NOT_SENT_MS },
      screen: { kind: 'chats' },
    }
  }

  // Telegram marks the answered message read, not the whole chat: the other
  // unread messages keep the chat in the list. The QUICK REPLY draft answers
  // the chat as a whole, so it clears every message (ux-flow § Что происходит).
  const read =
    scr.mode === 'quick' || scr.msgIndex === undefined
      ? markAllRead(s, scr.chatId)
      : markMessageRead(s, scr.chatId, scr.msgIndex)

  if (scr.mode === 'reply') {
    return {
      ...s,
      read,
      screen: { kind: 'sent', chatId: scr.chatId, reply: scr.reply, at: timeStr(new Date(now)) },
    }
  }

  return {
    ...s,
    read,
    sendingRow: null,
    flash: { key: 'sent', person, chatId: scr.chatId, until: now + 2000 },
    screen: { kind: 'chats' },
  }
}
