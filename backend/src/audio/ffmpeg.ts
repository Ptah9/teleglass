/**
 * ffmpeg is a system tool (it is in PATH on this machine); we never ship it.
 *
 * Two jobs only:
 * - Telegram stores voice notes as Ogg/Opus, whisper wants PCM WAV: decode one
 *   into the other for recognition;
 * - the glasses give raw PCM, Telegram needs an Ogg/Opus voice note: encode.
 *
 * Every temp file lives in one directory per call and is removed in `finally`
 * by the caller — voice is user data, it must not stay on disk.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_AUDIO_MS, pcmDurationMs } from './pcm.js'

export interface TempDir {
  path: string
  cleanup(): Promise<void>
}

export async function makeTempDir(): Promise<TempDir> {
  const path = await mkdtemp(join(tmpdir(), 'teleglass-audio-'))
  return {
    path,
    async cleanup() {
      await rm(path, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}

/**
 * Any audio container → 16 kHz mono 16-bit WAV. The input extension is only a
 * hint: ffmpeg probes the bytes, and Telegram may hand over `.oga` or `.ogg`.
 */
export async function toWav(audio: Buffer, mime: string): Promise<Buffer> {
  const dir = await makeTempDir()
  try {
    const input = join(dir.path, `input${extensionOf(mime)}`)
    const output = join(dir.path, 'audio.wav')
    await writeFile(input, audio)
    await runFfmpeg([
      '-i',
      input,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      output,
    ])
    return await readFile(output)
  } finally {
    await dir.cleanup()
  }
}

export interface EncodedVoice {
  dir: TempDir
  path: string
  size: number
  durationSec: number
}

/**
 * PCM 16 kHz mono → Ogg Opus, mono 48 kHz ~24 kbps, voice profile. The file is
 * left on disk for the Telegram upload; the caller owns `dir.cleanup()`.
 */
export async function pcmToOggOpus(pcm: Buffer): Promise<EncodedVoice> {
  // The cap is checked before this call (task v0.7 §3); the assert is cheap.
  if (pcmDurationMs(pcm.length) > MAX_AUDIO_MS) throw new Error('audio is too long')

  const dir = await makeTempDir()
  const output = join(dir.path, 'voice.ogg')
  try {
    await runFfmpeg(
      [
        '-f',
        's16le',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-i',
        'pipe:0',
        '-ac',
        '1',
        '-ar',
        '48000',
        '-c:a',
        'libopus',
        '-b:a',
        '24k',
        '-application',
        'voip',
        '-f',
        'ogg',
        output,
      ],
      pcm,
    )
    const info = await stat(output)
    if (info.size === 0) throw new Error('ffmpeg produced an empty file')
    return {
      dir,
      path: output,
      size: info.size,
      durationSec: pcmDurationMs(pcm.length) / 1000,
    }
  } catch (err) {
    await dir.cleanup()
    throw err
  }
}

function extensionOf(mime: string): string {
  switch (mime.toLowerCase()) {
    case 'audio/ogg':
    case 'audio/opus':
    case 'audio/ogg; codecs=opus':
      return '.ogg'
    case 'audio/mpeg':
      return '.mp3'
    case 'audio/wav':
    case 'audio/x-wav':
      return '.wav'
    case 'audio/mp4':
    case 'audio/aac':
      return '.m4a'
    default:
      return '.audio'
  }
}

const FFMPEG_TIMEOUT_MS = 8_000

function runFfmpeg(args: string[], input?: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      reject(err)
      return
    }

    let stderr = ''
    let settled = false
    const finish = (err: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve()
    }

    // A stuck ffmpeg must not hold the HTTP request forever.
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error('ffmpeg timed out'))
    }, FFMPEG_TIMEOUT_MS)
    timer.unref?.()

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4_096) stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => finish(err))
    child.on('close', (code) => {
      if (code === 0) finish(null)
      else finish(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 160)}`))
    })
    if (input) child.stdin?.end(input)
    else child.stdin?.end()
  })
}

