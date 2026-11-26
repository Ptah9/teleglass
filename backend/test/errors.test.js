import assert from 'node:assert/strict'
import test from 'node:test'
import { ContractError } from '../dist/contract.js'
import {
  isNetworkError,
  isSessionDead,
  toContractError,
} from '../dist/tg/errors.js'
import { migrateDcOf } from '../dist/tg/service.js'

test('login errors map to the contract codes', () => {
  const cases = [
    [{ errorMessage: 'PHONE_CODE_INVALID' }, 'wrongCode'],
    [{ errorMessage: 'PHONE_CODE_EMPTY' }, 'wrongCode'],
    [{ errorMessage: 'PHONE_CODE_EXPIRED' }, 'expiredCode'],
    [{ errorMessage: 'PHONE_CODE_HASH_EMPTY' }, 'expiredCode'],
    [{ errorMessage: 'PASSWORD_HASH_INVALID' }, 'wrongPassword'],
    [{ errorMessage: 'PHONE_NUMBER_FLOOD' }, 'tooMany'],
    [{ errorMessage: 'FLOOD_WAIT_42' }, 'tooMany'],
    [{ errorMessage: 'PHONE_PASSWORD_FLOOD' }, 'tooMany'],
    [{ errorMessage: 'AUTH_TOKEN_INVALID' }, 'linkExpired'],
    [{ errorMessage: 'AUTH_TOKEN_EXPIRED' }, 'linkExpired'],
    [{ errorMessage: 'AUTH_TOKEN_ALREADY_ACCEPTED' }, 'linkExpired'],
    [{ errorMessage: 'SOMETHING_NEW' }, 'unknown'],
  ]
  for (const [error, expected] of cases) {
    assert.equal(toContractError(error, 'auth').code, expected, error.errorMessage)
  }
})

test('flood is 429, network is 502, auth mistakes are 400', () => {
  assert.equal(toContractError({ errorMessage: 'FLOOD_WAIT_9' }, 'auth').status, 429)
  assert.equal(toContractError({ code: 'ECONNRESET' }, 'auth').status, 502)
  assert.equal(toContractError(new TypeError('fetch failed'), 'auth').status, 502)
  assert.equal(toContractError({ errorMessage: 'PHONE_CODE_INVALID' }, 'auth').status, 400)
})

test('a ContractError passes through untouched', () => {
  const original = new ContractError('wrongPassword', 400)
  assert.equal(toContractError(original, 'auth'), original)
})

test('dead sessions are recognised by their RPC code', () => {
  for (const code of ['AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'AUTH_KEY_INVALID']) {
    assert.equal(isSessionDead({ errorMessage: code }), true, code)
  }
  assert.equal(isSessionDead({ errorMessage: 'PHONE_CODE_INVALID' }), false)
  assert.equal(isSessionDead(new Error('nope')), false)
})

test('network errors are socket failures, not Telegram rejections', () => {
  assert.equal(isNetworkError({ code: 'ETIMEDOUT' }), true)
  assert.equal(isNetworkError({ code: 'ENOTFOUND' }), true)
  assert.equal(isNetworkError(new TypeError('terminated')), true)
  assert.equal(isNetworkError({ errorMessage: 'PHONE_CODE_INVALID' }), false)
})

test('only a DC migration is repeated, and it is recognised', () => {
  assert.equal(migrateDcOf({ errorMessage: 'PHONE_MIGRATE_3' }), 3)
  assert.equal(migrateDcOf({ errorMessage: 'NETWORK_MIGRATE_1' }), 1)
  assert.equal(migrateDcOf({ errorMessage: 'PHONE_MIGRATE_-0' }), null)
  assert.equal(migrateDcOf({ newDc: 2 }), 2)
  assert.equal(migrateDcOf({ errorMessage: 'PHONE_CODE_INVALID' }), null)
  assert.equal(migrateDcOf(new Error('nope')), null)
})
