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
  | 'unknown'

/** An error the WebView can name on the screen, not a stack trace. */
export class AuthError extends Error {
  readonly code: AuthErrorCode

  constructor(code: AuthErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'AuthError'
    this.code = code
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
  /** true — the demo implementation is in use (no backend answered). */
  readonly demo: boolean
}
