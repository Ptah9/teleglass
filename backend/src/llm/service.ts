/**
 * The LLM part of the product: language of the answered message, tone from the
 * phone, a bounded transcript, a validated JSON answer and a 24-hour cache.
 *
 * It knows Telegram only through `AuthService.messages`: the context is the
 * same window the glasses show, so nothing about the account (name, phone,
 * user id, chat title) can leak into the prompt.
 *
 * Failures are honest: a provider error, a timeout or a reply that does not
 * match the schema becomes `{error:"llm"}` / HTTP 502, and the glasses say
 * NO REPLIES. A blank `content` is an error, never "no options".
 */

import { createHash } from 'node:crypto'
import { measureTextWrap } from '@evenrealities/pretext'
import type { Config } from '../config.js'
import {
  ContractError,
  type Health,
  type LlmModels,
  type LlmReply,
  type MessageSummary,
} from '../contract.js'
import type { Db } from '../db.js'
import { decrypt } from '../crypto.js'
import type { Logger } from '../log.js'
import type { AuthService } from '../service.js'
import { hashToken } from '../tokens.js'
import { raceTimeout } from '../timeout.js'
import { langOf, type PromptLang } from './lang.js'
import {
  promptMessages,
  toneOf,
  langOfSettings,
  contextWindow,
  type Tone,
} from './prompt.js'
import { createOpenAiClient, LlmError, type LlmClient } from './provider.js'

/** The WebView gives up at 10 s; the whole LLM call must be over sooner. */
export const LLM_BUDGET_MS = 8_000
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const CONTEXT_FETCH = 30
const SUMMARY_CHARS = 90
const REPLY_CHARS = 120
/** `/llm/replies` budget: one minute and at most this many admissions. */
const WINDOW_MS = 60_000
const LIMIT_PER_WINDOW = 20
/** Above this many session keys, fully expired windows are dropped. */
const PRUNE_AT = 256
/** Text width of the CHAT body; "long" is the same 5-line rule as on the glasses. */
const TEXT_PX = 536
const BODY_LINES = 5

const MODEL_LABELS: Record<string, string> = {
  'deepseek-flash': 'DeepSeek Flash',
  'deepseek-v4-flash': 'DeepSeek V4 Flash',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'deepseek-chat': 'DeepSeek Chat',
  'gpt-4o-mini': 'GPT-4o mini',
  'gpt-4.1-mini': 'GPT-4.1 mini',
}

export interface LlmApi {
  /** Real `/health.llm`: `off` without a key, `error` after a refusal. */
  status(): Health['llm']
  models(token: string | null): LlmModels
  replies(token: string | null, chatId: string, messageId: string): Promise<LlmReply>
}

export interface LlmServiceDeps {
  config: Config
  db: Db
  log: Logger
  /** Only `messages` and `unreadCount` are used: the LLM cannot reach Telegram. */
  auth: Pick<AuthService, 'messages' | 'unreadCount'>
  /** Tests inject a fake provider; production builds one from `.env`. */
  client?: LlmClient
}

export class LlmService implements LlmApi {
  private readonly config: Config
  private readonly db: Db
  private readonly log: Logger
  private readonly auth: Pick<AuthService, 'messages' | 'unreadCount'>
  private readonly injected: LlmClient | null
  /** Last provider verdict; `null` = no refusal since the process started. */
  private lastFailure: string | null = null
  /** Requests in flight, keyed by session and chat (`admit`). */
  private readonly inFlight = new Set<string>()
  /** Start times of admitted requests, per session, for the one-minute window. */
  private readonly recent = new Map<string, number[]>()

  constructor(deps: LlmServiceDeps) {
    this.config = deps.config
    this.db = deps.db
    this.log = deps.log
    this.auth = deps.auth
    this.injected = deps.client ?? null
  }

  status(): Health['llm'] {
    if (!this.ready() || this.resolveKey(false) === null) return 'off'
    return this.lastFailure === null ? 'ok' : 'error'
  }

  models(token: string | null): LlmModels {
    const list = this.config.llmModels.map((id) => ({ id, label: MODEL_LABELS[id] ?? id }))
    const sessionId = this.sessionIdOf(token)
    const stored = sessionId ? this.db.getSettings(sessionId)?.llm_model ?? '' : ''
    const current = list.some((model) => model.id === stored)
      ? stored
      : this.config.llmModel ?? list[0]?.id ?? ''
    if (list.length === 0 && current !== '') list.push({ id: current, label: MODEL_LABELS[current] ?? current })
    return { models: list, current }
  }

  async replies(token: string | null, chatId: string, messageId: string): Promise<LlmReply> {
    const started = Date.now()
    const sessionId = this.sessionIdOf(token)
    if (!sessionId) throw new ContractError('unknown', 401)

    // The glasses' retry button must not turn into a money loop: one request in
    // flight per chat and at most twenty a minute per session.
    const release = this.admit(sessionId, chatId, started)
    try {
      return await this.generate(token, sessionId, chatId, messageId, started)
    } finally {
      release()
    }
  }

  /** Reserves a slot or throws `429 llm` when the caller is over the limit. */
  private admit(sessionId: string, chatId: string, now: number): () => void {
    const key = `${sessionId}\u0000${chatId}`
    if (this.inFlight.has(key)) throw new ContractError('llm', 429)

    // A key per session would live forever; once the map is worth cleaning,
    // drop the sessions whose whole window has expired.
    if (this.recent.size >= PRUNE_AT) {
      for (const [id, times] of this.recent) {
        if (times.every((at) => now - at >= WINDOW_MS)) this.recent.delete(id)
      }
    }

    const recent = (this.recent.get(sessionId) ?? []).filter((at) => now - at < WINDOW_MS)
    if (recent.length >= LIMIT_PER_WINDOW) {
      this.recent.set(sessionId, recent)
      this.log.warn('llm.rateLimited', { requests: recent.length })
      throw new ContractError('llm', 429)
    }
    recent.push(now)
    this.recent.set(sessionId, recent)
    this.inFlight.add(key)
    return () => this.inFlight.delete(key)
  }

  private async generate(
    token: string | null,
    sessionId: string,
    chatId: string,
    messageId: string,
    started: number,
  ): Promise<LlmReply> {
    const deadline = started + LLM_BUDGET_MS

    // No key — no request at all, not even to Telegram.
    const apiKey = this.resolveKey()
    if (apiKey === null || !this.ready()) {
      this.log.warn('llm.notConfigured', {})
      throw new ContractError('llm', 502)
    }

    const settings = this.db.getSettings(sessionId)
    const tone = toneOf(settings?.tone)
    const fallbackLang = langOfSettings(settings?.lang)
    const model = this.modelOf(settings?.llm_model)

    let messages: MessageSummary[]
    try {
      const raced = await raceTimeout(
        this.auth.messages(token, chatId, CONTEXT_FETCH, true),
        Math.max(1, deadline - Date.now()),
      )
      if (raced.timedOut) {
        this.fail('timeout', model, started)
        throw new ContractError('llm', 502)
      }
      messages = raced.value
    } catch (err) {
      if (err instanceof ContractError) throw err
      this.fail('network', model, started)
      throw new ContractError('llm', 502)
    }

    const index = messages.findIndex((message) => message.id === messageId)
    if (index < 0) throw new ContractError('unknown', 404)
    // A voice note reaches us as the media word "Voice message". Its transcript
    // is asked for by the CHAT screen before the options and cached by the STT
    // service (task v0.7 §10: the screen first), so the options answer the spoken
    // words instead of guessing from the neighbours. No cache — no transcription
    // here: the LLM never downloads audio on its own.
    const known = messages.map((message) => {
      if (!message.voice) return message
      const cachedText = this.db.getSttCache(chatId, message.id)?.text
      return cachedText ? { ...message, text: cachedText, media: false } : message
    })
    const target = known[index] as MessageSummary
    // The label and the transcript are different questions: an answer already
    // cached for "Voice message" must not be served once the words are known.
    const transcribed = target.text !== messages[index]?.text

    const lang = langOf(known, index, fallbackLang)
    // Telethon counts the unread block; §4 p.7 shrinks the transcript when it is
    // small (`unread + 5`), so a one-message chat does not pay for nine
    // unrelated lines.
    const unread = (await this.auth.unreadCount?.(token, chatId)) ?? 0
    const transcript = known.slice(
      Math.max(0, index + 1 - contextWindow(unread)),
      index + 1,
    )
    const long = isLong(target.text)
    const prompt = promptMessages(lang, tone, long, transcript)
    const promptChars = prompt.reduce((sum, message) => sum + message.content.length, 0)

    const cacheKey =
      cacheKeyOf(chatId, messageId, tone, model, lang) + (transcribed ? ':transcript' : '')
    const cached = this.db.getLlmCache(cacheKey, started - CACHE_TTL_MS)
    if (cached) {
      this.log.info('llm.request', {
        model,
        promptChars,
        ms: Date.now() - started,
        cache: true,
      })
      return cached
    }

    const client = this.injected ?? createOpenAiClient(this.baseUrl(), apiKey)
    let answer: LlmReply | null = null
    for (let attempt = 0; attempt < 2 && answer === null; attempt++) {
      let content: string
      try {
        content = await client.complete(prompt, {
          model,
          timeoutMs: deadline - Date.now(),
        })
      } catch (err) {
        const reason = err instanceof LlmError ? err.reason : 'network'
        // `content: null` is an empty answer, not a transport failure: it gets
        // the same single retry as whitespace, then `llm.badjson`.
        if (reason === 'empty') {
          this.log.warn('llm.empty', { model, ms: Date.now() - started })
          continue
        }
        this.fail(reason, model, started)
        throw new ContractError('llm', 502)
      }
      answer = parseAnswer(content, long)
    }

    if (answer === null) {
      this.lastFailure = 'badjson'
      this.log.warn('llm.badjson', { model, ms: Date.now() - started })
      throw new ContractError('llm', 502)
    }

    this.db.putLlmCache(cacheKey, answer.summary, answer.replies, Date.now())
    this.db.deleteExpiredLlmCache(Date.now() - CACHE_TTL_MS)
    this.lastFailure = null
    this.log.info('llm.request', {
      model,
      promptChars,
      ms: Date.now() - started,
      cache: false,
    })
    return answer
  }

  // ---- internals ----------------------------------------------------------

  private ready(): boolean {
    return this.baseUrl().length > 0 && this.config.llmModel !== null
  }

  private baseUrl(): string {
    return this.config.llmBaseUrl ?? ''
  }

  /** T3 key first (AES-GCM, AAD `llm`), `.env` second. */
  private resolveKey(logUnreadable = true): string | null {
    const blob = this.db.getLlmKey()
    if (blob !== null) {
      try {
        const key = decrypt(blob, this.config.encKey, 'llm').trim()
        if (key.length > 0) return key
      } catch {
        // A key saved under another SESSION_ENC_KEY is unusable; the env key
        // still is, and saying so is better than refusing every request.
        if (logUnreadable) this.log.warn('llm.key.unreadable', {})
      }
    }
    return this.config.llmApiKey
  }

  private modelOf(stored: string | null | undefined): string {
    if (stored && this.config.llmModels.includes(stored)) return stored
    return this.config.llmModel ?? this.config.llmModels[0] ?? ''
  }

  private sessionIdOf(token: string | null): string | null {
    if (!token) return null
    return this.db.sessionIdByTokenHash(hashToken(token))
  }

  private fail(reason: string, model: string, started: number): void {
    this.lastFailure = reason
    this.log.warn('llm.failed', { model, reason, ms: Date.now() - started })
  }
}

/** The same rule the CHAT screen uses: more than five body lines is "long". */
function isLong(text: string): boolean {
  return measureTextWrap(text, TEXT_PX).lineCount > BODY_LINES
}

function cacheKeyOf(
  chatId: string,
  messageId: string,
  tone: Tone,
  model: string,
  lang: PromptLang,
): string {
  return createHash('sha256')
    .update([chatId, messageId, tone, model, lang].join('\u0000'), 'utf8')
    .digest('hex')
}

/**
 * Strict schema, then cleanup: the model may still number the options or wrap
 * them in quotes despite the prompt. Anything that stops being three usable
 * options is `null` — one retry, then NO REPLIES, not "almost".
 */
export function parseAnswer(content: string, long: boolean): LlmReply | null {
  const raw = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim()
  if (raw.length === 0) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const body = parsed as { summary?: unknown; replies?: unknown }
  // A short message has no summary by design: a model that omits the key must
  // not cost the user three good options.
  if (long && typeof body.summary !== 'string') return null
  if (!Array.isArray(body.replies) || body.replies.length !== 3) return null

  const replies: string[] = []
  for (const item of body.replies) {
    if (typeof item !== 'string') return null
    const reply = cutWords(oneLine(stripQuotes(stripNumbering(item))), REPLY_CHARS)
    if (reply.length === 0) return null
    replies.push(reply)
  }

  const summary = long
    ? cutWords(oneLine(stripQuotes(typeof body.summary === 'string' ? body.summary : '')), SUMMARY_CHARS)
    : ''
  return { summary, replies }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** `1. `, `1) `, `- `, `• ` — numbering is ours to add, not the model's. */
function stripNumbering(text: string): string {
  return text.trim().replace(/^(?:\d{1,2}[.)]|[-•*])\s+/, '')
}

/** Straight and typographic quotes around a whole option. */
function stripQuotes(text: string): string {
  return text.trim().replace(/^["'«“]+/, '').replace(/["'»”]+$/, '')
}

function cutWords(text: string, max: number): string {
  const chars = [...text]
  if (chars.length <= max) return text
  let end = max - 1
  for (let i = end; i > Math.max(0, end - 40); i--) {
    if (/\s/.test(chars[i] ?? '')) {
      end = i
      break
    }
  }
  const kept = chars.slice(0, end).join('').trimEnd()
  return kept.length > 0 ? `${kept}…` : chars.slice(0, max).join('')
}
