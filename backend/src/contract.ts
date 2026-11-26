/**
 * The wire contract. It mirrors `app/src/api/types.ts` (owned by the WebView)
 * field for field; the backend never adds a field the phone would have to know
 * about, and never invents a new error code.
 *
 * Keep this file types-only apart from `ContractError`: it is the one place the
 * HTTP layer and the Telegram layer agree on shapes.
 */

export type AuthStep = 'idle' | 'code' | 'password' | 'link' | 'connected'

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

/** `types.ts` `AuthState`. `token` travels only when a login just completed. */
export type AuthState =
  | { step: 'idle' }
  | { step: 'code'; phone: string; resendAt: number }
  | { step: 'password'; phone: string }
  | { step: 'link'; url: string; expiresAt: number }
  | { step: 'connected'; token?: string }

export interface Health {
  backend: 'ok' | 'off' | 'error' | 'demo'
  llm: 'ok' | 'off' | 'error' | 'demo'
  /** ISO timestamp of the check. */
  checkedAt: string
}

export interface ChatSummary {
  id: string
  title: string
  preview: string
  /** Unread messages in the dialog. Additive: older clients ignore it. */
  unread: number
}

/**
 * One message for the glasses. `text` keeps the author's line breaks (the FULL
 * TEXT screen scrolls it) and media becomes a word (`Photo`, `Voice message`) —
 * the row preview, not this field, is flattened to one line.
 */
export interface MessageSummary {
  id: string
  /** ISO datetime; the page formats it per language in `view/stamp.ts`. */
  at: string
  text: string
  /** Sent by this account. The glasses only show incoming unread messages. */
  out: boolean
  /**
   * `text` is a media word (`Photo`, `Voice message`), not the author's text.
   * The LLM language rule needs it: a media word is not a language.
   */
  media?: boolean
}

/** What the LLM returns for one message (v0.5). */
export interface LlmReply {
  /** ≤ 90 chars, word boundary; empty for a message that fits the CHAT body. */
  summary: string
  /** Exactly three options, each ≤ 120 chars, no numbering. */
  replies: string[]
}

export interface LlmModelInfo {
  id: string
  label: string
}

export interface LlmModels {
  models: LlmModelInfo[]
  current: string
}

export interface SettingsPayload {
  lang: string
  quickReply: string
  tone: string
  selectedChats: string[] | null
  llmModel: string
}

export interface LinkState {
  status: 'pending' | 'connected' | 'expired'
  /** Issued once when the confirmation lands, so the WebView can keep it. */
  token?: string
}

/**
 * A failure the phone can name. `status` is picked here, not by `Error`
 * guessing: the WebView only looks at `error` in the body.
 */
export class ContractError extends Error {
  readonly code: AuthErrorCode
  readonly status: number

  constructor(code: AuthErrorCode, status = 400) {
    super(code)
    this.name = 'ContractError'
    this.code = code
    this.status = status
  }
}

export function isAuthErrorCode(value: unknown): value is AuthErrorCode {
  return (
    value === 'wrongCode' ||
    value === 'expiredCode' ||
    value === 'tooMany' ||
    value === 'wrongPassword' ||
    value === 'network' ||
    value === 'linkExpired' ||
    value === 'llm' ||
    value === 'send' ||
    value === 'unknown'
  )
}
