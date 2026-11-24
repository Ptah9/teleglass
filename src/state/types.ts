/**
 * App state and events. Nothing here is about the SDK:
 * the logic does not know where events come from or where the picture goes.
 *
 * Screens mirror the ux-flow.md map one to one; every state is reachable
 * on mock data, including service ones (NO REPLIES, HEARD "did not catch it", etc.).
 */

export type Lang = 'en' | 'ru'

/**
 * Gestures as the logic sees them.
 * On the glasses an up/down swipe arrives as SCROLL_TOP_EVENT / SCROLL_BOTTOM_EVENT —
 * the only "swipe" events the firmware provides.
 */
export type Gesture =
  | 'click'
  | 'doubleClick'
  | 'swipeUp'
  | 'swipeDown'
  | 'longPress'
  | 'longPressRelease'

export type AppEvent =
  | { type: 'gesture'; gesture: Gesture }
  /** The firmware moved the list highlight (or we emulate it in the browser). */
  | { type: 'listSelect'; index: number }
  /** Tap on a list item; index = -1 when the index did not arrive (simulator quirk). */
  | { type: 'listClick'; index: number }
  /** Context menu item (v0.1 demo levers: language, backend, microphone). */
  | { type: 'menu'; item: number }
  /** Microphone level 0…1 from one SDK audio chunk, while LISTENING is open. */
  | { type: 'audio'; level: number }
  | { type: 'tick'; now: number }

/** Message from Telegram. A mock in v0.1; the summary field appears when the text is long. */
export interface MockMessage {
  id: string
  at: string
  text: string
  /** If the text does not fit into 6 lines, CHAT shows the summary. */
  summary?: string
  /** Empty array = NO REPLIES screen. */
  replies: string[]
}

export interface MockChat {
  id: string
  person: string
  project?: string
  messages: MockMessage[]
}

export type AudioSource = 'glasses' | 'phone'

export type Screen =
  | { kind: 'chats' }
  | { kind: 'chat'; chatId: string; msgIndex: number }
  /** Entered a chat with nothing unread (ux-flow «Пустой чат и пустой список»). */
  | { kind: 'chatEmpty'; chatId: string }
  | { kind: 'fulltext'; chatId: string; msgIndex: number }
  | { kind: 'replies'; chatId: string; msgIndex: number; sel: number }
  | { kind: 'repliesEmpty'; chatId: string; msgIndex: number }
  | {
      kind: 'confirm'
      chatId: string
      msgIndex: number
      reply: string
      /** "No" goes back where the reply came from: the options or the transcript. */
      from: 'replies' | 'heard'
    }
  | { kind: 'quickConfirm'; chatId: string }
  | {
      kind: 'skipConfirm'
      chatId: string
      msgIndex: number
      /** Where we came from: "no" returns there (ux-flow § Подтверждения). */
      from: 'chat' | 'fulltext'
    }
  | {
      kind: 'sending'
      chatId: string
      /** The answered message. Absent for the QUICK REPLY draft (whole chat). */
      msgIndex?: number
      reply: string
      mode: 'reply' | 'quick'
      startAt: number
    }
  | { kind: 'sent'; chatId: string; reply: string; at: string }
  | { kind: 'offline'; chatId: string; msgIndex?: number; reply: string }
  | {
      kind: 'listening'
      chatId: string
      msgIndex: number
      mode: 'hold' | 'tap'
      startAt: number
      /** Recent microphone levels (0…1), one per SDK audio chunk (100 ms). */
      levels: number[]
    }
  | {
      kind: 'heard'
      chatId: string
      msgIndex: number
      variant: 'ok' | 'error' | 'phoneMic'
      text: string
    }

export interface AppState {
  lang: Lang
  screen: Screen
  chats: MockChat[]
  /** ids of read messages. Unread = everything else. */
  read: Record<string, true>
  /**
   * Selected chat in CHATS. The firmware moves the list highlight silently —
   * no event arrives per step, so we keep our own copy and sync it from the
   * events that do arrive.
   */
  selChat: number
  quickReplyText: string
  /** Demo lever: "backend not responding". Toggled from the context menu. */
  backendDown: boolean
  /** Demo lever: HEARD "phone microphone" variant. */
  phoneMic: boolean
  lastChecked: string
  /**
   * Flashing CHATS footer line: `sent · X` for 2 seconds,
   * `not sent · hold to retry` — until the send is retried (until = 0).
   */
  flash: { key: 'sent' | 'notSent'; person: string; chatId: string; until: number } | null
  /** chatId whose CHATS row currently shows sending… */
  sendingRow: string | null
  /** Queue of "new" messages for the "check again" gesture on an empty CHATS. */
  inboxQueue: { chatId: string; message: MockMessage }[]
}
