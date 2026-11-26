/**
 * Telegram failures become the contract codes and nothing else. The WebView
 * never sees an RPC error body: only `wrongCode`, `expiredCode`, `tooMany`,
 * `wrongPassword`, `network`, `linkExpired`, `llm`, `send`, `unknown`.
 */

import { ContractError, type AuthErrorCode } from '../contract.js'
import { errorTag } from '../log.js'

/** Errors that mean the stored Telegram session is gone for good. */
const DEAD_SESSION = new Set([
  'AUTH_KEY_UNREGISTERED',
  'AUTH_KEY_INVALID',
  'AUTH_KEY_DUPLICATED',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
])

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
])

export function errorMessageOf(err: unknown): string {
  if (err && typeof err === 'object') {
    const raw = (err as { errorMessage?: unknown }).errorMessage
    if (typeof raw === 'string' && raw.length > 0) return raw
  }
  return ''
}

export function isSessionDead(err: unknown): boolean {
  return DEAD_SESSION.has(errorMessageOf(err))
}

export function isNetworkError(err: unknown): boolean {
  if (err instanceof ContractError) return err.code === 'network'
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return true
  }
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string' && NETWORK_CODES.has(code)) return true
  }
  // A TypeError from `fetch`/socket code is the usual shape of "no network".
  return err instanceof TypeError
}

/**
 * `phase` only decides which contract code an unclassified error gets:
 * Telegram auth calls fail as `unknown`, anything that looks like a socket
 * failure as `network`.
 */
export function toContractError(
  err: unknown,
  phase: 'auth' | 'link' | 'chats' | 'messages',
): ContractError {
  if (err instanceof ContractError) return err

  const code = errorMessageOf(err)

  // Flood is always `tooMany`, whatever call hit it.
  if (err instanceof Error && err.constructor?.name === 'FloodWaitError') {
    return new ContractError('tooMany', 429)
  }
  if (code.includes('FLOOD')) {
    return new ContractError('tooMany', 429)
  }

  switch (code) {
    case 'PHONE_CODE_INVALID':
    case 'PHONE_CODE_EMPTY':
      return new ContractError('wrongCode')
    case 'PHONE_CODE_EXPIRED':
    case 'PHONE_CODE_HASH_EMPTY':
      return new ContractError('expiredCode')
    case 'PASSWORD_HASH_INVALID':
    case 'PASSWORD_EMPTY':
      return new ContractError('wrongPassword')
    case 'SESSION_PASSWORD_NEEDED':
      // Handled by the caller; reaching here means the flow lost the step.
      return new ContractError('expiredCode')
    case 'AUTH_TOKEN_INVALID':
    case 'AUTH_TOKEN_INVALIDX':
    case 'AUTH_TOKEN_EXPIRED':
    case 'AUTH_TOKEN_ALREADY_ACCEPTED':
      return new ContractError('linkExpired')
    default:
      break
  }

  if (isNetworkError(err)) return new ContractError('network', 502)
  return new ContractError(
    'unknown',
    phase === 'chats' || phase === 'messages' ? 502 : 400,
  )
}

/** For the log line: a code like `PHONE_CODE_INVALID`, never a message body. */
export function loggableError(err: unknown): string {
  return errorTag(err)
}

/** Keeps the map honest: every value here is in the contract. */
export const CONTRACT_CODES: readonly AuthErrorCode[] = [
  'wrongCode',
  'expiredCode',
  'tooMany',
  'wrongPassword',
  'network',
  'linkExpired',
  'llm',
  'send',
  'unknown',
]
