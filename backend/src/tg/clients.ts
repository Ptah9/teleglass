/**
 * Live Telegram clients, one per purpose:
 *
 * - a **pending** client exists while a login is in progress and MUST stay alive
 *   between requests: `signIn` needs the same auth key as `sendCode`, and the
 *   second `exportLoginToken` needs the same key as the first;
 * - a **session** client is created once per stored session and reused for every
 *   later HTTP request — no new connection per call.
 *
 * Retries are intentionally off: `requestRetries: 1` means exactly one attempt,
 * so the library never re-sends `auth.sendCode`/`auth.signIn` behind our back.
 * The one repeat we do implement ourselves is a DC migration (`PHONE_MIGRATE_X`
 * / `NETWORK_MIGRATE_X`), because that request was rejected, not executed.
 * `floodSleepThreshold: 0` makes short flood waits surface as `tooMany` instead
 * of sleeping past the WebView's 10 s timeout.
 */

import {
  MTProxyTransport,
  SocksTransport,
  TelegramClient,
  type Transport,
} from 'teleproto'
import { StringSession } from 'teleproto/sessions'
import type { Config } from '../config.js'

/**
 * Every client here is backed by a `StringSession`, because that is the only
 * representation the task allows in SQLite.
 */
export type TgClient = TelegramClient<StringSession>

const APP_VERSION = '0.4.0'
const CONNECT_TIMEOUT_S = 8

export class ClientRegistry {
  private readonly sessionClients = new Map<string, TgClient>()
  private readonly connecting = new Map<string, Promise<boolean>>()
  private readonly transport: Transport | undefined

  constructor(private readonly config: Config) {
    this.transport = buildTransport(config)
  }

  /** A fresh unauthenticated client for one login attempt. */
  createPending(): TgClient {
    return this.create(new StringSession(''), false)
  }

  /** Hands the pending client over to the session registry after a success. */
  adopt(sessionId: string, client: TgClient): void {
    const existing = this.sessionClients.get(sessionId)
    if (existing && existing !== client) {
      void existing.destroy().catch(() => undefined)
    }
    this.sessionClients.set(sessionId, client)
  }

  /**
   * The client for a stored session, connected lazily. Reconnects are handled by
   * the same instance, so the auth key and update state stay in one place.
   */
  async forSession(sessionId: string, sessionString: string): Promise<TgClient> {
    let client = this.sessionClients.get(sessionId)
    if (!client) {
      client = this.create(new StringSession(sessionString), true)
      this.sessionClients.set(sessionId, client)
    }
    if (client.connected) return client

    let pending = this.connecting.get(sessionId)
    if (!pending) {
      pending = client.connect()
      this.connecting.set(sessionId, pending)
      pending.finally(() => this.connecting.delete(sessionId)).catch(() => undefined)
    }
    await pending
    return client
  }

  /** Drops the client of a session (logout, dead key, delete-all). */
  forget(sessionId: string): void {
    const client = this.sessionClients.get(sessionId)
    if (!client) return
    this.sessionClients.delete(sessionId)
    void client.destroy().catch(() => undefined)
  }

  async destroyAll(): Promise<void> {
    const clients = [...this.sessionClients.values()]
    this.sessionClients.clear()
    this.connecting.clear()
    await Promise.all(clients.map((client) => client.destroy().catch(() => undefined)))
  }

  private create(session: StringSession, autoReconnect: boolean): TgClient {
    return new TelegramClient<StringSession>(
      session,
      this.config.apiId,
      this.config.apiHash,
      {
        testServers: this.config.testDc,
        connectionRetries: 2,
        requestRetries: 1,
        floodSleepThreshold: 0,
        autoReconnect,
        catchUp: false,
        timeout: CONNECT_TIMEOUT_S,
        deviceModel: 'Teleglass',
        systemVersion: process.platform,
        appVersion: APP_VERSION,
        langCode: 'en',
        systemLangCode: 'en',
        ...(this.transport ? { transport: this.transport } : {}),
      },
    ) as TgClient
  }
}

function buildTransport(config: Config): Transport | undefined {
  if (config.mtProxy) {
    const match = /^([^:]+):(\d+):(.+)$/.exec(config.mtProxy)
    if (!match) throw new Error('TG_MT_PROXY must be host:port:secret')
    const [, host, port, secret] = match
    if (!host || !port || !secret) throw new Error('TG_MT_PROXY must be host:port:secret')
    return new MTProxyTransport({ host, port: Number(port), secret })
  }
  if (config.socksProxy) {
    let url: URL
    try {
      url = new URL(config.socksProxy)
    } catch {
      throw new Error('TG_PROXY must be socks5://[user:pass@]host:port')
    }
    if (url.protocol !== 'socks5:' && url.protocol !== 'socks4:') {
      throw new Error('TG_PROXY supports socks5:// and socks4:// only')
    }
    const port = Number(url.port || (url.protocol === 'socks4:' ? 1080 : 1080))
    if (!Number.isInteger(port) || port <= 0) throw new Error('TG_PROXY port is invalid')
    return new SocksTransport({
      host: url.hostname,
      port,
      version: url.protocol === 'socks4:' ? 4 : 5,
      ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    })
  }
  return undefined
}
