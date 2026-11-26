/**
 * AES-256-GCM for everything secret at rest: the Telegram session string and
 * the LLM key. The key itself lives only in `app/.env` (`SESSION_ENC_KEY`),
 * never in the database and never in git.
 *
 * Format: `v1:<iv b64url>:<tag b64url>:<ciphertext b64url>`.
 * AAD labels the purpose and owner, so a session blob cannot be reused as an
 * LLM key even with the same master key.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const VERSION = 'v1'
const IV_BYTES = 12
const TAG_BYTES = 16

export function encrypt(plain: string, key: Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, b64(iv), b64(tag), b64(ciphertext)].join(':')
}

export function decrypt(payload: string, key: Buffer, aad: string): string {
  const parts = payload.split(':')
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('unsupported ciphertext')
  }
  const iv = unb64(parts[1] as string)
  const tag = unb64(parts[2] as string)
  const ciphertext = unb64(parts[3] as string)
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('malformed ciphertext')
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/** 32 bytes from base64, with a clear error that never echoes the value. */
export function parseKey(raw: string): Buffer {
  let key: Buffer
  try {
    key = Buffer.from(raw.trim(), 'base64')
  } catch {
    throw new Error('SESSION_ENC_KEY is not base64')
  }
  if (key.length !== 32) {
    throw new Error('SESSION_ENC_KEY must decode to 32 bytes (base64)')
  }
  return key
}

export function newEncryptionKey(): string {
  return randomBytes(32).toString('base64')
}

function b64(buf: Buffer): string {
  return buf.toString('base64url')
}

function unb64(text: string): Buffer {
  return Buffer.from(text, 'base64url')
}
