/**
 * The bearer token the WebView keeps in `localStorage` is issued here and is
 * unrelated to the Telegram session: it only unlocks our own HTTP API.
 *
 * Only a SHA-256 hash is stored, so a database copy does not hand out working
 * tokens.
 */

import { createHash, randomBytes } from 'node:crypto'

export interface BearerToken {
  token: string
  hash: string
}

export function newBearerToken(): BearerToken {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashToken(token) }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}
