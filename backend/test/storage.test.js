import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { decrypt, encrypt } from '../dist/crypto.js'
import { Db } from '../dist/db.js'

test('the database file never holds a session or an LLM key in plain text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'teleglass-db-'))
  const file = join(dir, 'teleglass.sqlite')
  const key = randomBytes(32)
  const sessionMarker = 'SESSION-PLAINTEXT-MARKER-5c1f'
  const llmMarker = 'LLM-PLAINTEXT-MARKER-9a2e'
  const aad = 'session:test-id'

  try {
    const db = new Db(file)
    db.saveSession({
      id: 'test-id',
      user_id: '42',
      first_name: 'Test',
      username: 'test',
      enc_session: encrypt(sessionMarker, key, aad),
      test_dc: 0,
      created_at: 1,
    })
    db.putLlmKey(encrypt(llmMarker, key, 'llm'), 1)
    db.putAuthToken('hash', 'test-id', 1)

    for (const suffix of ['', '-wal', '-shm']) {
      const path = `${file}${suffix}`
      if (!existsSync(path)) continue
      const bytes = readFileSync(path)
      assert.equal(bytes.includes(Buffer.from(sessionMarker)), false, `session leaked in ${suffix}`)
      assert.equal(bytes.includes(Buffer.from(llmMarker)), false, `llm key leaked in ${suffix}`)
    }

    const row = db.getSession('test-id')
    assert.ok(row)
    assert.equal(decrypt(row.enc_session, key, aad), sessionMarker)

    db.wipeAll()
    db.close()

    const after = readFileSync(file)
    assert.equal(after.includes(Buffer.from(sessionMarker)), false)
    assert.equal(after.includes(Buffer.from(llmMarker)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
