import {
  AuthError,
  type Api,
  type AuthErrorCode,
  type AuthState,
  type ChatSummary,
  type Health,
} from './types'

/**
 * Real backend client. The backend owns Telegram (MTProto through GramJS),
 * the LLM keys and the session; the WebView only sees this API.
 *
 * Endpoints (README.md § API):
 *   GET    /health                 → { backend, llm, checkedAt }
 *   GET    /auth                   → AuthState
 *   POST   /auth/phone   {phone}
 *   POST   /auth/code    {phone, code}
 *   POST   /auth/password{password}
 *   POST   /auth/link              → { step:'link', url, expiresAt }
 *   GET    /auth/link              → { status: 'pending'|'connected'|'expired' }
 *   POST   /auth/logout
 *   DELETE /data
 *   GET    /chats                  → ChatSummary[]
 *   PUT    /settings               { lang, quickReply, tone, selectedChats, llmModel }
 *   POST   /llm/key      {apiKey}  → the backend validates and stores the key
 *
 * The LLM key travels one way: into the backend. It is never written to
 * localStorage and never comes back through this client.
 *
 * The session token is issued by the backend after a successful login and kept
 * in localStorage. It is a token for our backend only — never a Telegram
 * session, never api_hash.
 */

const TOKEN_KEY = 'teleglass.token'
const TIMEOUT_MS = 10_000
const ERROR_CODES: readonly AuthErrorCode[] = [
  'wrongCode',
  'expiredCode',
  'tooMany',
  'wrongPassword',
  'network',
  'linkExpired',
  'unknown',
]

function token(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

function setToken(value: unknown): void {
  if (typeof value !== 'string' || value.length === 0) return
  try {
    window.localStorage.setItem(TOKEN_KEY, value)
  } catch {
    /* the session still works until the WebView is unloaded */
  }
}

function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* nothing to clear */
  }
}

async function request<T>(base: string, path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS)
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  const auth = token()
  if (auth) headers.set('Authorization', `Bearer ${auth}`)

  let response: Response
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
      credentials: 'omit',
    })
  } catch {
    throw new AuthError('network')
  } finally {
    window.clearTimeout(timer)
  }

  if (response.status === 401) clearToken()

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }

  if (!response.ok) {
    const raw =
      body && typeof body === 'object' && 'error' in body
        ? (body as { error?: unknown }).error
        : undefined
    const code = ERROR_CODES.find((c) => c === raw) ?? 'unknown'
    throw new AuthError(code)
  }

  return body as T
}

function isStep(value: unknown): value is AuthState['step'] {
  return (
    value === 'idle' ||
    value === 'code' ||
    value === 'password' ||
    value === 'link' ||
    value === 'connected'
  )
}

/** The backend answers `{ step, ... }`; anything else is an idle session. */
function asAuthState(body: unknown): AuthState {
  if (!body || typeof body !== 'object') return { step: 'idle' }
  const raw = body as Record<string, unknown>
  setToken(raw.token)
  const step = raw.step
  if (!isStep(step)) return { step: 'idle' }
  if (step === 'code') {
    return {
      step,
      phone: typeof raw.phone === 'string' ? raw.phone : '',
      resendAt: typeof raw.resendAt === 'number' ? raw.resendAt : 0,
    }
  }
  if (step === 'password') {
    return { step, phone: typeof raw.phone === 'string' ? raw.phone : '' }
  }
  if (step === 'link') {
    return {
      step,
      url: typeof raw.url === 'string' ? raw.url : '',
      expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : 0,
    }
  }
  return { step }
}

function asLevel(value: unknown): Health['backend'] {
  return value === 'ok' || value === 'off' || value === 'error' ? value : 'error'
}

export function createRealApi(base: string): Api {
  return {
    demo: false,

    async health(): Promise<Health> {
      const h = await request<Record<string, unknown>>(base, '/health')
      return {
        backend: asLevel(h.backend),
        llm: asLevel(h.llm),
        checkedAt: typeof h.checkedAt === 'string' ? h.checkedAt : new Date().toISOString(),
      }
    },

    async auth(): Promise<AuthState> {
      try {
        return asAuthState(await request(base, '/auth'))
      } catch (err) {
        if (err instanceof AuthError && err.code === 'network') throw err
        return { step: 'idle' }
      }
    },

    async sendCode(phone) {
      return asAuthState(
        await request(base, '/auth/phone', { method: 'POST', body: JSON.stringify({ phone }) }),
      )
    },

    async verifyCode(phone, code) {
      return asAuthState(
        await request(base, '/auth/code', {
          method: 'POST',
          body: JSON.stringify({ phone, code }),
        }),
      )
    },

    async verifyPassword(password) {
      return asAuthState(
        await request(base, '/auth/password', {
          method: 'POST',
          body: JSON.stringify({ password }),
        }),
      )
    },

    async startLink() {
      const state = asAuthState(await request(base, '/auth/link', { method: 'POST' }))
      if (state.step !== 'link') throw new AuthError('unknown')
      return state
    },

    async linkState() {
      const body = await request<Record<string, unknown>>(base, '/auth/link')
      if (body.status === 'connected') return 'connected'
      if (body.status === 'expired') return 'expired'
      return 'pending'
    },

    async logout() {
      await request(base, '/auth/logout', { method: 'POST' })
      clearToken()
    },

    async deleteAll() {
      await request(base, '/data', { method: 'DELETE' })
      clearToken()
    },

    async chats(): Promise<ChatSummary[]> {
      const rows = await request<unknown>(base, '/chats')
      if (!Array.isArray(rows)) return []
      return rows.flatMap((row) => {
        if (!row || typeof row !== 'object') return []
        const r = row as Record<string, unknown>
        if (typeof r.id !== 'string' || typeof r.title !== 'string') return []
        return [
          {
            id: r.id,
            title: r.title,
            preview: typeof r.preview === 'string' ? r.preview : '',
          },
        ]
      })
    },

    async putSettings(payload) {
      await request(base, '/settings', { method: 'PUT', body: JSON.stringify(payload) })
    },

    async setLlmKey(apiKey) {
      await request(base, '/llm/key', { method: 'POST', body: JSON.stringify({ apiKey }) })
    },
  }
}
