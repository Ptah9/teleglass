/**
 * The one audio format the product produces: 16 kHz, signed 16-bit little-endian,
 * mono PCM from the glasses microphone. This module turns it into what whisper
 * wants (a RIFF/WAVE file) and refuses anything that is not a recording we could
 * sensibly recognize.
 *
 * Validation is part of the contract: bad base64, an empty buffer and audio
 * longer than the route allows are `400`, not a provider call. Dictation
 * (`/stt`) is capped at 45 s; a voice note (`/voice`) at Telegram's 120 s.
 */

import { ContractError } from '../contract.js'

export const SAMPLE_RATE = 16_000
export const BYTES_PER_SECOND = SAMPLE_RATE * 2
/** Telegram's own voice-note ceiling; `/voice` accepts up to this. */
export const MAX_AUDIO_MS = 120_000
export const MAX_AUDIO_BYTES = (MAX_AUDIO_MS / 1000) * BYTES_PER_SECOND
/**
 * `/stt` is dictation only, and a 45 s clip must fit the 25 s recognition
 * budget (owner's call, 27.11). A voice note does not go through whisper, so
 * its 120 s limit stays.
 */
export const MAX_DICTATION_MS = 45_000
export const MAX_DICTATION_BYTES = (MAX_DICTATION_MS / 1000) * BYTES_PER_SECOND
// Base64 of the samples plus a little slack: a `wav` body carries a RIFF header
// on top of the same duration, and the precheck must not reject a file the
// duration check would accept. The exact byte limits are applied after decoding;
// the precheck itself covers the longest payload of either route (120 s).
const MAX_BASE64_CHARS = Math.ceil((MAX_AUDIO_BYTES + 1024) / 3) * 4 + 8

/** Strict base64: `Buffer.from` silently ignores garbage, which hides bugs. */
export function decodeAudioBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0) throw new ContractError('unknown', 400)
  if (value.length > MAX_BASE64_CHARS || value.length % 4 !== 0) {
    throw new ContractError('unknown', 400)
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new ContractError('unknown', 400)
  const audio = Buffer.from(value, 'base64')
  if (audio.length === 0 || sampleCount(audio.length) < 1) {
    throw new ContractError('unknown', 400)
  }
  return audio
}

/** 44-byte header + PCM. Whisper accepts this without ffmpeg in the path. */
export function wavOf(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(BYTES_PER_SECOND, 28)
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * `/stt` accepts both shapes: the WebView sends raw `pcm` (no header on the
 * phone), and `wav` is the documented alternative.
 */
export function audioForTranscribe(audio: string, format: string): {
  wav: Buffer
  durationMs: number
} {
  const buffer = decodeAudioBase64(audio)
  if (format === 'pcm') {
    if (buffer.length % 2 !== 0) throw new ContractError('unknown', 400)
    if (buffer.length > MAX_DICTATION_BYTES) throw new ContractError('unknown', 400)
    return { wav: wavOf(buffer), durationMs: pcmDurationMs(buffer.length) }
  }
  if (format === 'wav') {
    const durationMs = wavDurationMs(buffer)
    if (durationMs > MAX_DICTATION_MS) throw new ContractError('unknown', 400)
    return { wav: buffer, durationMs }
  }
  throw new ContractError('unknown', 400)
}

export function pcmDurationMs(bytes: number): number {
  return Math.round((bytes / BYTES_PER_SECOND) * 1000)
}

/**
 * Duration of a RIFF/WAVE file from its own chunks. The app builds 16 kHz mono
 * files, but the header is parsed rather than assumed: a stale format must not
 * silently pass the 120 s cap.
 */
export function wavDurationMs(wav: Buffer): number {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') {
    throw new ContractError('unknown', 400)
  }
  if (wav.toString('ascii', 8, 12) !== 'WAVE') throw new ContractError('unknown', 400)

  let offset = 12
  let byteRate = BYTES_PER_SECOND
  let dataBytes = 0
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && size >= 12 && body + 12 <= wav.length) {
      // bytes 4..8 of fmt are the byte rate (rate × block align)
      byteRate = wav.readUInt32LE(body + 8) || BYTES_PER_SECOND
    }
    if (id === 'data') {
      dataBytes = Math.min(size, wav.length - body)
      break
    }
    offset = body + size + (size % 2)
  }
  if (dataBytes <= 0) throw new ContractError('unknown', 400)
  const durationMs = Math.round((dataBytes / byteRate) * 1000)
  if (durationMs <= 0 || durationMs > MAX_AUDIO_MS) throw new ContractError('unknown', 400)
  return durationMs
}

/** Below this nothing can be recognized; a click is not a recording. */
export function sampleCount(bytes: number): number {
  return Math.floor(bytes / 2)
}
