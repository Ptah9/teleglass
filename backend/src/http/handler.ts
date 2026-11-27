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
import type { LlmApi } from '../llm/service.js'
import type { AuthService } from '../service.js'
import type { SttApi } from '../stt/service.js'
import type { VoiceApi } from '../voice/service.js'

export interface HandlerDeps {
  auth: AuthService
  llm: LlmApi
  stt: SttApi
  voice: VoiceApi
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

  if (method === 'POST') {
    const action = chatActionPath(path)
    if (action !== null) {
      // The contract says "no session — 401": without credentials the body is
      // not the first thing to judge.
      if (!token) throw new ContractError('unknown', 401)
      if (action.action === 'send') {
        const body = parseJson(request.body)
        const messageId = requireString(body, 'messageId')
        // A number that long cannot exist in any dialog: the same answer as a
        // foreign id, not a shape error.
        if (messageId.length > 32) throw new ContractError('unknown', 404)
        const text = requireText(body, 'text')
        return json(200, await deps.auth.sendReply(token, action.chatId, messageId, text))
      }
      if (action.action === 'voice') {
        const body = parseJson(request.body)
        const messageId = requireString(body, 'messageId')
        if (messageId.length > 32) throw new ContractError('unknown', 404)
        const audio = requireLongString(body, 'audio')
        return json(200, await deps.voice.send(token, action.chatId, messageId, audio))
      }
      const body = parseJson(request.body)
      if ('messageId' in body) {
        // A present but non-string id is a client bug, not "the whole chat".
        await deps.auth.markRead(token, action.chatId, requireString(body, 'messageId'))
      } else {
        await deps.auth.markChatRead(token, action.chatId)
      }
      return noContent()
    }

    const transcript = transcribePath(path)
    if (transcript !== null) {
      if (!token) throw new ContractError('unknown', 401)
      return json(
        200,
        await deps.stt.transcribeMessage(token, transcript.chatId, transcript.messageId),
      )
    }
  }

  switch (route) {
    case 'GET /health': {
      const health = await deps.auth.health()
      // The LLM status is the LLM's own: a key in the database is not proof
      // that the provider answers (and `.env` may hold the key instead).
      return json(200, { ...health, llm: deps.llm.status() })
    }

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

    case 'POST /stt': {
      if (!token) throw new ContractError('unknown', 401)
      const body = parseJson(request.body)
      const audio = requireLongString(body, 'audio')
      const format = requireString(body, 'format')
      return json(200, await deps.stt.transcribe(token, audio, format))
    }

    case 'GET /llm/models':
      return json(200, deps.llm.models(token))

    case 'POST /llm/replies': {
      const body = parseJson(request.body)
      const chatId = requireString(body, 'chatId')
      const messageId = requireString(body, 'messageId')
      if (chatId.length > 96 || messageId.length > 32) throw new ContractError('unknown')
      return json(200, await deps.llm.replies(token, chatId, messageId))
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

/** 204: the read mark has no body, and the client does not need one. */
function noContent(): OutgoingResponse {
  return {
    status: 204,
    headers: { 'Cache-Control': 'no-store' },
    body: '',
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

/**
 * `/chats/<id>/send`, `/read` and `/voice` — the POST routes that carry a chat
 * id. Percent-encoded for the same reason as `messagesPath`.
 */
function chatActionPath(
  path: string,
): { chatId: string; action: 'send' | 'read' | 'voice' } | null {
  const match = /^\/chats\/([^/]+)\/(send|read|voice)$/.exec(path)
  if (!match?.[1] || !match[2]) return null
  try {
    const chatId = decodeURIComponent(match[1])
    if (chatId.length === 0 || chatId.length > 96) return null
    const action = match[2] === 'send' ? 'send' : match[2] === 'voice' ? 'voice' : 'read'
    return { chatId, action }
  } catch {
    return null
  }
}

/** `/chats/<id>/messages/<messageId>/transcribe`. */
function transcribePath(path: string): { chatId: string; messageId: string } | null {
  const match = /^\/chats\/([^/]+)\/messages\/([^/]+)\/transcribe$/.exec(path)
  if (!match?.[1] || !match[2]) return null
  try {
    const chatId = decodeURIComponent(match[1])
    const messageId = decodeURIComponent(match[2])
    if (chatId.length === 0 || chatId.length > 96) return null
    if (messageId.length === 0 || messageId.length > 32) return null
    return { chatId, messageId }
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

/**
 * An audio body is not a setting: the 120 s cap is ~3.8 MB of PCM, ~5.1 MB of
 * base64. The HTTP server caps the whole request above that.
 */
const MAX_AUDIO_FIELD = 5_300_000

function requireLongString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_AUDIO_FIELD) {
    throw new ContractError('unknown', 400)
  }
  return value
}

/**
 * A reply body: up to Telegram's 4096 characters, and a blank one is a client
 * bug (`400`), not a message to send.
 */
function requireText(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  // Limits apply to what would actually be sent: the text is trimmed by the
  // service, so 5000 characters of padding around a short line are legal.
  const clean = typeof value === 'string' ? value.trim() : ''
  if (clean.length === 0 || clean.length > 4096) throw new ContractError('unknown', 400)
  return clean
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
