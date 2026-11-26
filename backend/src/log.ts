/**
 * One line per event, JSON, to stdout. The rules from the task:
 * no `api_hash`, no session string, no login code, no password, and the phone
 * number is always masked (`+7 999 ***-**-67`).
 *
 * Secrets are excluded by construction, not by remembering: field names that
 * look like secrets are replaced with `[redacted]` before anything is written.
 * The name `code` is special: a login or 2FA code is redacted by its shape
 * (a short run of digits), while an error code such as `EADDRINUSE` or
 * `network` stays readable — otherwise no crash could be diagnosed.
 */

import type { Writable } from 'node:stream'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Anything named like this never reaches the log, whatever the caller passes. */
const SECRET_FIELDS = new Set([
  'apihash',
  'api_hash',
  'session',
  'sessionstring',
  'session_string',
  'encsession',
  'enc_session',
  'password',
  'token',
  'bearer',
  'llmkey',
  'llm_key',
  'apikey',
  'api_key',
  'secret',
  'phonecodehash',
  'phone_code_hash',
])

export type LogFields = Record<string, string | number | boolean | null | undefined>

export function maskPhone(input: string): string {
  const digits = input.replace(/\D/g, '')
  if (digits.length === 0) return ''
  if (digits.length < 7) return '***'
  const head = digits.slice(0, 1)
  const area = digits.slice(1, 4)
  const tail = digits.slice(-2)
  return `+${head} ${area} ***-**-${tail}`
}

/** A Telegram error code like `PHONE_CODE_INVALID`; never its body. */
export function errorTag(err: unknown): string {
  if (err && typeof err === 'object') {
    const raw = (err as { errorMessage?: unknown }).errorMessage
    if (typeof raw === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(raw)) return raw
  }
  if (err instanceof Error) {
    const name = err.constructor?.name ?? 'Error'
    return /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : 'Error'
  }
  return 'UnknownError'
}

/**
 * A login or 2FA code is a short run of digits. A system error code
 * (`EADDRINUSE`) or our own contract code (`network`) is not one, and it is the
 * only thing that makes a crash diagnosable.
 */
function looksLikeLoginCode(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1_000 && value <= 99_999_999
  }
  if (typeof value !== 'string') return false
  return /^\d{4,8}$/.test(value.replace(/[\s-]/g, ''))
}

/**
 * A crash diagnostic: what kind of error it is, its system code and its own
 * message. The message goes through the logger, so control characters are
 * flattened; our code never puts a secret into an error message.
 */
export function describeError(err: unknown): LogFields {
  const fields: LogFields = { error: errorTag(err) }
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined
  if (typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(code)) {
    fields.code = code
  }
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  if (message) fields.message = message
  return fields
}

export class Logger {
  private readonly threshold: number
  private readonly out: { write(chunk: string): unknown }

  constructor(level: LogLevel = 'info', out: Writable = process.stdout) {
    this.threshold = LEVEL_WEIGHT[level]
    this.out = out
  }

  debug(event: string, fields?: LogFields): void {
    this.write('debug', event, fields)
  }

  info(event: string, fields?: LogFields): void {
    this.write('info', event, fields)
  }

  warn(event: string, fields?: LogFields): void {
    this.write('warn', event, fields)
  }

  error(event: string, fields?: LogFields): void {
    this.write('error', event, fields)
  }

  private write(level: LogLevel, event: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[level] < this.threshold) return
    const record: Record<string, unknown> = {
      t: new Date().toISOString(),
      level,
      event: sanitizeText(event),
    }
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        const normalized = key.toLowerCase()
        // A field named `code` is a secret only when it holds a login or 2FA
        // code; an error code (`EADDRINUSE`, `network`) is the whole point of
        // logging a crash and must stay readable.
        if (SECRET_FIELDS.has(normalized) || (normalized === 'code' && looksLikeLoginCode(value))) {
          record[key] = '[redacted]'
          continue
        }
        if (value === undefined) continue
        record[key] = typeof value === 'string' ? sanitizeText(value) : value
      }
    }
    try {
      this.out.write(`${JSON.stringify(record)}\n`)
    } catch {
      /* logging must never take the request down */
    }
  }
}

function sanitizeText(value: string): string {
  // Control characters (including newlines) would break the one-line format.
  const flat = stripControl(value)
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat
}

/** Replaces control characters with spaces, without a control-character regex. */
export function stripControl(value: string): string {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    out += code < 0x20 || code === 0x7f ? ' ' : char
  }
  return out
}
