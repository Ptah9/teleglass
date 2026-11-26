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
  /** Context menu item (v0.1 demo levers: language, backend, microphone, Telegram). */
  | { type: 'menu'; item: number }
  /**
   * Microphone level 0…1 from one SDK audio chunk, while LISTENING is open.
   * The source is decided by the page (lever, refusal, 2 s of silence) and
   * reported by `micSource`: one owner for the microphone state machine.
   */
  | { type: 'audio'; level: number }
  /** The page switched the microphone; LISTENING shows which one is live. */
  | { type: 'micSource'; source: AudioSource }
  /**
   * The page came back to the foreground (docs: background-lifecycle.md).
   * Audio capture stops while the WebView is suspended, so it is re-armed here.
   */
  | { type: 'foreground' }
  /**
   * Real chats from the backend (the WebView fetched them, the page cannot).
   * `demo` is the mock set; `loading`/`error` clear the list instead of faking it.
   * `merge` keeps chats that this (incomplete) snapshot did not carry.
   */
  | { type: 'feed'; status: FeedStatus; chats: MockChat[] | null; merge?: boolean }
  /**
   * The WebView fetched reply options for one message. `null`-ish (`ok: false`)
   * is an honest failure: the message keeps an empty list and REPLIES says so.
   */
  | {
      type: 'llmReplies'
      chatId: string
      messageId: string
      ok: boolean
      summary: string
      replies: string[]
    }
  | { type: 'tick'; now: number }

/** Message from Telegram. A mock in v0.1; the summary field appears when the text is long. */
export interface MockMessage {
  id: string
  at: string
  text: string
  /** If the text does not fit into the CHAT body, CHAT shows the summary. */
  summary?: string
  /** Empty array = NO REPLIES screen. */
  replies: string[]
  /** Telegram's own id inside the chat; absent for demo messages. */
  remoteId?: string
  /** The LLM already answered (possibly with nothing). `true` = no retry loop. */
  repliesReady?: boolean
}

export interface MockChat {
  id: string
  person: string
  project?: string
  messages: MockMessage[]
}

export type AudioSource = 'glasses' | 'phone'

/**
 * Where the chat list came from. `demo` is the labelled demo set, `loading` and
 * `error` are the honest "not in Telegram yet" states — a connected account must
 * never show mock chats while the real list is missing.
 */
export type FeedStatus = 'demo' | 'loading' | 'ready' | 'error'

/** HEARD states: recognized text, "did not catch it", "phone microphone". */
export type HeardVariant = 'ok' | 'error' | 'phoneMic'

export type Screen =
  | { kind: 'chats' }
  | { kind: 'chat'; chatId: string; msgIndex: number }
  /** Entered a chat with nothing unread (ux-flow «Пустой чат и пустой список»). */
  | { kind: 'chatEmpty'; chatId: string }
  | { kind: 'fulltext'; chatId: string; msgIndex: number }
  | { kind: 'replies'; chatId: string; msgIndex: number; sel: number }
  /** Waiting for the LLM: three skeleton lines, not an empty screen. */
  | { kind: 'repliesLoading'; chatId: string; msgIndex: number }
  | { kind: 'repliesEmpty'; chatId: string; msgIndex: number }
  | {
      kind: 'confirm'
      chatId: string
      msgIndex: number
      reply: string
      /** "No" goes back where the reply came from: the options or the transcript. */
      from: 'replies' | 'heard'
      /** Which HEARD the transcript came from, so "no" restores the same caption. */
      heardVariant?: 'ok' | 'phoneMic'
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
      /** Which microphone records right now; the phone one is the fallback. */
      source: AudioSource
      startAt: number
      /** Recent microphone levels (0…1), one per SDK audio chunk (100 ms). */
      levels: number[]
    }
  | {
      kind: 'heard'
      chatId: string
      msgIndex: number
      variant: HeardVariant
      text: string
    }

export interface AppState {
  lang: Lang
  screen: Screen
  chats: MockChat[]
  /** Where `chats` came from; the CHATS screen keys its loading/error text off it. */
  feedStatus: FeedStatus
  /** ids of read messages. Unread = everything else. */
  read: Record<string, true>
  /**
   * Selected chat in CHATS. The firmware moves the list highlight silently —
   * no event arrives per step, so we keep our own copy and sync it from the
   * events that do arrive.
   */
  selChat: number
  quickReplyText: string
  /**
   * Chats the phone allowed the glasses to show (T1 `Save`). `null` = every chat.
   * The filter belongs to the model, not to the screen: the list, the quick
   * reply and the paging all read the same subset.
   */
  selectedChats: string[] | null
  /** Demo lever: "backend not responding". Toggled from the context menu. */
  backendDown: boolean
  /** Demo lever: force the phone microphone instead of the glasses one. */
  phoneMic: boolean
  /**
   * Telegram account link state. The setup screen appears when it is false
   * (ux-flow.md inventory: «CHATS — Telegram не подключён»); in v0.1 it is a
   * demo lever, in the real app the backend reports it.
   */
  telegramConnected: boolean
  /**
   * Demo lever for the race ux-flow.md describes: the phone marked the selected
   * chat read while the glasses list still shows it. The next tap on that chat
   * lands on CHAT with nothing unread.
   */
  phoneRead: string | null
  /**
   * The backend has an LLM key (from T3 or `.env`). Without it REPLIES goes
   * straight to "LLM not configured" and no request is made.
   */
  llmConfigured: boolean
  lastChecked: string
  /**
   * Flashing CHATS footer line: `sent · X` for 2 seconds,
   * `not sent · hold to retry` for NOT_SENT_MS (both arrive as a deadline).
   */
  flash: { key: 'sent' | 'notSent'; person: string; chatId: string; until: number } | null
  /** chatId whose CHATS row currently shows sending… */
  sendingRow: string | null
  /** Queue of "new" messages for the "check again" gesture on an empty CHATS. */
  inboxQueue: { chatId: string; message: MockMessage }[]
}
