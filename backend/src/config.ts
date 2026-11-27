/**
 * Configuration comes from the environment, and `app/.env` is read only when a
 * variable is not already set. No secret is ever printed: startup errors name
 * the variable, never its value.
 *
 * The Telegram application credentials and the session encryption key are
 * required. Everything else has a safe local default.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseKey } from './crypto.js'

/** `app/backend`, whether the code runs from `src/` or `dist/`. */
export const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export interface Config {
  apiId: number
  apiHash: string
  /** Test servers (`99966XYYYY` numbers, code `XXXXX`). Never mixed with live. */
  testDc: boolean
  host: string
  port: number
  dbPath: string
  corsOrigins: string[]
  encKey: Buffer
  /** `socks5://user:pass@host:port` or `socks4://host:port`. */
  socksProxy: string | null
  /** `host:port:secret` for a Telegram MTProxy. */
  mtProxy: string | null
  /**
   * OpenAI-compatible LLM endpoint. `null` when the deployment has no LLM —
   * then `/health` says `llm: "off"` and no request ever leaves the machine.
   */
  llmBaseUrl: string | null
  /** Fallback key from `.env`; a key saved from T3 wins over it. */
  llmApiKey: string | null
  /** Model used when the phone has not chosen one (or chose an unknown id). */
  llmModel: string | null
  /** Models offered to T3, in `.env` order. */
  llmModels: string[]
  /** Local whisper.cpp server; audio never leaves the machine. */
  whisperUrl: string
  /** `ggml-small.bin`; missing model is `502 stt`, not a crash. */
  whisperModel: string
}

export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiIdRaw = require(env, 'TG_API_ID')
  const apiId = Number(apiIdRaw)
  if (!Number.isInteger(apiId) || apiId <= 0) {
    throw new Error('TG_API_ID must be a positive integer')
  }

  const apiHash = require(env, 'TG_API_HASH').trim()
  if (!/^[0-9a-fA-F]{32}$/.test(apiHash)) {
    throw new Error('TG_API_HASH must be 32 hexadecimal characters')
  }

  const encKey = parseKey(require(env, 'SESSION_ENC_KEY'))

  const port = Number(env.PORT ?? 8787)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('PORT must be 1..65535')
  }

  const host = (env.HOST ?? '127.0.0.1').trim() || '127.0.0.1'

  const dbRaw = (env.DB_PATH ?? './data/teleglass.sqlite').trim() || './data/teleglass.sqlite'
  const dbPath = resolve(backendRoot, dbRaw)

  const corsOrigins = (env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)

  const socksProxy = emptyToNull(env.TG_PROXY)
  const mtProxy = emptyToNull(env.TG_MT_PROXY)
  if (socksProxy && mtProxy) {
    throw new Error('Set either TG_PROXY or TG_MT_PROXY, not both')
  }

  const llmBaseUrl = emptyToNull(env.LLM_BASE_URL)
  if (llmBaseUrl && !/^https?:\/\//i.test(llmBaseUrl)) {
    throw new Error('LLM_BASE_URL must start with http:// or https://')
  }

  const llmModels = (env.LLM_MODELS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= 64)
    .slice(0, 20)
  const llmModel = emptyToNull(env.LLM_MODEL) ?? llmModels[0] ?? null
  if (llmModel && !llmModels.includes(llmModel)) llmModels.unshift(llmModel)

  const whisperUrl = (emptyToNull(env.WHISPER_URL) ?? 'http://127.0.0.1:8081').replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(whisperUrl)) {
    throw new Error('WHISPER_URL must start with http:// or https://')
  }
  const whisperModel = resolve(
    backendRoot,
    (emptyToNull(env.WHISPER_MODEL) ?? './vendor/whisper/ggml-small.bin').trim(),
  )

  return {
    apiId,
    apiHash,
    testDc: isTruthy(env.TG_TEST_DC),
    host,
    port,
    dbPath,
    corsOrigins,
    encKey,
    socksProxy,
    mtProxy,
    llmBaseUrl,
    llmApiKey: emptyToNull(env.LLM_API_KEY),
    llmModel,
    llmModels,
    whisperUrl,
    whisperModel,
  }
}

/** Reads `app/.env` once, without overriding what the shell already exported. */
export function loadEnvFile(path = resolve(backendRoot, '..', '.env')): void {
  if (!existsSync(path)) return
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseLine(line)
    if (!parsed) continue
    if (process.env[parsed.key] === undefined) process.env[parsed.key] = parsed.value
  }
}

export function loadConfig(): Config {
  loadEnvFile()
  return parseConfig(process.env)
}

function parseLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.startsWith('#')) return null
  const eq = trimmed.indexOf('=')
  if (eq <= 0) return null
  const key = trimmed.slice(0, eq).trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null
  let value = trimmed.slice(eq + 1).trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1)
  }
  return { key, value }
}

function require(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} is required (see app/.env)`)
  }
  return value
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

function emptyToNull(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
