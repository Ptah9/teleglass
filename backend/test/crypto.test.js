import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { decrypt, encrypt, newEncryptionKey, parseKey } from '../dist/crypto.js'

test('encrypt/decrypt round-trips and is bound to the AAD', () => {
  const key = randomBytes(32)
  const plain = '1A2B3C-session-string'
  const blob = encrypt(plain, key, 'session:abc')
  assert.notEqual(blob, plain)
  assert.equal(decrypt(blob, key, 'session:abc'), plain)
  assert.throws(() => decrypt(blob, key, 'llm'))
  assert.throws(() => decrypt(blob, randomBytes(32), 'session:abc'))
})

test('every encryption uses a fresh IV', () => {
  const key = randomBytes(32)
  const a = encrypt('same', key, 'llm')
  const b = encrypt('same', key, 'llm')
  assert.notEqual(a, b)
  assert.equal(decrypt(a, key, 'llm'), 'same')
  assert.equal(decrypt(b, key, 'llm'), 'same')
})

test('tampered ciphertext and malformed blobs are rejected', () => {
  const key = randomBytes(32)
  const blob = encrypt('secret', key, 'llm')
  const parts = blob.split(':')
  const cipher = Buffer.from(parts[3], 'base64url')
  cipher[0] ^= 0xff
  parts[3] = cipher.toString('base64url')
  assert.throws(() => decrypt(parts.join(':'), key, 'llm'))

  assert.throws(() => decrypt('v2:a:b:c', key, 'llm'))
  assert.throws(() => decrypt('nonsense', key, 'llm'))
})

test('parseKey accepts only a base64 32-byte key', () => {
  const generated = newEncryptionKey()
  assert.equal(parseKey(generated).length, 32)
  assert.throws(() => parseKey('short'))
  assert.throws(() => parseKey(Buffer.alloc(16).toString('base64')))
})
