/**
 * What the HTTP layer needs from the Telegram side. Kept as an interface so the
 * routes can be tested without a network, and so `tg/service.ts` is the only
 * file that knows about teleproto.
 */

import type {
  AuthState,
  ChatSummary,
  Health,
  LinkState,
  MessageSummary,
  SettingsPayload,
} from './contract.js'

export interface AuthService {
  /** Drops pending logins left by a previous process; called once at startup. */
  boot(): void

  health(): Promise<Health>

  /** Current step. A missing or unknown token is `idle`, never 401. */
  state(token: string | null): Promise<AuthState>

  sendCode(phone: string): Promise<AuthState>
  verifyCode(phone: string, code: string): Promise<AuthState>
  verifyPassword(password: string): Promise<AuthState>

  startLink(): Promise<AuthState>
  /** Polled by the link screen; carries the token once the link is confirmed. */
  linkState(token: string | null): Promise<LinkState>

  logout(token: string | null): Promise<void>
  /** Session, pending login, settings, LLM key — everything. */
  deleteAll(token: string | null): Promise<void>

  chats(token: string | null): Promise<ChatSummary[]>
  /**
   * The last messages of one dialog, oldest first — the CHAT screen pages from
   * the top. Without an access hash in the request the service resolves the
   * peer from its own cache (filled by `chats`).
   */
  messages(token: string | null, chatId: string, limit?: number): Promise<MessageSummary[]>

  putSettings(token: string | null, payload: SettingsPayload): Promise<void>
  setLlmKey(token: string | null, apiKey: string): Promise<void>

  stop(): Promise<void>
}
