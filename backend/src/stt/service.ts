/**
 * Speech to text, local: whisper.cpp's HTTP server keeps the model in memory
 * (the CLI reloads a 465 MB model on every call — that is +3–4 s per phrase).
 *
 * Nothing about the audio or its transcript is logged: `stt.ok` carries
 * milliseconds, seconds and `cached`, `stt.failed` only a reason. A voice
 * message is recognized once: the transcript is cached in SQLite by
 * `chatId + messageId`, because the recording never changes.
 *
 * The service never throws on a dead provider: the phone gets `502 {error:"stt"}`
 * and the glasses show the honest "did not catch it" screen.
 */

import { existsSync } from 'node:fs'
import type { Config } from '../config.js'
import { ContractError, type Transcript } from '../contract.js'
import type { Db } from '../db.js'
import type { Logger } from '../log.js'
import type { AuthService } from '../service.js'
import { toWav } from '../audio/ffmpeg.js'
import { audioForTranscribe, wavDurationMs } from '../audio/pcm.js'

/**
 * Recognition budget grows with the recording: a one-minute dictation is a much
 * bigger job than a three-second reply, and a flat 15 s was a lottery on a
 * loaded machine (owner's call, 27.11). Norm is 2–3 s for a phrase; the clamp
 * keeps a broken request from holding a whisper slot for longer than 25 s.
 */
export const STT_TIMEOUT_MIN_MS = 12_000
export const STT_TIMEOUT_MAX_MS = 25_000

export function sttTimeoutMs(durationMs: number): number {
  const scaled = Math.round(durationMs * 0.5) + 8_000
  return Math.min(STT_TIMEOUT_MAX_MS, Math.max(STT_TIMEOUT_MIN_MS, scaled))
}

export interface SttApi {
  /** `/stt`: raw glasses PCM or a WAV, returns the text and its duration. */
  transcribe(token: string | null, audio: string, format: string): Promise<Transcript>
  /** `/chats/:id/messages/:messageId/transcribe`: download, convert, cache. */
  transcribeMessage(token: string | null, chatId: string, messageId: string): Promise<{ text: string }>
}

export interface SttServiceDeps {
  config: Config
  db: Db
  log: Logger
  /** Only the session check and the voice download: STT cannot send anything. */
  auth: Pick<AuthService, 'sessionId' | 'voiceMessageOf'>
  /** Tests replace ffmpeg; production uses the system binary. */
  convert?: (audio: Buffer, mime: string) => Promise<Buffer>
}

/** A Telegram message id is a positive integer. */
const NUMERIC_ID = /^\d{1,20}$/

export class SttService implements SttApi {
  private readonly config: Config
  private readonly db: Db
  private readonly log: Logger
  private readonly auth: Pick<AuthService, 'sessionId' | 'voiceMessageOf'>
  private readonly convert: (audio: Buffer, mime: string) => Promise<Buffer>

  constructor(deps: SttServiceDeps) {
    this.config = deps.config
    this.db = deps.db
    this.log = deps.log
    this.auth = deps.auth
    this.convert = deps.convert ?? toWav
  }

  async transcribe(
    token: string | null,
    audio: string,
    format: string,
  ): Promise<Transcript> {
    this.requireSession(token)
    // Shape first: an empty or broken recording is 400 even when there is no
    // model, because it is the client's mistake, not the provider's.
    const { wav, durationMs } = audioForTranscribe(audio, format)
    if (this.config.whisperModel.length === 0 || !existsSync(this.config.whisperModel)) {
      this.log.warn('stt.modelMissing', {})
      throw new ContractError('stt', 502)
    }
    const started = Date.now()
    const text = await this.recognize(wav, sttTimeoutMs(durationMs))
    this.log.info('stt.ok', {
      ms: Date.now() - started,
      seconds: Math.round(durationMs / 100) / 10,
      cached: false,
    })
    return { text, durationMs }
  }

  async transcribeMessage(
    token: string | null,
    chatId: string,
    messageId: string,
  ): Promise<{ text: string }> {
    this.requireSession(token)
    if (!NUMERIC_ID.test(messageId)) throw new ContractError('unknown', 404)

    const cached = this.db.getSttCache(chatId, messageId)
    if (cached) {
      // No provider call, no ffmpeg: opening the same voice message again is a
      // database read (task v0.7 §5).
      this.log.info('stt.ok', { ms: 0, seconds: cached.seconds, cached: true })
      return { text: cached.text }
    }

    if (this.config.whisperModel.length === 0 || !existsSync(this.config.whisperModel)) {
      this.log.warn('stt.modelMissing', {})
      throw new ContractError('stt', 502)
    }

    const started = Date.now()
    const voice = await this.auth.voiceMessageOf(token, chatId, messageId)
    let wav: Buffer
    try {
      wav = await this.convert(voice.audio, voice.mime)
    } catch {
      this.log.warn('stt.failed', { reason: 'convert', chatId })
      throw new ContractError('stt', 502)
    }
    const durationMs = durationOf(wav, voice.durationSec)
    const text = await this.recognize(wav, sttTimeoutMs(durationMs))
    try {
      this.db.putSttCache(chatId, messageId, text, Math.round(durationMs / 100) / 10, Date.now())
    } catch {
      // A cache write must not destroy a transcript the provider already gave:
      // the screen gets the text, the next open simply asks whisper again.
      this.log.warn('stt.cacheWrite', { chatId })
    }
    this.log.info('stt.ok', {
      ms: Date.now() - started,
      seconds: Math.round(durationMs / 100) / 10,
      cached: false,
    })
    return { text }
  }

  private requireSession(token: string | null): void {
    if (this.auth.sessionId(token) === null) throw new ContractError('unknown', 401)
  }

  /**
   * One multipart request to whisper-server. `language=auto`: the service
   * decides between Russian and English itself (task v0.7 §3).
   */
  private async recognize(wav: Buffer, timeoutMs: number): Promise<string> {
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav')
      form.append('language', 'auto')
      form.append('response_format', 'json')

      let response: Response
      try {
        response = await fetch(`${this.config.whisperUrl}/inference`, {
          method: 'POST',
          body: form,
          signal: controller.signal,
        })
      } catch {
        // Not reachable at all: the provider is down, not "a bad answer".
        this.log.warn('stt.unavailable', { ms: Date.now() - started })
        throw new ContractError('stt', 502)
      }
      if (!response.ok) {
        this.log.warn('stt.failed', { reason: `http_${response.status}`, ms: Date.now() - started })
        throw new ContractError('stt', 502)
      }

      let body: unknown
      try {
        body = await response.json()
      } catch {
        this.log.warn('stt.failed', { reason: 'shape' })
        throw new ContractError('stt', 502)
      }
      const raw = body && typeof body === 'object' ? (body as { text?: unknown }).text : undefined
      const text = typeof raw === 'string' ? speechOf(raw.trim()) : ''
      // Silence and noise come back as an empty string; an empty HEARD screen
      // looks like a broken app, so it is an honest failure instead.
      if (text.length === 0) {
        this.log.warn('stt.failed', { reason: 'empty' })
        throw new ContractError('stt', 502)
      }
      return text
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * whisper.cpp marks non-speech with a bracketed token instead of nothing: pure
 * silence comes back as `[BLANK_AUDIO]`, and a room with no speech as
 * `[SILENCE]`. Neither is words, and both would otherwise land on HEARD as a
 * service marker dressed as a transcript.
 */
const NO_SPEECH = /^(\s*\[[^\]]*\]\s*)+$/

function speechOf(raw: string): string {
  return NO_SPEECH.test(raw) ? '' : raw
}

/** Prefer the converted file's own header; Telegram's duration is the fallback. */
function durationOf(wav: Buffer, telegramSec: number): number {
  try {
    return wavDurationMs(wav)
  } catch {
    if (telegramSec > 0) return telegramSec * 1000
    return Math.max(0, Math.round(((wav.length - 44) / 32_000) * 1000))
  }
}
