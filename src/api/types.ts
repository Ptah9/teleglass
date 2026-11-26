/**
 * Contract with the backend. The backend is a separate service (MTProto through
 * GramJS, HTTP API over HTTPS, SQLite). The WebView never talks to Telegram
 * itself and never holds api_id/api_hash, the Telegram session or LLM keys.
 *
 * Endpoints and payloads are listed in README.md § API; both implementations
 * (`client.ts` for the real backend, `demo.ts` for the in-app demo) follow this
 * file. Changing a shape here means the backend has to change with it.
 */

/** Where a step lives. `connected` is the only state that unlocks the tabs. */
export type AuthState =
  | { step: 'idle' }
  | { step: 'code'; phone: string; resendAt: number }
  | { step: 'password'; phone: string }
  | { step: 'link'; url: string; expiresAt: number }
  | { step: 'connected' }

export type AuthErrorCode =
  | 'wrongCode'
  | 'expiredCode'
  | 'tooMany'
  | 'wrongPassword'
  | 'network'
  | 'linkExpired'
  | 'llm'
  | 'send'
  | 'unknown'

/** An error the WebView can name on the screen, not a stack trace. */
export class AuthError extends Error {
  readonly code: AuthErrorCode
  /** HTTP status when the backend answered; absent for network and demo. */
  readonly status?: number

  constructor(code: AuthErrorCode, message?: string, status?: number) {
    super(message ?? code)
    this.name = 'AuthError'
    this.code = code
    this.status = status
  }
}

export type StatusLevel = 'ok' | 'off' | 'error' | 'demo'

export interface Health {
  backend: StatusLevel
  llm: StatusLevel
  /** ISO timestamp of the check. Telegram is derived from the settings, not here. */
  checkedAt: string
}

export interface ChatSummary {
  id: string
  /** `Ivan · Project` / `Mom` — already the label, no UI formatting on the phone. */
  title: string
  /** Last message, one line, as it arrives from Telegram (data, not a string). */
  preview: string
  /** Unread messages, when the backend knows them (real Telegram, not the demo). */
  unread?: number
}

/** One message of a dialog, ready for the glasses page. */
export interface MessageSummary {
  id: string
  /** ISO datetime; the page formats it per language (`view/stamp.ts`). */
  at: string
  /** The text itself (author line breaks kept) or a media word (`Photo`). */
  text: string
  /** Sent by this account; the glasses only present incoming messages. */
  out: boolean
  /** `text` is a media word, not the author's letters (the LLM language rule). */
  media?: boolean
}

/** What the LLM returns for one message. */
export interface LlmReply {
  /** ≤ 90 characters; empty for a message that fits the CHAT body. */
  summary: string
  /** Exactly three options, each ≤ 120 characters. */
  replies: string[]
}

export interface LlmModelInfo {
  id: string
  label: string
}

export interface LlmModels {
  models: LlmModelInfo[]
  /** The model the backend would use now (the phone's choice if it is known). */
  current: string
}

export interface Api {
  /** Where the settings screen takes Backend and LLM from. */
  health(): Promise<Health>
  /** Restores the step after the WebView was unloaded (link login, code step). */
  auth(): Promise<AuthState>
  /** `network` fails with AuthError('network'). */
  sendCode(phone: string): Promise<AuthState>
  verifyCode(phone: string, code: string): Promise<AuthState>
  verifyPassword(password: string): Promise<AuthState>
  /** A fresh one-time link; it lives ~30 s and is single-use. */
  startLink(): Promise<Extract<AuthState, { step: 'link' }>>
  /** The screen polls this while waiting for the confirmation in Telegram. */
  linkState(): Promise<'pending' | 'connected' | 'expired'>
  logout(): Promise<void>
  /** Removes the saved Telegram session and every stored setting on the server. */
  deleteAll(): Promise<void>
  /** Chats offered for selection in T1. */
  chats(): Promise<ChatSummary[]>
  /**
   * The newest messages of the dialog's unread window, oldest first. The glasses
   * show the last `unread` incoming ones, so the WebView trims here instead of
   * asking the backend for a per-device count.
   */
  messages(chatId: string): Promise<MessageSummary[]>
  /** Mirrors the phone settings to the backend so the glasses can read them. */
  putSettings(payload: {
    lang: string
    quickReply: string
    tone: string
    selectedChats: string[] | null
    llmModel: string
  }): Promise<void>
  /**
   * Sends the LLM API key to the backend, which is the only place it is kept.
   * The WebView never stores it: the field is cleared after this call.
   */
  setLlmKey(apiKey: string): Promise<void>
  /**
   * Three reply options and a summary for one message. A failure is an honest
   * `llm` error: the glasses show NO REPLIES instead of invented text.
   */
  replies(chatId: string, messageId: string): Promise<LlmReply>
  /** Models advertised by the backend; `current` is what it would use now. */
  llmModels(): Promise<LlmModels>
  /**
   * Sends `text` into the dialog as this account. `messageId` is the message
   * being answered and anchors Telegram's `random_id`, so a retry after a
   * timeout does not produce a second message. Any failure is an honest `send`
   * error (or `network`/`unknown` for auth); the glasses show OFFLINE.
   */
  sendReply(chatId: string, messageId: string, text: string): Promise<{ id: string; at: string }>
  /** Marks one message (and everything older) read on the server side. */
  markRead(chatId: string, messageId: string): Promise<void>
  /** Marks the whole dialog read — the QUICK REPLY draft answers every unread. */
  markChatRead(chatId: string): Promise<void>
  /** true — the demo implementation is in use (no backend answered). */
  readonly demo: boolean
}
