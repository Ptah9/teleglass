/**
 * Sending the recording from the glasses as a Telegram voice note.
 *
 * PCM 16 kHz (the SDK format) → Ogg Opus mono 48 kHz ~24 kbps voice profile →
 * `messages.sendMedia` with `DocumentAttributeAudio(voice: true)`. The temp
 * directory is removed after the upload, whatever the outcome: voice is user
 * data and must not stay on disk.
 *
 * `random_id` is the same pair-derived id as the text reply (`chatId +
 * messageId`), so a retry after a timeout is not a second message.
 */

import type { Logger } from '../log.js'
import { ContractError } from '../contract.js'
import type { AuthService } from '../service.js'
import { pcmToOggOpus, type EncodedVoice } from '../audio/ffmpeg.js'
import { decodeAudioBase64, MAX_AUDIO_BYTES } from '../audio/pcm.js'

export interface VoiceApi {
  send(
    token: string | null,
    chatId: string,
    messageId: string,
    audio: string,
  ): Promise<{ id: string; at: string }>
}

export interface VoiceServiceDeps {
  log: Logger
  auth: Pick<AuthService, 'sessionId' | 'sendVoiceFile'>
  /** Tests replace ffmpeg; production uses the system binary. */
  encode?: (pcm: Buffer) => Promise<EncodedVoice>
}

export class VoiceService implements VoiceApi {
  private readonly log: Logger
  private readonly auth: Pick<AuthService, 'sessionId' | 'sendVoiceFile'>
  private readonly encode: (pcm: Buffer) => Promise<EncodedVoice>

  constructor(deps: VoiceServiceDeps) {
    this.log = deps.log
    this.auth = deps.auth
    this.encode = deps.encode ?? pcmToOggOpus
  }

  async send(
    token: string | null,
    chatId: string,
    messageId: string,
    audio: string,
  ): Promise<{ id: string; at: string }> {
    if (this.auth.sessionId(token) === null) throw new ContractError('unknown', 401)
    // The Telegram id is checked before the encoder runs: an unparseable id can
    // only end in 404, and spending up to 8 s of ffmpeg on it is pointless.
    if (!/^\d{1,20}$/.test(messageId)) throw new ContractError('unknown', 404)
    const pcm = decodeAudioBase64(audio)
    if (pcm.length > MAX_AUDIO_BYTES || pcm.length % 2 !== 0) {
      throw new ContractError('unknown', 400)
    }

    let encoded: EncodedVoice
    try {
      encoded = await this.encode(pcm)
    } catch {
      this.log.warn('voice.failed', { chatId, reason: 'convert' })
      throw new ContractError('send', 502)
    }
    try {
      return await this.auth.sendVoiceFile(token, chatId, messageId, {
        path: encoded.path,
        size: encoded.size,
        durationSec: encoded.durationSec,
      })
    } finally {
      await encoded.dir.cleanup()
    }
  }
}
