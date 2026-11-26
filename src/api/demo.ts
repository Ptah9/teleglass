import { chatLabel } from '../state/reducer'
import { MOCK_CHATS } from '../state/data'
import { hasDemoFlag } from './demo-flags'
import {
  AuthError,
  type Api,
  type AuthState,
  type ChatSummary,
  type Health,
  type MessageSummary,
} from './types'

/**
 * In-app demo. Used when no backend answers `/api/health` (or when a build
 * explicitly points here). It is labelled `Demo` on the settings screen and in
 * the auth header — it must never look like a working Telegram connection.
 *
 * What is real here: the screens, the state machine, persistence across a
 * WebView restart. What is not: Telegram, the code, the password and the link.
 * The code `123456` is printed on the code screen for exactly this reason.
 */

const AUTH_KEY = 'teleglass.demo.auth.v1'
const CODE_OK = '123456'
/** A second reserved code, so the expired-code screen is reachable. */
const CODE_EXPIRED = '000000'
const MAX_ATTEMPTS = 3
const LINK_MS = 30_000

interface StoredAuth {
  step: 'idle' | 'code' | 'password' | 'link' | 'connected'
  phone?: string
  resendAt?: number
  expiresAt?: number
  attempts?: number
  linkToken?: string
}

function read(): StoredAuth {
  try {
    const raw = window.localStorage.getItem(AUTH_KEY)
    if (!raw) return { step: 'idle' }
    const parsed = JSON.parse(raw) as StoredAuth
    const steps = ['idle', 'code', 'password', 'link', 'connected'] as const
    return steps.includes(parsed.step) ? parsed : { step: 'idle' }
  } catch {
    return { step: 'idle' }
  }
}

function write(next: StoredAuth): void {
  try {
    window.localStorage.setItem(AUTH_KEY, JSON.stringify(next))
  } catch {
    /* the demo still works for this session */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function publicState(s: StoredAuth): AuthState {
  switch (s.step) {
    case 'code':
      return { step: 'code', phone: s.phone ?? '', resendAt: s.resendAt ?? 0 }
    case 'password':
      return { step: 'password', phone: s.phone ?? '' }
    case 'link':
      return {
        step: 'link',
        url: `tg://login?token=${s.linkToken ?? ''}`,
        expiresAt: s.expiresAt ?? 0,
      }
    case 'connected':
      return { step: 'connected' }
    default:
      return { step: 'idle' }
  }
}

function network(): never {
  throw new AuthError('network', 'demo: no backend')
}

export function createDemoApi(): Api {
  return {
    demo: true,

    async health(): Promise<Health> {
      await sleep(320)
      if (hasDemoFlag('status-error')) {
        return { backend: 'error', llm: 'off', checkedAt: new Date().toISOString() }
      }
      return { backend: 'demo', llm: 'off', checkedAt: new Date().toISOString() }
    },

    async auth(): Promise<AuthState> {
      await sleep(180)
      return publicState(read())
    },

    async sendCode(phone: string): Promise<AuthState> {
      await sleep(700)
      if (hasDemoFlag('network')) network()
      const next: StoredAuth = {
        step: 'code',
        phone,
        resendAt: Date.now() + LINK_MS,
        attempts: 0,
      }
      write(next)
      return publicState(next)
    },

    async verifyCode(phone: string, code: string): Promise<AuthState> {
      await sleep(700)
      if (hasDemoFlag('network')) network()
      const current = read()
      if (code === CODE_EXPIRED) throw new AuthError('expiredCode')

      if (code !== CODE_OK) {
        const attempts = (current.attempts ?? 0) + 1
        write({ ...current, step: 'code', phone, attempts })
        throw new AuthError(attempts >= MAX_ATTEMPTS ? 'tooMany' : 'wrongCode')
      }

      const next: StoredAuth = { step: 'password', phone, attempts: 0 }
      write(next)
      return publicState(next)
    },

    async verifyPassword(password: string): Promise<AuthState> {
      await sleep(700)
      if (hasDemoFlag('network')) network()
      if (password.trim().length === 0) throw new AuthError('wrongPassword')
      const next: StoredAuth = { step: 'connected', phone: read().phone }
      write(next)
      return publicState(next)
    },

    async startLink() {
      await sleep(450)
      if (hasDemoFlag('network')) network()
      const linkToken = Math.random().toString(36).slice(2, 12)
      const expiresAt = Date.now() + LINK_MS
      write({ step: 'link', linkToken, expiresAt })
      return {
        step: 'link' as const,
        url: `tg://login?token=${linkToken}`,
        expiresAt,
      }
    },

    async linkState() {
      const s = read()
      if (s.step === 'connected') return 'connected'
      if (s.step !== 'link') return 'expired'
      // `?demo=link-connected` simulates the confirmation in Telegram two
      // seconds after the link was issued; without the flag the link only
      // expires — no fake success.
      const issuedAt = (s.expiresAt ?? 0) - LINK_MS
      if (hasDemoFlag('link-connected') && Date.now() - issuedAt >= 2_000) {
        write({ step: 'connected' })
        return 'connected'
      }
      if ((s.expiresAt ?? 0) <= Date.now()) return 'expired'
      return 'pending'
    },

    async logout(): Promise<void> {
      await sleep(300)
      write({ step: 'idle' })
    },

    async deleteAll(): Promise<void> {
      await sleep(500)
      write({ step: 'idle' })
    },

    async chats(): Promise<ChatSummary[]> {
      await sleep(hasDemoFlag('chats-loading') ? 60_000 : 550)
      if (hasDemoFlag('chats-error')) throw new AuthError('network')
      if (hasDemoFlag('chats-empty')) return []
      return MOCK_CHATS.map((chat) => ({
        id: chat.id,
        title: chatLabel(chat),
        preview: chat.messages[chat.messages.length - 1]?.text ?? '',
      }))
    },

    async messages(chatId: string): Promise<MessageSummary[]> {
      await sleep(120)
      const chat = MOCK_CHATS.find((item) => item.id === chatId)
      if (!chat) return []
      return chat.messages.map((message) => ({
        id: message.id,
        at: message.at,
        text: message.text,
        out: false,
      }))
    },

    async putSettings(): Promise<void> {
      // Nothing to mirror: the glasses read the same WebView state directly.
      await sleep(80)
    },

    async setLlmKey(): Promise<void> {
      // No backend: the key is deliberately not stored anywhere. The screen
      // says so instead of pretending the key was saved.
      await sleep(400)
    },
  }
}
