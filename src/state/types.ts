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
  /** Microphone level 0…1 from one SDK audio chunk, while LISTENING is open. */
  | { type: 'audio'; level: number }
  /** The page came back to the foreground (docs: background-lifecycle.md).
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
  /**
   * The WebView finished a real send. The page cannot fetch, so the answer — or
   * the failure — arrives as an event and resolves the SENDING screen. The
   * attempt is named by `chatId#messageId`: a late answer for an older attempt
   * must never put its receipt on a newer one. `at` is Telegram's time for SENT;
   * `ok: false` becomes OFFLINE, never a fake SENT.
   */
  | {
      type: 'sendResult'
      chatId: string
      messageId: string
      ok: boolean
      at?: string
      /** The message is gone (`404`/`400`): retrying cannot help, so not OFFLINE. */
      gone?: boolean
    }
  /**
   * The voice recording turned out to be empty (the microphone answered but no
   * PCM arrived). Nothing was uploaded: SENDING goes back to the options.
   */
  | { type: 'voiceEmpty' }
  /**
   * A read mark did not reach Telegram (network, 502): the message is still
   * unread there, so the glasses must stop hiding it. With `messageId`, only
   * what that mark would have covered is brought back.
   */
  | { type: 'unread'; chatId: string; messageId?: string }
  /**
   * The recognizer answered (or refused) the recording made for HEARD. `attempt`
   * is the recording's start time: a late answer for an older attempt must not
   * replace the text of a newer one.
   */
  | {
      type: 'heardResult'
      chatId: string
      attempt: number
      ok: boolean
      text: string
    }
  /** A transcript arrived for an incoming voice message of the feed. */
  | { type: 'incomingTranscript'; chatId: string; messageId: string; ok: boolean; text: string }
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
  /** A voice note: the page asks the backend for its transcript once. */
  voice?: boolean
  /** One transcript attempt is over (success or failure); do not ask again. */
  transcript?: 'done' | 'failed'
}

export interface MockChat {
  id: string
  person: string
  project?: string
  messages: MockMessage[]
}

/**
 * Where the chat list came from. `demo` is the labelled demo set, `loading` and
 * `error` are the honest "not in Telegram yet" states — a connected account must
 * never show mock chats while the real list is missing.
 */
export type FeedStatus = 'demo' | 'loading' | 'ready' | 'error'

/**
 * HEARD variants: recognized text and "did not catch it". The moment between
 * the recording and the text lives on LISTENING (`phase: 'recognizing'`), so
 * the screen never goes blank. The phone microphone is never used
 * (Антон, 27.11): there is no `phoneMic` state any more.
 */
export type HeardVariant = 'ok' | 'error'

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
      /**
       * Telegram id of the anchor, taken once at the tap. Every retry of this
       * attempt sends the same pair, so `random_id` (and the dedupe) holds even
       * if the feed under the screen has changed.
       */
      messageId: string
      reply: string
      /** `voice` sends the recording from HEARD as a voice note, no text. */
      mode: 'reply' | 'quick' | 'voice'
      startAt: number
    }
  | {
      kind: 'sent'
      chatId: string
      reply: string
      at: string
      person?: string
      /** The receipt is for a voice note: the body is a word, not the text. */
      voice?: boolean
    }
  | {
      kind: 'offline'
      chatId: string
      msgIndex?: number
      /** The same anchor the failed attempt used: the retry must not pick a new one. */
      messageId: string
      reply: string
      /** A failed voice note retries the same recording, not an empty text. */
      mode: 'reply' | 'voice'
    }
  | {
      kind: 'listening'
      chatId: string
      msgIndex: number
      mode: 'hold' | 'tap'
      /**
       * What the recording is for: a dictated reply (`text`, recognized and sent
       * through SEND?) or a Telegram voice note (`voice`, sent as recorded, no
       * recognition). Two entries in REPLIES map to these outcomes.
       */
      outcome: 'text' | 'voice'
      startAt: number
      /** Recent microphone levels (0…1), one per SDK audio chunk (100 ms). */
      levels: number[]
      /**
       * Set when dictation stopped and whisper is working. The microphone is
       * closed, the footer says "recognizing…", and no gesture does anything
       * until the text (or its absence) arrives (task v0.7 §6).
       */
      phase?: 'recognizing'
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
   * `messageId` is the anchor the failed quick reply used: the retry must keep
   * it, otherwise a feed refresh would change `random_id` and send a duplicate.
   */
  flash: {
    key: 'sent' | 'notSent'
    person: string
    chatId: string
    messageId?: string
    until: number
  } | null
  /** chatId whose CHATS row currently shows sending… */
  sendingRow: string | null
  /** Queue of "new" messages for the "check again" gesture on an empty CHATS. */
  inboxQueue: { chatId: string; message: MockMessage }[]
}
