import assert from 'node:assert/strict'
import test from 'node:test'
import { Db } from '../dist/db.js'

test('sessions, tokens and single-account replacement', () => {
  const db = new Db(':memory:')
  try {
    db.saveSession({
      id: 's1',
      user_id: '42',
      first_name: 'Anton',
      username: 'anton',
      enc_session: 'v1:aaa:bbb:ccc',
      test_dc: 0,
      created_at: 1,
    })
    db.putAuthToken('hash1', 's1', 1)
    assert.equal(db.getSession('s1')?.user_id, '42')
    assert.equal(db.sessionIdByTokenHash('hash1'), 's1')

    db.saveSession({
      id: 's2',
      user_id: '43',
      first_name: 'Other',
      username: '',
      enc_session: 'v1:ddd:eee:fff',
      test_dc: 0,
      created_at: 2,
    })
    assert.equal(db.getSession('s1'), null)
    assert.equal(db.sessionIdByTokenHash('hash1'), null)
    assert.equal(db.getSession('s2')?.user_id, '43')

    db.deleteSession('s2')
    assert.equal(db.getSession('s2'), null)
    assert.equal(db.sessionIdByTokenHash('hash1'), null)
  } finally {
    db.close()
  }
})

test('pending rows are readable and clearable', () => {
  const db = new Db(':memory:')
  try {
    db.putPending({
      id: 'p1',
      phone: '+79991234567',
      phone_code_hash: 'hash',
      step: 'code',
      resend_at: 10,
      expires_at: 20,
      created_at: 1,
    })
    assert.equal(db.countPending(), 1)
    assert.equal(db.getPending('p1')?.phone, '+79991234567')

    db.putPending({
      id: 'p1',
      phone: '+79991234567',
      phone_code_hash: 'hash2',
      step: 'password',
      resend_at: 10,
      expires_at: 20,
      created_at: 1,
    })
    assert.equal(db.getPending('p1')?.step, 'password')

    db.deleteAllPending()
    assert.equal(db.countPending(), 0)
  } finally {
    db.close()
  }
})

test('future auth tokens keep the newest 20', () => {
  const db = new Db(':memory:')
  try {
    for (let i = 0; i < 25; i += 1) db.addFutureToken(`token-${i}`, 's1', i)
    const tokens = db.futureTokens(50)
    assert.equal(tokens.length, 20)
    assert.equal(tokens[0], 'token-24')
    assert.equal(tokens.includes('token-5'), true)
    assert.equal(tokens.includes('token-4'), false)

    // Tokens survive the session they came from (logout must not clear them).
    db.saveSession({
      id: 's1',
      user_id: '1',
      first_name: '',
      username: '',
      enc_session: 'v1:a:b:c',
      test_dc: 0,
      created_at: 1,
    })
    db.deleteSession('s1')
    assert.equal(db.futureTokens(50).length, 20)
  } finally {
    db.close()
  }
})

test('wipeAll removes sessions, tokens, settings, llm key and pending', () => {
  const db = new Db(':memory:')
  try {
    db.saveSession({
      id: 's1',
      user_id: '1',
      first_name: '',
      username: '',
      enc_session: 'v1:a:b:c',
      test_dc: 0,
      created_at: 1,
    })
    db.putAuthToken('hash', 's1', 1)
    db.putSettings(
      's1',
      { lang: 'en', quickReply: 'ok', tone: 'short', selectedChats: ['user:1'], llmModel: 'm' },
      1,
    )
    db.putLlmKey('v1:x:y:z', 1)
    db.putLlmCache('cache-key', 'short', ['a', 'b', 'c'], 1)
    db.addFutureToken('token', 's1', 1)
    db.putPending({
      id: 'p1',
      phone: '',
      phone_code_hash: null,
      step: 'link',
      resend_at: 0,
      expires_at: 1,
      created_at: 1,
    })
    assert.equal(db.hasLlmKey(), true)
    assert.ok(db.getLlmCache('cache-key', 0))

    db.wipeAll()

    assert.equal(db.hasLlmKey(), false)
    assert.equal(db.getLlmCache('cache-key', 0), null)
    assert.equal(db.getSession('s1'), null)
    assert.equal(db.sessionIdByTokenHash('hash'), null)
    assert.equal(db.countPending(), 0)
    assert.deepEqual(db.futureTokens(), [])
  } finally {
    db.close()
  }
})

test('the LLM cache honours its TTL and does not outlive the session', () => {
  const db = new Db(':memory:')
  try {
    db.saveSession({
      id: 's1',
      user_id: '1',
      first_name: '',
      username: '',
      enc_session: 'v1:a:b:c',
      test_dc: 0,
      created_at: 1,
    })
    db.putLlmCache('k', 's', ['a', 'b', 'c'], 1000)
    assert.deepEqual(db.getLlmCache('k', 0), { summary: 's', replies: ['a', 'b', 'c'] })
    // Older than the 24 h window: not served.
    assert.equal(db.getLlmCache('k', 2000), null)

    db.deleteSession('s1')
    assert.equal(db.getLlmCache('k', 0), null)
  } finally {
    db.close()
  }
})
