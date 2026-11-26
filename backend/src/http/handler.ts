/**
 * HTTP layer. It knows nothing about Telegram: every route calls `AuthService`.
 *
 * In: method, path, headers, raw body. Out: status, headers, body.
 * The shape of a failure is always `{ "error": "<one of the seven codes>" }`.
 *
 * `/api` is accepted as an optional prefix because the WebView's default base is
 * `/api` (same origin); the routes themselves are the ones from the contract.
 */

import {
  ContractError,
  type AuthErrorCode,
  type SettingsPayload,
} from '../contract.js'
import type { Logger } from '../log.js'
import { errorTag } from '../log.js'
import type { AuthService } from '../service.js'

export interface HandlerDeps {
  auth: AuthService
  log: Logger
  corsOrigins: string[]
}

export interface IncomingRequest {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

export interface OutgoingResponse {
  status: number
  headers: Record<string, string>
  body: string
}

const ALLOW_METHODS = 'GET, POST, PUT, DELETE, OPTIONS'
const ALLOW_HEADERS = 'Authorization, Content-Type, Accept'

export async function handle(
  deps: HandlerDeps,
  request: IncomingRequest,
): Promise<OutgoingResponse> {
  const started = Date.now()
  const method = request.method.toUpperCase()
  const path = routePath(request.path)
  const cors = corsHeaders(deps.corsOrigins, header(request, 'origin'))

  if (method === 'OPTIONS') {
    return {
      status: 204,
      headers: {
        ...cors,
        'Access-Control-Allow-Methods': ALLOW_METHODS,
        'Access-Control-Allow-Headers': ALLOW_HEADERS,
        'Access-Control-Max-Age': '600',
      },
      body: '',
    }
  }

  let response: OutgoingResponse
  try {
    response = await dispatch(deps, request, method, path)
  } catch (err) {
    response = failure(deps, err)
  }

  deps.log.info('http', { method, path, status: response.status, ms: Date.now() - started })
  return { ...response, headers: { ...cors, ...response.headers } }
}

async function dispatch(
  deps: HandlerDeps,
  request: IncomingRequest,
  method: string,
  path: string,
): Promise<OutgoingResponse> {
  const token = bearer(request)
  const route = `${method} ${path}`

  if (method === 'GET') {
    const chatId = messagesPath(path)
    if (chatId !== null) return json(200, await deps.auth.messages(token, chatId))
  }

  switch (route) {
    case 'GET /health':
      return json(200, await deps.auth.health())

    case 'GET /auth':
      return json(200, await deps.auth.state(token))

    case 'POST /auth/phone': {
      const body = parseJson(request.body)
      const phone = requireString(body, 'phone')
      return json(200, await deps.auth.sendCode(phone))
    }

    case 'POST /auth/code': {
      const body = parseJson(request.body)
      const phone = requireString(body, 'phone')
      const code = requireString(body, 'code')
      return json(200, await deps.auth.verifyCode(phone, code))
    }

    case 'POST /auth/password': {
      const body = parseJson(request.body)
      const password = requireString(body, 'password')
      return json(200, await deps.auth.verifyPassword(password))
    }

    case 'POST /auth/link':
      return json(200, await deps.auth.startLink())

    case 'GET /auth/link':
      return json(200, await deps.auth.linkState(token))

    case 'POST /auth/logout':
      await deps.auth.logout(token)
      return json(200, { ok: true })

    case 'DELETE /data':
      await deps.auth.deleteAll(token)
      return json(200, { ok: true })

    case 'GET /chats':
      return json(200, await deps.auth.chats(token))

    case 'PUT /settings': {
      const body = parseJson(request.body)
      const payload = readSettings(body)
      await deps.auth.putSettings(token, payload)
      return json(200, { ok: true })
    }

    case 'POST /llm/key': {
      const body = parseJson(request.body)
      const apiKey = requireString(body, 'apiKey')
      await deps.auth.setLlmKey(token, apiKey)
      return json(200, { ok: true })
    }

    default:
      return json(404, { error: 'unknown' satisfies AuthErrorCode })
  }
}

function failure(deps: HandlerDeps, err: unknown): OutgoingResponse {
  if (err instanceof ContractError) {
    return json(err.status, { error: err.code })
  }
  deps.log.error('http.failed', { rpc: errorTag(err) })
  return json(500, { error: 'unknown' satisfies AuthErrorCode })
}

function json(status: number, value: unknown): OutgoingResponse {
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
    body: JSON.stringify(value),
  }
}

function routePath(raw: string): string {
  let path = raw.split('?')[0] ?? '/'
  if (path === '/api' || path.startsWith('/api/')) path = path.slice(4)
  if (path.length > 1) path = path.replace(/\/+$/, '')
  return path.length > 0 ? path : '/'
}

/**
 * `/chats/<id>/messages` — the only route with a parameter. The id travels
 * percent-encoded (`user%3A123`) because the client builds it with
 * `encodeURIComponent`, so it is decoded here.
 */
function messagesPath(path: string): string | null {
  const match = /^\/chats\/([^/]+)\/messages$/.exec(path)
  if (!match?.[1]) return null
  try {
    const chatId = decodeURIComponent(match[1])
    return chatId.length > 0 && chatId.length <= 96 ? chatId : null
  } catch {
    return null
  }
}

function header(request: IncomingRequest, name: string): string | null {
  const value = request.headers[name] ?? request.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function bearer(request: IncomingRequest): string | null {
  const raw = header(request, 'authorization')
  if (!raw) return null
  const match = /^Bearer\s+(\S+)$/i.exec(raw.trim())
  return match?.[1] ?? null
}

function corsHeaders(origins: string[], origin: string | null): Record<string, string> {
  if (!origin || !origins.includes(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
  }
}

function parseJson(raw: string): Record<string, unknown> {
  if (raw.trim().length === 0) return {}
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new ContractError('unknown')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError('unknown')
  }
  return value as Record<string, unknown>
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new ContractError('unknown')
  }
  return value
}

function readSettings(body: Record<string, unknown>): SettingsPayload {
  const lang = requireString(body, 'lang')
  const quickReply = requireString(body, 'quickReply')
  const tone = requireString(body, 'tone')
  const llmModel = requireString(body, 'llmModel')

  if (lang.length > 8 || quickReply.length > 200 || tone.length > 40 || llmModel.length > 64) {
    throw new ContractError('unknown')
  }

  const selectedChats = body.selectedChats
  if (selectedChats === null) {
    return { lang, quickReply, tone, selectedChats: null, llmModel }
  }
  if (!Array.isArray(selectedChats) || selectedChats.length > 200) {
    throw new ContractError('unknown')
  }
  const chats: string[] = []
  for (const id of selectedChats) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
      throw new ContractError('unknown')
    }
    chats.push(id)
  }
  return { lang, quickReply, tone, selectedChats: chats, llmModel }
}
