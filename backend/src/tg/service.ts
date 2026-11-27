/**
 * The login state machine and the only reader of the Telegram session.
 *
 * Invariants from `specs/task-v0.4-telegram.md` §4 live here:
 *
 * - one client per session, kept in `ClientRegistry` between HTTP requests;
 * - a pending login is its own object (phone, phone_code_hash, step, TTL, client)
 *   so 2FA and the second `exportLoginToken` run on the same auth key;
 * - the session string is encrypted with AES-256-GCM before it touches SQLite;
 * - the backend bearer token is a separate thing from the Telegram session;
 * - no automatic retry of `sendCode`/`signIn`: a request that times out leaves
 *   its pending entry in place, so a human retry does not burn another attempt.
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Api, errors, helpers, password as passwordUtils } from 'teleproto'
import { CustomFile } from 'teleproto/client/uploads'
import type { Config } from '../config.js'
import {
  ContractError,
  type AuthState,
  type ChatSummary,
  type Health,
  type LinkState,
  type MessageSummary,
  type SettingsPayload,
} from '../contract.js'
import { decrypt, encrypt } from '../crypto.js'
import { Db, type SessionRow } from '../db.js'
import { maskPhone, stripControl, type Logger } from '../log.js'
import type { AuthService, VoiceAudio, VoiceFile } from '../service.js'
import { raceTimeout } from '../timeout.js'
import { hashToken, newBearerToken } from '../tokens.js'
import { ClientRegistry, type TgClient } from './clients.js'
import { isNetworkError, isSessionDead, loggableError, toContractError } from './errors.js'

/** How long a half-finished login is allowed to wait for the human. */
const PENDING_TTL_MS = 15 * 60_000
/** The link expires in ~30 s; the pending client lives longer to reissue it. */
const LINK_DONE_MS = 2 * 60_000
/** One Telegram call must finish well inside the WebView's 10 s timeout. */
const CALL_MS = 8_000
const CONNECT_MS = 7_000
/**
 * Whole-request budget: connect + one call (plus a DC migration or a dialog
 * lookup where the path needs it). Kept under the WebView's 10 s so a slow
 * Telegram ends as `network` from us, not as an aborted request on the phone.
 */
const REQUEST_BUDGET_MS = 8_500
/**
 * The WebView gives a reply 8 s (`SEND_TIMEOUT_MS`). The backend must answer
 * before that: otherwise a send that did happen is shown as OFFLINE. The retry
 * is deduped, but the first screen should say the truth.
 */
const SEND_BUDGET_MS = 7_500
/**
 * Voice is heavier than text: a download or an upload of a 120 s note needs
 * more than the text budget. The WebView waits 43 s for a transcript and 21 s
 * for a voice send, both above these budgets.
 */
const VOICE_BUDGET_MS = 12_000
/** Recognizing an incoming note also waits for this download; it is small. */
const VOICE_DOWNLOAD_MS = 8_000

/**
 * A voice note is a document whose author sets the size, and the page asks for
 * a transcript of every unread note by itself. An oversized "voice" therefore
 * reaches memory without anyone asking: refuse it before the download, not
 * after. Telegram's own recording cap is one minute; ten is already hostile.
 */
const MAX_VOICE_BYTES = 8 * 1024 * 1024
const MAX_VOICE_SECONDS = 600

/** TL `long` arrives as BigInteger; a size beyond 2^53 is a hostile file anyway. */
function sizeOf(value: unknown): number {
  const n = Number(String(value ?? 0))
  return Number.isFinite(n) && n > 0 ? n : 0
}

interface Pending {
  id: string
  /** E.164; empty for a link login (the account is unknown until confirmation). */
  phone: string
  phoneCodeHash: string | null
  step: 'code' | 'password' | 'link'
  resendAt: number
  /** When the pending login itself is dropped. */
  expiresAt: number
  /** `tg://login?token=…` of the current link token. */
  tokenUrl: string | null
  tokenExpiresAt: number
  client: TgClient
}

export interface AuthServiceDeps {
  config: Config
  db: Db
  clients: ClientRegistry
  log: Logger
}

/** A cached dialog row: what `/messages` needs to read the unread window. */
interface PeerEntry {
  peer: Api.TypeInputPeer
  /** Telegram marks a chat read up to this id; 0 — the row did not say. */
  readInboxMaxId: number
  /** Unread counter of the row at the moment it was cached. */
  unread: number
}

export class TelegramAuthService implements AuthService {
  private readonly config: Config
  private readonly db: Db
  private readonly clients: ClientRegistry
  private readonly log: Logger

  private readonly pending = new Map<string, Pending>()
  private latestPendingId: string | null = null
  /**
   * `chatId → input peer`, filled by `chats`. The glasses request messages by
   * the id the list gave them, and an access hash cannot travel through the
   * WebView — so the peer stays here, keyed by session.
   *
   * The row also remembers the read watermark: Telegram marks a chat read up to
   * `readInboxMaxId`, so everything newer is the unread window. Asking for that
   * window, instead of "the last 30 messages", is what keeps unread messages
   * from disappearing behind a wall of outgoing ones.
   */
  private readonly peers = new Map<string, PeerEntry>()
  /** One dialog fetch per session, however many message requests arrive at once. */
  private readonly dialogsLoading = new Map<string, Promise<void>>()
  /** Survives the pending entry, so repeated link polls answer `connected`. */
  private linkDone: { token: string; at: number } | null = null
  private readonly locks = new Map<string, Promise<void>>()

  constructor(deps: AuthServiceDeps) {
    this.config = deps.config
    this.db = deps.db
    this.clients = deps.clients
    this.log = deps.log
  }

  boot(): void {
    const dropped = this.db.countPending()
    if (dropped > 0) this.db.deleteAllPending()
    this.log.info('boot', {
      testDc: this.config.testDc,
      pendingDropped: dropped,
      db: this.config.dbPath,
    })
  }

  async health(): Promise<Health> {
    return {
      backend: 'ok',
      llm: this.db.hasLlmKey() ? 'ok' : 'off',
      checkedAt: new Date().toISOString(),
    }
  }

  // ---- step ---------------------------------------------------------------

  async state(token: string | null): Promise<AuthState> {
    if (token) {
      const session = this.sessionOfToken(token)
      if (session) return { step: 'connected' }
    }
    const pending = this.livePending()
    return pending ? this.wire(pending) : { step: 'idle' }
  }

  // ---- phone + code -------------------------------------------------------

  async sendCode(rawPhone: string): Promise<AuthState> {
    return this.lock('auth', async () => {
      const phone = normalizePhone(rawPhone)
      this.log.info('auth.sendCode', { phone: maskPhone(phone) })

      const current = this.livePending()
      if (current && current.step !== 'link' && current.phone === phone) {
        // The same number asked again: this is either a duplicated POST after a
        // timeout or an explicit "send again". Only the latter calls Telegram,
        // and only when the server's own timeout has passed.
        if (current.step === 'password') return this.wire(current)
        if (current.phoneCodeHash !== null && Date.now() < current.resendAt) {
          return this.wire(current)
        }
        if (current.phoneCodeHash === null) {
          this.dropPending(current, 'restart')
        } else {
          return await this.resend(current)
        }
      } else if (current) {
        this.dropPending(current, 'replaced')
      }

      const client = this.clients.createPending()
      const pending = this.registerPending(phone, 'code', client)
      try {
        const started = Date.now()
        await this.connect(client, this.left(started))
        const params = {
          phoneNumber: phone,
          apiId: this.config.apiId,
          apiHash: this.config.apiHash,
          settings: this.codeSettings(),
        }
        // The only repeat we allow: a DC migration. That request was rejected,
        // not executed, so no code was sent. Everything else surfaces as is.
        const request = async (): Promise<Api.auth.TypeSentCode> => {
          try {
            return await client.api.auth.sendCode(params)
          } catch (err) {
            const dc = migrateDcOf(err)
            if (dc === null) throw err
            this.log.info('auth.migrate', { dc })
            await this.wait(client._switchDC(dc), this.left(started))
            return await client.api.auth.sendCode(params)
          }
        }
        let late = false
        const handled = request().then((sent) => {
          if (late) this.applyLate(pending, sent)
          return sent
        })
        const raced = await raceTimeout(handled, this.left(started))
        if (raced.timedOut) {
          late = true
          this.log.warn('auth.sendCode.timeout', { phone: maskPhone(phone) })
          throw new ContractError('network', 502)
        }
        return this.afterSentCode(pending, raced.value)
      } catch (err) {
        const contract = toContractError(err, 'auth')
        if (contract.code !== 'network' && pending.phoneCodeHash === null) {
          this.dropPending(pending, 'sendcode_failed')
        }
        this.log.warn('auth.sendCode.failed', {
          phone: maskPhone(phone),
          rpc: loggableError(err),
          mapped: contract.code,
        })
        throw contract
      }
    })
  }

  async verifyCode(rawPhone: string, code: string): Promise<AuthState> {
    return this.lock('auth', async () => {
      const phone = normalizePhone(rawPhone)
      const pending = this.pendingForPhone(phone)
      if (!pending) throw new ContractError('expiredCode')
      if (pending.step === 'password') return this.wire(pending)
      if (pending.step !== 'code' || pending.phoneCodeHash === null) {
        throw new ContractError('expiredCode')
      }
      if (!/^\d{4,6}$/.test(code)) throw new ContractError('wrongCode')

      this.log.info('auth.signIn', { phone: maskPhone(phone) })
      try {
        await this.connect(pending.client)
        const authorization = await this.wait(
          pending.client.api.auth.signIn({
            phoneNumber: phone,
            phoneCodeHash: pending.phoneCodeHash,
            phoneCode: code,
          }),
        )
        return this.finish(pending, authorization)
      } catch (err) {
        if (errorCodeOf(err) === 'SESSION_PASSWORD_NEEDED') {
          pending.step = 'password'
          this.savePending(pending)
          this.log.info('auth.passwordRequired', { phone: maskPhone(phone) })
          return this.wire(pending)
        }
        const contract = toContractError(err, 'auth')
        // An expired code cannot be retried with the same hash: drop the pending
        // entry so the next `sendCode` starts a fresh one instead of calling
        // `resendCode` forever.
        if (contract.code === 'expiredCode') this.dropPending(pending, 'code_expired')
        this.log.warn('auth.signIn.failed', {
          phone: maskPhone(phone),
          rpc: loggableError(err),
          mapped: contract.code,
        })
        throw contract
      }
    })
  }

  async verifyPassword(password: string): Promise<AuthState> {
    return this.lock('auth', async () => {
      const pending = this.pendingWithStep('password')
      if (!pending) throw new ContractError('expiredCode')
      if (typeof password !== 'string' || password.length === 0) {
        throw new ContractError('wrongPassword')
      }
      this.log.info('auth.checkPassword', { phone: maskPhone(pending.phone) })
      try {
        await this.connect(pending.client)
        const request = await this.wait(pending.client.api.account.getPassword())
        if (!(request instanceof Api.account.Password)) {
          throw new ContractError('unknown')
        }
        const check = await passwordUtils.computeCheck(request, password)
        const authorization = await this.wait(
          pending.client.api.auth.checkPassword({ password: check }),
        )
        return this.finish(pending, authorization)
      } catch (err) {
        const contract = toContractError(err, 'auth')
        this.log.warn('auth.checkPassword.failed', {
          phone: maskPhone(pending.phone),
          rpc: loggableError(err),
          mapped: contract.code,
        })
        throw contract
      }
    })
  }

  // ---- link ---------------------------------------------------------------

  async startLink(): Promise<AuthState> {
    return this.lock('auth', async () => {
      this.linkDone = null
      let pending = this.livePending()
      if (!pending || pending.step !== 'link') {
        if (pending) this.dropPending(pending, 'replaced')
        const client = this.clients.createPending()
        pending = this.registerPending('', 'link', client)
      }

      this.log.info('auth.link.start', { pending: pending.id })
      try {
        await this.connect(pending.client)
        const outcome = await this.exportLoginToken(pending)
        if (outcome.kind === 'completed') {
          return this.finish(pending, outcome.authorization)
        }
        return this.wire(pending)
      } catch (err) {
        const contract = toContractError(err, 'link')
        if (contract.code === 'linkExpired') this.dropPending(pending, 'link_failed')
        this.log.warn('auth.link.start.failed', {
          rpc: loggableError(err),
          mapped: contract.code,
        })
        throw contract
      }
    })
  }

  async linkState(token: string | null): Promise<LinkState> {
    return this.lock('auth', async () => {
      if (token && this.sessionOfToken(token)) return { status: 'connected' }

      if (this.linkDone && Date.now() - this.linkDone.at < LINK_DONE_MS) {
        return this.linkDone.token.length > 0
          ? { status: 'connected', token: this.linkDone.token }
          : { status: 'connected' }
      }

      const pending = this.livePending()
      if (!pending || pending.step !== 'link') return { status: 'expired' }
      if (pending.tokenExpiresAt <= Date.now()) return { status: 'expired' }

      try {
        await this.connect(pending.client)
        const outcome = await this.exportLoginToken(pending)
        if (outcome.kind === 'completed') {
          const state = this.finish(pending, outcome.authorization)
          const issued = state.step === 'connected' ? state.token : undefined
          this.linkDone = { token: issued ?? '', at: Date.now() }
          return issued ? { status: 'connected', token: issued } : { status: 'connected' }
        }
        return { status: 'pending' }
      } catch (err) {
        const contract = toContractError(err, 'link')
        if (contract.code === 'linkExpired') return { status: 'expired' }
        this.log.warn('auth.link.poll.failed', {
          rpc: loggableError(err),
          mapped: contract.code,
        })
        throw contract
      }
    })
  }

  /**
   * `exportLoginToken` both issues and polls a link: the server only learns that
   * the human confirmed it when the same client asks again.
   */
  private async exportLoginToken(
    pending: Pending,
  ): Promise<{ kind: 'link' } | { kind: 'completed'; authorization: Api.auth.TypeAuthorization }> {
    const result = await this.wait(
      pending.client.api.auth.exportLoginToken({
        apiId: this.config.apiId,
        apiHash: this.config.apiHash,
        exceptIds: [],
      }),
    )
    if (result instanceof Api.auth.LoginToken) {
      pending.tokenUrl = `tg://login?token=${result.token.toString('base64url')}`
      pending.tokenExpiresAt = result.expires * 1000
      this.savePending(pending)
      return { kind: 'link' }
    }
    if (result instanceof Api.auth.LoginTokenSuccess) {
      return { kind: 'completed', authorization: result.authorization }
    }
    if (result instanceof Api.auth.LoginTokenMigrateTo) {
      await this.wait(pending.client._switchDC(result.dcId))
      const imported = await this.wait(
        pending.client.api.auth.importLoginToken({ token: result.token }),
      )
      if (imported instanceof Api.auth.LoginTokenSuccess) {
        return { kind: 'completed', authorization: imported.authorization }
      }
      throw new ContractError('linkExpired')
    }
    throw new ContractError('unknown')
  }

  // ---- logout / delete ----------------------------------------------------

  async logout(token: string | null): Promise<void> {
    return this.lock('auth', async () => {
      const started = Date.now()
      const session = this.requireSession(token)
      const client = await this.sessionClient(session, this.left(started))
      try {
        const raced = await raceTimeout(client.api.auth.logOut(), this.left(started))
        if (raced.timedOut) throw new ContractError('network', 502)
        const result = raced.value
        if (result instanceof Api.auth.LoggedOut && result.futureAuthToken) {
          this.db.addFutureToken(result.futureAuthToken.toString('base64'), session.id, Date.now())
        }
      } catch (err) {
        if (isNetworkError(err) || (err instanceof ContractError && err.code === 'network')) {
          // The session on Telegram's side may still be alive; saying "logged
          // out" would be a lie.
          throw new ContractError('network', 502)
        }
        this.log.warn('auth.logout.rpc', { rpc: loggableError(err) })
      }
      this.clients.forget(session.id)
      this.db.deleteSession(session.id)
      this.clearPendings('logout')
      this.linkDone = null
      this.forgetPeers(session.id)
      this.log.info('auth.logout', { userId: session.user_id })
    })
  }

  async deleteAll(token: string | null): Promise<void> {
    return this.lock('auth', async () => {
      const started = Date.now()
      const session = this.requireSession(token)
      try {
        const client = await this.sessionClient(session, this.left(started))
        const raced = await raceTimeout(client.api.auth.logOut(), this.left(started))
        if (raced.timedOut) throw new ContractError('network', 502)
      } catch (err) {
        // Deleting local data is the promise here; a dead or unreachable remote
        // session must not keep a copy of the key on disk.
        this.log.warn('data.delete.logout', { rpc: loggableError(err) })
      }
      this.clients.forget(session.id)
      this.db.wipeAll()
      this.clearPendings('delete')
      this.linkDone = null
      this.forgetPeers(session.id)
      this.log.info('data.delete', {})
    })
  }

  // ---- chats --------------------------------------------------------------

  async chats(token: string | null): Promise<ChatSummary[]> {
    const started = Date.now()
    const session = this.requireSession(token)
    const client = await this.sessionClient(session, this.left(started))
    try {
      const dialogs = await this.wait(
        client.getDialogs({ limit: 30, ignoreMigrated: true }),
        this.left(started),
      )
      const out: ChatSummary[] = []
      for (const dialog of dialogs) {
        const row = chatSummaryOf(dialog)
        if (row) {
          out.push(row)
          this.peers.set(this.peerKey(session.id, row.id), peerEntryOf(dialog, row))
        }
        if (out.length >= 30) break
      }
      this.persistSession(client, session)
      this.log.info('chats.loaded', {
        count: out.length,
        unread: out.reduce((sum, chat) => sum + chat.unread, 0),
        userId: session.user_id,
      })
      return out
    } catch (err) {
      if (isSessionDead(err)) {
        this.dropDeadSession(session)
        throw new ContractError('unknown', 401)
      }
      const contract = toContractError(err, 'chats')
      this.log.warn('chats.failed', { rpc: loggableError(err), mapped: contract.code })
      throw contract
    }
  }

  async messages(
    token: string | null,
    chatId: string,
    limit = 30,
    withHistory = false,
  ): Promise<MessageSummary[]> {
    const started = Date.now()
    const session = this.requireSession(token)
    const client = await this.sessionClient(session, this.left(started))
    try {
      const entry = await this.peerFor(client, session, chatId, this.left(started))
      // The newest messages of the unread window: the row time and "1/N" must be
      // the recent ones, not a block read from the bottom of the window.
      let rows: Api.TypeMessage[] = await this.wait(
        client.getMessages(entry.peer, messageQuery(entry, limit)),
        this.left(started),
      )
      // If a wall of our own newer messages hid the unread ones, walk forward
      // from the read watermark instead: that direction is exactly the unread
      // block, so the chat cannot silently lose its messages.
      const wanted = Math.min(Math.max(entry.unread, 1), 30)
      if (entry.readInboxMaxId > 0 && incomingCount(rows) < wanted) {
        try {
          const older = await this.wait(
            client.getMessages(entry.peer, forwardQuery(entry)),
            this.left(started),
          )
          rows = mergeById(rows, older)
        } catch (err) {
          // The newest window is already in hand: a failed second request must
          // not throw the chat away. Log it and show what was fetched.
          if (isSessionDead(err)) throw err
          this.log.warn('messages.forward.failed', { chatId, rpc: loggableError(err) })
        }
      }
      // The LLM answers a message that may be the first of a one-message unread
      // block; without the read messages above it the prompt has no conversation
      // at all (task v0.5 §4 p.7). The glasses never ask for this.
      if (withHistory && entry.readInboxMaxId > 0) {
        const anchor = oldestMessageId(rows)
        if (anchor > 0) {
          try {
            const older = await this.wait(
              client.getMessages(entry.peer, historyQuery(anchor, limit)),
              this.left(started),
            )
            rows = mergeById(rows, older)
          } catch (err) {
            // Same rule as the forward walk: the unread window already answers
            // the screen, so a failed history request must not throw it away.
            if (isSessionDead(err)) throw err
            this.log.warn('messages.history.failed', { chatId, rpc: loggableError(err) })
          }
        }
      }
      // Telegram answers newest first; the CHAT screen pages from the top of the
      // oldest unread, so the order is flipped here once, not in the WebView.
      const out = rows
        .filter((message): message is Api.Message => message instanceof Api.Message)
        .map(messageSummaryOf)
        .sort((a, b) => {
          if (a.at !== b.at) return a.at < b.at ? -1 : 1
          return Number(a.id) - Number(b.id)
        })
      this.persistSession(client, session)
      this.log.info('messages.loaded', {
        chatId,
        count: out.length,
        userId: session.user_id,
      })
      return out
    } catch (err) {
      if (isSessionDead(err)) {
        this.dropDeadSession(session)
        throw new ContractError('unknown', 401)
      }
      const contract = toContractError(err, 'messages')
      this.log.warn('messages.failed', {
        chatId,
        rpc: loggableError(err),
        mapped: contract.code,
      })
      throw contract
    }
  }

  /**
   * Unread counter from the dialog cache; no RPC. Zero when the chat has not
   * been fetched yet, which means "unknown" to the LLM, not "nothing unread".
   */
  async unreadCount(token: string | null, chatId: string): Promise<number> {
    const session = this.requireSession(token)
    return this.peers.get(this.peerKey(session.id, chatId))?.unread ?? 0
  }

  // ---- sending and read marks ---------------------------------------------

  async sendReply(
    token: string | null,
    chatId: string,
    messageId: string,
    text: string,
  ): Promise<{ id: string; at: string }> {
    const started = Date.now()
    const session = this.requireSession(token)
    const clean = text.trim()
    if (clean.length === 0 || clean.length > 4096) throw new ContractError('unknown', 400)
    if (!NUMERIC_ID.test(messageId)) throw new ContractError('unknown', 404)

    try {
      // Inside the try: a connection failure is a failed send too (`send`, 502),
      // not a bare `network` the contract does not promise here.
      const client = await this.sessionClient(session, this.left(started, SEND_BUDGET_MS))
      const entry = await this.peerFor(client, session, chatId, this.left(started, SEND_BUDGET_MS))
      // The answered message must exist in this dialog: a foreign id is not a
      // reply target and must not anchor a random_id.
      await this.assertInChat(
        client,
        entry,
        Number(messageId),
        this.left(started, SEND_BUDGET_MS),
      )

      const updates = await this.wait(
        client.invoke(
          new Api.messages.SendMessage({
            peer: entry.peer,
            message: clean,
            randomId: sendRandomId(chatId, messageId),
            noWebpage: true,
          }),
        ),
        this.left(started, SEND_BUDGET_MS),
      )
      const sent = sentMessageOf(updates)
      if (!sent) throw new Error('the send response carried no message id')

      this.persistSession(client, session)
      const date = sent.date > 0 ? sent.date : Math.floor(Date.now() / 1000)
      this.log.info('send.ok', { chatId, chars: clean.length, ms: Date.now() - started })
      return { id: String(sent.id), at: new Date(date * 1000).toISOString() }
    } catch (err) {
      if (isSessionDead(err)) {
        this.dropDeadSession(session)
        throw new ContractError('unknown', 401)
      }
      throw sendFailureOf(err, chatId, this.log)
    }
  }

  async markRead(token: string | null, chatId: string, messageId: string): Promise<void> {
    if (!NUMERIC_ID.test(messageId)) throw new ContractError('unknown', 404)
    await this.readUpTo(token, chatId, Number(messageId), true)
  }

  async markChatRead(token: string | null, chatId: string): Promise<void> {
    await this.readUpTo(token, chatId, 0, false)
  }

  /** The stored session behind a bearer token; `null` for an unknown token. */
  sessionId(token: string | null): string | null {
    return token ? this.sessionOfToken(token)?.id ?? null : null
  }

  /**
   * The id we mark read must be this dialog's message: `readHistory` with a
   * foreign or invented `max_id` would silently read the whole chat.
   */
  private async readUpTo(
    token: string | null,
    chatId: string,
    maxId: number,
    checkMessage: boolean,
  ): Promise<void> {
    const started = Date.now()
    const session = this.requireSession(token)
    const client = await this.sessionClient(session, this.left(started))
    try {
      const entry = await this.peerFor(client, session, chatId, this.left(started))
      if (checkMessage) await this.assertInChat(client, entry, maxId, this.left(started))
      // Channels have their own readHistory request; groups and users use the
      // messages one. `maxId: 0` means "up to the newest message".
      const request =
        entry.peer instanceof Api.InputPeerChannel
          ? new Api.channels.ReadHistory({ channel: entry.peer, maxId })
          : new Api.messages.ReadHistory({ peer: entry.peer, maxId })
      await this.wait(client.invoke(request), this.left(started))
      // Keep the cached window honest without another dialogs round-trip:
      // everything up to `maxId` is read, a whole-chat mark clears the counter.
      // The count is logged before the reset: after it, "0" says nothing.
      const unread = entry.unread
      if (maxId > 0) entry.readInboxMaxId = Math.max(entry.readInboxMaxId, maxId)
      else entry.unread = 0
      this.persistSession(client, session)
      this.log.info('read.ok', { chatId, maxId, unread, ms: Date.now() - started })
    } catch (err) {
      if (isSessionDead(err)) {
        this.dropDeadSession(session)
        throw new ContractError('unknown', 401)
      }
      if (err instanceof ContractError && err.status === 404) throw err
      this.log.warn('read.failed', { chatId, rpc: rpcField(err) })
      if (err instanceof ContractError) throw err
      throw new ContractError('unknown', 502)
    }
  }

  /**
   * Does this dialog have a message with this number? Telegram numbers messages
   * per chat, so a number alone cannot prove which chat it came from; the best
   * available check is "the newest message below the target is the target".
   * The page always sends an id from this chat's own feed; a number that is not
   * in this dialog is a 404 and nothing is sent.
   */
  private async assertInChat(
    client: TgClient,
    entry: PeerEntry,
    id: number,
    ms: number,
  ): Promise<void> {
    const target = await this.wait(
      client.invoke(
        new Api.messages.GetHistory({
          peer: entry.peer,
          offsetId: id + 1,
          limit: 1,
          hash: helpers.returnBigInt(0),
        }),
      ),
      ms,
    )
    if (!holdsMessage(target, id)) throw new ContractError('unknown', 404)
  }

  // ---- voice --------------------------------------------------------------

  /**
   * Bytes of one voice message. The id must belong to this dialog (same check
   * as a reply anchor); a text message, a photo or a sticker is `400`: there is
   * nothing to recognize.
   */
  async voiceMessageOf(
    token: string | null,
    chatId: string,
    messageId: string,
  ): Promise<VoiceAudio> {
    const started = Date.now()
    const session = this.requireSession(token)
    if (!NUMERIC_ID.test(messageId)) throw new ContractError('unknown', 404)

    try {
      const client = await this.sessionClient(session, this.left(started, VOICE_DOWNLOAD_MS))
      const entry = await this.peerFor(client, session, chatId, this.left(started, VOICE_DOWNLOAD_MS))
      const message = await this.messageInChat(
        client,
        entry,
        Number(messageId),
        this.left(started, VOICE_DOWNLOAD_MS),
      )

      const media = message.media
      const document = media instanceof Api.MessageMediaDocument ? media.document : undefined
      if (!(document instanceof Api.Document)) throw new ContractError('unknown', 400)

      let voice = false
      let duration = 0
      for (const attribute of document.attributes) {
        if (attribute instanceof Api.DocumentAttributeAudio) {
          voice = attribute.voice === true
          duration = typeof attribute.duration === 'number' ? attribute.duration : 0
        }
      }
      if (!voice) throw new ContractError('unknown', 400)
      const bytes = sizeOf(document.size)
      if (bytes > MAX_VOICE_BYTES || duration > MAX_VOICE_SECONDS) {
        // Nothing is downloaded: the page keeps the media word on screen, and
        // the log says why without naming the peer or the file.
        this.log.warn('voice.refused', { chatId, bytes, seconds: duration })
        throw new ContractError('unknown', 400)
      }

      const downloaded = await this.wait(
        client.downloadMedia(message, {}),
        this.left(started, VOICE_DOWNLOAD_MS),
      )
      const audio = Buffer.isBuffer(downloaded)
        ? downloaded
        : typeof downloaded === 'string'
          ? await readFile(downloaded)
          : null
      if (!audio || audio.length === 0) throw new Error('the download returned no bytes')

      this.persistSession(client, session)
      return { audio, mime: document.mimeType || 'audio/ogg', durationSec: duration }
    } catch (err) {
      if (isSessionDead(err)) {
        this.dropDeadSession(session)
        throw new ContractError('unknown', 401)
      }
      if (err instanceof ContractError) throw err
      this.log.warn('voice.failed', { chatId, reason: 'download', rpc: rpcField(err) })
      throw new ContractError('stt', 502)
    }
  }

  /**
   * The uploaded Ogg Opus file as a voice note. `random_id` is stable for the
   * pair (a retry cannot duplicate) and namespaced away from the text one:
   * Telegram dedupes across media types and would return the text message.
   */
  async sendVoiceFile(
    token: string | null,
    chatId: string,
    messageId: string,
    file: VoiceFile,
  ): Promise<{ id: string; at: string }> {
    const started = Date.now()
    const session = this.requireSession(token)
    if (!NUMERIC_ID.test(messageId)) throw new ContractError('unknown', 404)

    try {
      // Inside the try: a connection failure is a failed send (`send`, 502),
      // not a bare `network` the contract does not promise here.
      const client = await this.sessionClient(session, this.left(started, VOICE_BUDGET_MS))
      const entry = await this.peerFor(client, session, chatId, this.left(started, VOICE_BUDGET_MS))
      await this.assertInChat(
        client,
        entry,
        Number(messageId),
        this.left(started, VOICE_BUDGET_MS),
      )

      const uploaded = await this.wait(
        client.uploadFile({
          file: new CustomFile('voice.ogg', file.size, file.path),
          workers: 1,
        }),
        this.left(started, VOICE_BUDGET_MS),
      )
      const updates = await this.wait(
        client.invoke(
          new Api.messages.SendMedia({
            peer: entry.peer,
            media: new Api.InputMediaUploadedDocument({
              file: uploaded,
              mimeType: 'audio/ogg',
              attributes: [
                new Api.DocumentAttributeAudio({
                  voice: true,
                  duration: Math.max(1, Math.round(file.durationSec)),
                }),
              ],
            }),
            message: '',
            randomId: voiceRandomId(chatId, messageId),
          }),
        ),
        this.left(started, VOICE_BUDGET_MS),
      )
      const sent = sentMessageOf(updates)
      if (!sent) throw new Error('the send response carried no message id')

      this.persistSession(client, session)
      const date = sent.date > 0 ? sent.date : Math.floor(Date.now() / 1000)
      this.log.info('voice.ok', {
        chatId,
        seconds: Math.round(file.durationSec),
        ms: Date.now() - started,
      })
      return { id: String(sent.id), at: new Date(date * 1000).toISOString() }
    } catch (err) {
      if (isSessionDead(err)) {
        this.dropDeadSession(session)
        throw new ContractError('unknown', 401)
      }
      throw voiceFailureOf(err, chatId, this.log)
    }
  }

  /** The message itself, or `404` when this dialog has no such number. */
  private async messageInChat(
    client: TgClient,
    entry: PeerEntry,
    id: number,
    ms: number,
  ): Promise<Api.Message> {
    const target = await this.wait(
      client.invoke(
        new Api.messages.GetHistory({
          peer: entry.peer,
          offsetId: id + 1,
          limit: 1,
          hash: helpers.returnBigInt(0),
        }),
      ),
      ms,
    )
    const rows =
      target && typeof target === 'object' && 'messages' in target
        ? (target as { messages?: unknown }).messages
        : undefined
    const first = Array.isArray(rows) ? rows[0] : undefined
    if (!holdsMessage(target, id) || !(first instanceof Api.Message)) {
      throw new ContractError('unknown', 404)
    }
    return first
  }

  // ---- settings / LLM key -------------------------------------------------

  async putSettings(token: string | null, payload: SettingsPayload): Promise<void> {
    const session = this.requireSession(token)
    this.db.putSettings(session.id, payload, Date.now())
    this.log.info('settings.saved', { userId: session.user_id })
  }

  async setLlmKey(token: string | null, apiKey: string): Promise<void> {
    const session = this.requireSession(token)
    const key = apiKey.trim()
    if (key.length < 8 || key.length > 512) throw new ContractError('unknown')
    this.db.putLlmKey(encrypt(key, this.config.encKey, 'llm'), Date.now())
    this.log.info('llm.key.saved', { userId: session.user_id })
  }

  async stop(): Promise<void> {
    this.clearPendings('stop', false)
    await this.clients.destroyAll()
  }

  // ---- internals ----------------------------------------------------------

  private async resend(pending: Pending): Promise<AuthState> {
    const hash = pending.phoneCodeHash
    if (hash === null) throw new ContractError('expiredCode')
    this.log.info('auth.resendCode', { phone: maskPhone(pending.phone) })
    try {
      await this.connect(pending.client)
      const sent = await this.wait(
        pending.client.api.auth.resendCode({
          phoneNumber: pending.phone,
          phoneCodeHash: hash,
        }),
      )
      return this.afterSentCode(pending, sent)
    } catch (err) {
      const contract = toContractError(err, 'auth')
      if (contract.code === 'expiredCode') this.dropPending(pending, 'resend_expired')
      this.log.warn('auth.resendCode.failed', {
        phone: maskPhone(pending.phone),
        rpc: loggableError(err),
        mapped: contract.code,
      })
      throw contract
    }
  }

  private afterSentCode(pending: Pending, sent: Api.auth.TypeSentCode): AuthState {
    if (sent instanceof Api.auth.SentCodeSuccess) {
      // A stored future auth token did its job: no code needed.
      return this.finish(pending, sent.authorization)
    }
    if (!(sent instanceof Api.auth.SentCode)) throw new ContractError('unknown')
    pending.phoneCodeHash = sent.phoneCodeHash
    const timeout = typeof sent.timeout === 'number' && sent.timeout > 0 ? sent.timeout : 60
    pending.resendAt = Date.now() + timeout * 1000
    pending.expiresAt = Date.now() + PENDING_TTL_MS
    pending.step = 'code'
    this.savePending(pending)
    return this.wire(pending)
  }

  /** A `sendCode` that finished after the HTTP deadline. */
  private applyLate(pending: Pending, sent: Api.auth.TypeSentCode): void {
    if (!this.pending.has(pending.id)) return
    if (sent instanceof Api.auth.SentCodeSuccess) {
      // No channel to deliver the bearer token any more; the next attempt will
      // get `sentCodeSuccess` again through the stored future token.
      this.dropPending(pending, 'late_success')
      return
    }
    try {
      this.afterSentCode(pending, sent)
      this.log.info('auth.sendCode.late', { phone: maskPhone(pending.phone) })
    } catch {
      this.dropPending(pending, 'late_failed')
    }
  }

  private codeSettings(): Api.CodeSettings {
    const logoutTokens = this.db
      .futureTokens(20)
      .map((token) => Buffer.from(token, 'base64'))
    return new Api.CodeSettings({
      allowFlashcall: false,
      currentNumber: false,
      allowAppHash: false,
      allowMissedCall: false,
      ...(logoutTokens.length > 0 ? { logoutTokens } : {}),
    })
  }

  private finish(pending: Pending, authorization: Api.auth.TypeAuthorization): AuthState {
    // Our client never signs up: an authorization without a user means the
    // account does not exist, and `auth.signUp` is explicitly out of scope.
    if (!(authorization instanceof Api.auth.Authorization)) {
      throw new ContractError('unknown')
    }
    const sessionString = pending.client.session.save()
    if (!sessionString) throw new ContractError('unknown', 500)

    const user = authorization.user
    const sessionId = randomUUID()
    const row: SessionRow = {
      id: sessionId,
      user_id: String(user.id ?? ''),
      first_name: user instanceof Api.User ? (user.firstName ?? '') : '',
      username: user instanceof Api.User ? (user.username ?? '') : '',
      enc_session: encrypt(sessionString, this.config.encKey, `session:${sessionId}`),
      test_dc: this.config.testDc ? 1 : 0,
      created_at: Date.now(),
    }
    this.db.saveSession(row)

    const bearer = newBearerToken()
    this.db.putAuthToken(bearer.hash, sessionId, Date.now())

    if (authorization.futureAuthToken) {
      this.db.addFutureToken(
        authorization.futureAuthToken.toString('base64'),
        sessionId,
        Date.now(),
      )
    }

    this.db.deleteAllPending()
    this.pending.delete(pending.id)
    if (this.latestPendingId === pending.id) this.latestPendingId = null
    this.clients.adopt(sessionId, pending.client)

    this.log.info('auth.connected', {
      userId: row.user_id,
      phone: pending.phone ? maskPhone(pending.phone) : '',
      testDc: this.config.testDc,
    })
    return { step: 'connected', token: bearer.token }
  }

  private wire(pending: Pending): AuthState {
    switch (pending.step) {
      case 'code':
        return {
          step: 'code',
          phone: prettyPhone(pending.phone),
          resendAt: pending.resendAt,
        }
      case 'password':
        return { step: 'password', phone: prettyPhone(pending.phone) }
      case 'link':
        return {
          step: 'link',
          url: pending.tokenUrl ?? '',
          expiresAt: pending.tokenExpiresAt,
        }
    }
  }

  private registerPending(phone: string, step: Pending['step'], client: TgClient): Pending {
    const now = Date.now()
    const pending: Pending = {
      id: randomUUID(),
      phone,
      phoneCodeHash: null,
      step,
      resendAt: 0,
      expiresAt: now + PENDING_TTL_MS,
      tokenUrl: null,
      tokenExpiresAt: 0,
      client,
    }
    this.pending.set(pending.id, pending)
    this.latestPendingId = pending.id
    this.savePending(pending)
    return pending
  }

  private savePending(pending: Pending): void {
    this.db.putPending({
      id: pending.id,
      phone: pending.phone,
      phone_code_hash: pending.phoneCodeHash,
      step: pending.step,
      resend_at: pending.resendAt,
      expires_at: pending.expiresAt,
      created_at: Date.now(),
    })
  }

  /** The newest pending login, if it is still within its TTL. */
  private livePending(): Pending | null {
    if (this.latestPendingId === null) return null
    const pending = this.pending.get(this.latestPendingId)
    if (!pending) {
      this.latestPendingId = null
      return null
    }
    if (pending.expiresAt <= Date.now()) {
      this.dropPending(pending, 'expired')
      return null
    }
    return pending
  }

  private pendingForPhone(phone: string): Pending | null {
    const live = this.livePending()
    if (live && live.phone === phone) return live
    for (const pending of this.pending.values()) {
      if (pending.phone === phone) return pending
    }
    return null
  }

  private pendingWithStep(step: Pending['step']): Pending | null {
    const live = this.livePending()
    if (live && live.step === step) return live
    for (const pending of this.pending.values()) {
      if (pending.step === step) return pending
    }
    return null
  }

  private dropPending(pending: Pending, reason: string): void {
    if (!this.pending.delete(pending.id)) return
    if (this.latestPendingId === pending.id) this.latestPendingId = null
    this.db.deletePending(pending.id)
    void pending.client.destroy().catch(() => undefined)
    this.log.info('pending.dropped', { reason, pending: pending.id })
  }

  private clearPendings(reason: string, destroy = true): void {
    for (const pending of [...this.pending.values()]) {
      if (destroy) {
        this.dropPending(pending, reason)
      } else {
        this.pending.delete(pending.id)
        this.db.deletePending(pending.id)
        void pending.client.destroy().catch(() => undefined)
      }
    }
    this.latestPendingId = null
    this.db.deleteAllPending()
  }

  private async connect(client: TgClient, ms = CONNECT_MS): Promise<void> {
    if (client.connected) return
    const raced = await raceTimeout(client.connect(), ms)
    if (raced.timedOut) throw new ContractError('network', 502)
  }

  /** Time left in the whole-request budget, never negative. */
  private left(started: number, budget = REQUEST_BUDGET_MS): number {
    // No floor: when the budget is gone the request must fail as `network` now,
    // not spend another second per step and drift past the WebView's timeout.
    return Math.max(0, budget - (Date.now() - started))
  }

  private async wait<T>(promise: Promise<T>, ms = CALL_MS): Promise<T> {
    const raced = await raceTimeout(promise, ms)
    if (raced.timedOut) throw new ContractError('network', 502)
    return raced.value
  }

  private sessionOfToken(token: string): SessionRow | null {
    const hash = hashToken(token)
    const sessionId = this.db.sessionIdByTokenHash(hash)
    if (!sessionId) return null
    const session = this.db.getSession(sessionId)
    if (!session) {
      this.db.deleteAuthToken(hash)
      return null
    }
    if (session.test_dc !== (this.config.testDc ? 1 : 0)) return null
    return session
  }

  private requireSession(token: string | null): SessionRow {
    const session = token ? this.sessionOfToken(token) : null
    if (!session) throw new ContractError('unknown', 401)
    return session
  }

  private async sessionClient(session: SessionRow, ms = CONNECT_MS): Promise<TgClient> {
    try {
      const sessionString = decrypt(
        session.enc_session,
        this.config.encKey,
        `session:${session.id}`,
      )
      return await this.wait(this.clients.forSession(session.id, sessionString), ms)
    } catch (err) {
      if (err instanceof ContractError) throw err
      if (isNetworkError(err)) throw new ContractError('network', 502)
      this.log.error('session.open.failed', {
        userId: session.user_id,
        rpc: loggableError(err),
      })
      throw new ContractError('unknown', 500)
    }
  }

  private persistSession(client: TgClient, session: SessionRow): void {
    // The stored string is a cache of the auth key, not the result of the RPC:
    // a failed write must not turn a delivered message or a saved read mark
    // into an error the glasses show as "not sent".
    try {
      const current = client.session.save()
      if (!current) return
      // Compare the plaintext: the ciphertext changes on every encryption because
      // of the fresh IV, so comparing blobs would rewrite the row on every read.
      const stored = decrypt(session.enc_session, this.config.encKey, `session:${session.id}`)
      if (stored === current) return
      session.enc_session = encrypt(current, this.config.encKey, `session:${session.id}`)
      this.db.saveSession(session)
    } catch (err) {
      this.log.warn('session.persist.failed', {
        userId: session.user_id,
        rpc: loggableError(err),
      })
    }
  }

  private dropDeadSession(session: SessionRow): void {
    this.clients.forget(session.id)
    this.db.deleteSession(session.id)
    this.forgetPeers(session.id)
    this.log.warn('session.dead', { userId: session.user_id })
  }

  private peerKey(sessionId: string, chatId: string): string {
    return `${sessionId}|${chatId}`
  }

  private forgetPeers(sessionId: string): void {
    const prefix = `${sessionId}|`
    for (const key of [...this.peers.keys()]) {
      if (key.startsWith(prefix)) this.peers.delete(key)
    }
  }

  /**
   * The input peer of a dialog plus its unread window. `chats` usually filled
   * the cache; a backend that restarted between the list and the tap resolves
   * it again from the dialogs. Concurrent cold requests share one fetch.
   */
  private async peerFor(
    client: TgClient,
    session: SessionRow,
    chatId: string,
    ms = CALL_MS,
  ): Promise<PeerEntry> {
    const key = this.peerKey(session.id, chatId)
    const cached = this.peers.get(key)
    if (cached) return cached

    const loadingKey = `${session.id}|dialogs`
    let pending = this.dialogsLoading.get(loadingKey)
    if (!pending) {
      const started = this.refreshPeers(client, session, ms)
      const cleanup = (): void => {
        if (this.dialogsLoading.get(loadingKey) === started) this.dialogsLoading.delete(loadingKey)
      }
      pending = started
      this.dialogsLoading.set(loadingKey, started)
      void started.then(cleanup, cleanup)
    }
    await pending

    const found = this.peers.get(key)
    if (found) return found
    throw new ContractError('unknown', 404)
  }

  /** Fills the peer cache from the dialog list (the same 30 rows `/chats` reads). */
  private async refreshPeers(client: TgClient, session: SessionRow, ms: number): Promise<void> {
    const dialogs = await this.wait(
      client.getDialogs({ limit: 30, ignoreMigrated: true }),
      ms,
    )
    for (const dialog of dialogs) {
      const row = chatSummaryOf(dialog)
      if (!row) continue
      this.peers.set(this.peerKey(session.id, row.id), peerEntryOf(dialog, row))
    }
  }

  /** Serializes login mutations; the WebView can poll while a tap is in flight. */
  private async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(fn)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.locks.set(key, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
  }
}

// ---- helpers --------------------------------------------------------------

export function normalizePhone(raw: unknown): string {
  if (typeof raw !== 'string') throw new ContractError('unknown')
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 8 || digits.length > 15) throw new ContractError('unknown')
  return `+${digits}`
}

/** `+7 999 123-45-67` for Russian numbers, plain `+digits` otherwise. */
export function prettyPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('7')) {
    const rest = digits.slice(1)
    return `+7 ${rest.slice(0, 3)} ${rest.slice(3, 6)}-${rest.slice(6, 8)}-${rest.slice(8, 10)}`
  }
  return `+${digits}`
}

function errorCodeOf(err: unknown): string {
  if (err && typeof err === 'object') {
    const raw = (err as { errorMessage?: unknown }).errorMessage
    if (typeof raw === 'string') return raw
  }
  return ''
}

/**
 * The data centre a request was told to move to. `PHONE_MIGRATE_3` and
 * `NETWORK_MIGRATE_3` are the two that happen on an unauthenticated client;
 * `newDc` is read as a fallback for a typed error without its message.
 */
export function migrateDcOf(err: unknown): number | null {
  const message = errorCodeOf(err)
  const match = /^(?:PHONE|NETWORK)_MIGRATE_(\d+)$/.exec(message)
  if (match?.[1]) {
    const dc = Number(match[1])
    return Number.isInteger(dc) && dc > 0 ? dc : null
  }
  if (err && typeof err === 'object') {
    const dc = (err as { newDc?: unknown }).newDc
    if (typeof dc === 'number' && Number.isInteger(dc) && dc > 0) return dc
  }
  return null
}

// ---- dialogs --------------------------------------------------------------

interface DialogLike {
  id?: { toString(): string }
  title?: string
  name?: string
  isUser: boolean
  isChannel: boolean
  unreadCount?: number
  message?: Api.TypeMessage
}

export function chatIdOf(dialog: DialogLike): string | null {
  const rawId = dialog.id?.toString()
  if (!rawId) return null
  const kind = dialog.isUser ? 'user' : dialog.isChannel ? 'channel' : 'chat'
  return `${kind}:${rawId}`
}

export function chatSummaryOf(dialog: DialogLike): ChatSummary | null {
  const message = dialog.message
  if (!message) return null
  const id = chatIdOf(dialog)
  if (!id) return null
  // A real title may carry newlines or control characters; the screen is one line.
  const title = stripControl(dialog.title || dialog.name || id).replace(/\s+/g, ' ').trim() || id
  return {
    id,
    title,
    preview: previewOf(message),
    unread: typeof dialog.unreadCount === 'number' ? Math.max(0, dialog.unreadCount) : 0,
  }
}

/** Minimal shape of a dialog row for the peer cache (teleproto's `Dialog`). */
interface DialogEntryLike {
  inputEntity: Api.TypeInputPeer
  dialog?: { readInboxMaxId?: unknown }
}

function peerEntryOf(dialog: DialogEntryLike, row: ChatSummary): PeerEntry {
  const watermark = dialog.dialog?.readInboxMaxId
  return {
    peer: dialog.inputEntity,
    readInboxMaxId:
      typeof watermark === 'number' && Number.isFinite(watermark) && watermark > 0 ? watermark : 0,
    unread: row.unread,
  }
}

/**
 * What to ask Telegram for. With a read watermark the request walks **back from
 * the newest message** and stops at the watermark: the newest `limit` messages
 * of the unread window. The old "last 30 messages" request ignored the watermark
 * and lost unread behind newer outgoing ones, so the chat silently dropped off
 * the glasses list.
 *
 * Without a watermark (a dialog row that did not carry it) the newest messages
 * are the best available answer.
 */
export function messageQuery(entry: PeerEntry, limit: number): { limit: number; minId?: number } {
  const capped = Math.min(Math.max(limit, 1), 50)
  if (entry.readInboxMaxId <= 0) return { limit: capped }
  return {
    minId: entry.readInboxMaxId,
    // Some messages in the window are our own answers; the slack covers them.
    limit: Math.min(Math.max(entry.unread, 1) + 20, 100),
  }
}

/**
 * Older messages below the oldest one already fetched. The LLM needs a
 * transcript even when the whole unread block is one message
 * (`task-v0.5-llm.md` §4 p.7).
 *
 * The anchor is the oldest fetched id, not the read watermark: `offsetId` is
 * exclusive and `minId` is exclusive too, so anchoring at the watermark would
 * drop the watermark message itself - exactly the message the first unread one
 * answers - and would jump over a gap when the unread window was capped at 100.
 */
export function historyQuery(
  anchorId: number,
  limit: number,
): { offsetId: number; limit: number } {
  const capped = Math.min(Math.max(limit, 1), 50)
  return { offsetId: anchorId, limit: capped }
}

/** The oldest real message in a fetched window; 0 when there is none. */
export function oldestMessageId(messages: Array<{ id: number }>): number {
  let oldest = 0
  for (const message of messages) {
    if (message.id > 0 && (oldest === 0 || message.id < oldest)) oldest = message.id
  }
  return oldest
}

/**
 * The other direction: oldest messages after the read watermark. Used only when
 * the newest window turned out to contain too few incoming messages, so a wall
 * of outgoing ones cannot hide the unread block.
 */
export function forwardQuery(entry: PeerEntry): { minId: number; reverse: boolean; limit: number } {
  return {
    minId: entry.readInboxMaxId,
    reverse: true,
    limit: Math.min(Math.max(entry.unread, 1) + 20, 100),
  }
}

function incomingCount(messages: Api.TypeMessage[]): number {
  return messages.filter((message) => message instanceof Api.Message && message.out !== true).length
}

/** Union of two fetched windows by message id (the same message may arrive twice). */
function mergeById(a: Api.TypeMessage[], b: Api.TypeMessage[]): Api.TypeMessage[] {
  const seen = new Set(a.map((message) => messageKey(message)))
  const out = [...a]
  for (const message of b) {
    const key = messageKey(message)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(message)
  }
  return out
}

/**
 * `random_id` from the pair the user repeated, not from the clock: a retry
 * after a timeout sends the same message once, because Telegram drops an
 * identical id. This is the only duplicate protection that needs no history.
 */
export function sendRandomId(chatId: string, messageId: string) {
  const bytes = createHash('sha256').update(`${chatId}\u0000${messageId}`).digest().subarray(0, 8)
  const id = helpers.readBigIntFromBuffer(bytes, false, false)
  return id.isZero() ? id.add(1) : id
}

/**
 * A voice note gets its own namespace. Telegram dedupes a `random_id` across
 * media types, not per kind: reusing the text one made the recording return the
 * text message that was just sent instead of delivering (found live, 27.11).
 * Retries of the voice note still repeat this same id, so they cannot duplicate.
 */
export function voiceRandomId(chatId: string, messageId: string) {
  return sendRandomId(chatId, `${messageId}\u0000voice`)
}

/** The id and time of a sent message out of whichever update Telegram returned. */
export function sentMessageOf(
  updates: Api.TypeUpdates,
): { id: number; date: number } | null {
  if (updates instanceof Api.UpdateShortSentMessage) {
    return { id: updates.id, date: updates.date }
  }
  if (updates instanceof Api.Updates || updates instanceof Api.UpdatesCombined) {
    // A private chat answers with `UpdateNewMessage`, a channel with the
    // channel flavour: both carry the full message, id and server time.
    for (const update of updates.updates) {
      if (update instanceof Api.UpdateNewMessage || update instanceof Api.UpdateNewChannelMessage) {
        const message = update.message
        if (message instanceof Api.Message) return { id: message.id, date: message.date }
      }
    }
    // `UpdateMessageID` has the id but no time; it is the last resort.
    for (const update of updates.updates) {
      if (update instanceof Api.UpdateMessageID) return { id: update.id, date: 0 }
    }
  }
  return null
}

/**
 * The wire answer for a failed send. A foreign id stays `404` (the client's
 * mistake, not a Telegram failure); a flood is logged with its seconds and is
 * never retried automatically; everything else — including a timeout — is a
 * failed send, because the glasses only need the verdict.
 */
export function sendFailureOf(err: unknown, chatId: string, log: Logger): ContractError {
  if (err instanceof errors.FloodWaitError) {
    log.warn('send.flood', { chatId, seconds: err.seconds })
    return new ContractError('send', 502)
  }
  if (err instanceof ContractError && err.status === 404) return err
  log.warn('send.failed', { chatId, rpc: rpcField(err) })
  return new ContractError('send', 502)
}

/**
 * The wire answer for a failed voice send: a foreign id stays `404`, a flood is
 * logged with its seconds and never retried, everything else is `502 send` —
 * the glasses show OFFLINE with a retry that keeps the same `random_id`.
 */
export function voiceFailureOf(err: unknown, chatId: string, log: Logger): ContractError {
  if (err instanceof errors.FloodWaitError) {
    log.warn('voice.flood', { chatId, seconds: err.seconds })
    return new ContractError('send', 502)
  }
  if (err instanceof ContractError && err.status === 404) return err
  log.warn('voice.failed', { chatId, rpc: rpcField(err) })
  return new ContractError('send', 502)
}

/**
 * The `rpc` log field: our own contract code for our own refusals (a bare
 * `ContractError` name says nothing about a timeout), the RPC tag otherwise.
 */
export function rpcField(err: unknown): string {
  return err instanceof ContractError ? err.code : loggableError(err)
}

/**
 * Whether a `messages.getHistory` answer holds exactly this id. With
 * `offsetId = id + 1, limit: 1` the first row is the newest message below the
 * target, so it equals the target only when this dialog has that number.
 */
export function holdsMessage(response: unknown, id: number): boolean {
  if (!response || typeof response !== 'object' || !('messages' in response)) return false
  const rows = (response as { messages?: Array<{ id?: unknown }> }).messages
  return Array.isArray(rows) && rows[0]?.id === id
}

/** A Telegram message id is a positive integer; anything else is not ours. */
const NUMERIC_ID = /^\d{1,20}$/

function messageKey(message: Api.TypeMessage): string {
  return message instanceof Api.Message ? String(message.id) : ''
}

/** One message for the glasses: a stable id, a real timestamp, the whole text. */
export function messageSummaryOf(message: Api.Message): MessageSummary {
  const date = typeof message.date === 'number' ? message.date : 0
  const rawText = (message as { message?: unknown }).message
  return {
    id: String(message.id),
    at: new Date(date * 1000).toISOString(),
    // The preview is cut to one narrow line; the message body is not — the CHAT
    // screen clips it, and FULL TEXT lets the firmware scroll the whole thing.
    text: messageTextOf(message),
    out: message.out === true,
    // `text` is a media word for a photo/sticker/voice: the LLM language rule
    // must not read "Photo" as English.
    media: !(typeof rawText === 'string' && rawText.trim().length > 0),
    // A voice note is the one media kind that becomes text: the page has to
    // know before opening the message (task v0.7 §5).
    ...(isVoiceMessage(message) ? { voice: true } : {}),
  }
}

/** A Telegram voice note (an audio file with `voice: true`), not any audio. */
function isVoiceMessage(message: Api.TypeMessage): boolean {
  const media = (message as { media?: unknown }).media
  if (!(media instanceof Api.MessageMediaDocument)) return false
  const document = media.document
  if (!(document instanceof Api.Document)) return false
  return document.attributes.some(
    (attribute) => attribute instanceof Api.DocumentAttributeAudio && attribute.voice === true,
  )
}

function messageTextOf(message: Api.TypeMessage): string {
  const text = (message as { message?: unknown }).message
  if (typeof text === 'string' && text.trim().length > 0) return screenText(text)
  return previewOf(message)
}

/** Author's newlines stay; other control characters would break the screen. */
function screenText(value: string): string {
  let out = ''
  for (const char of value.replace(/\r\n?/g, '\n')) {
    const code = char.codePointAt(0) ?? 0
    if (char === '\n') out += '\n'
    else if (code < 0x20 || code === 0x7f) out += ' '
    else out += char
  }
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * One line of the last message. Media is a word, not a caption: the glasses
 * have no room for a media dump (`specs/task-v0.4-telegram.md` §7).
 */
export function previewOf(message: Api.TypeMessage): string {
  const text = (message as { message?: unknown }).message
  if (typeof text === 'string' && text.trim().length > 0) return oneLine(text)

  const media = (message as { media?: { className?: string } }).media
  if (!media) {
    return message instanceof Api.MessageService ? 'Service message' : ''
  }

  if (media.className === 'MessageMediaDocument') {
    const doc = (media as { document?: Api.TypeDocument }).document
    if (doc instanceof Api.Document) {
      let audio: string | null = null
      for (const attribute of doc.attributes) {
        if (attribute instanceof Api.DocumentAttributeSticker) return 'Sticker'
        if (attribute instanceof Api.DocumentAttributeAnimated) return 'GIF'
        if (attribute instanceof Api.DocumentAttributeVideo) return 'Video'
        if (attribute instanceof Api.DocumentAttributeAudio) {
          audio = attribute.voice ? 'Voice message' : 'Audio'
        }
      }
      if (audio) return audio
    }
    return 'File'
  }

  switch (media.className) {
    case 'MessageMediaPhoto':
      return 'Photo'
    case 'MessageMediaGeo':
    case 'MessageMediaGeoLive':
    case 'MessageMediaVenue':
      return 'Location'
    case 'MessageMediaContact':
      return 'Contact'
    case 'MessageMediaPoll':
    case 'MessageMediaPollParty':
      return 'Poll'
    case 'MessageMediaDice':
      return 'Dice'
    case 'MessageMediaWebPage':
      return 'Link'
    case 'MessageMediaUnsupported':
      return 'Unsupported message'
    default:
      return 'Media'
  }
}

function oneLine(text: string): string {
  const flat = stripControl(text).replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat
}

