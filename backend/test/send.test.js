import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { Api, errors } from 'teleproto'
import { ContractError } from '../dist/contract.js'
import { encrypt } from '../dist/crypto.js'
import { Db } from '../dist/db.js'
import { Logger } from '../dist/log.js'
import { hashToken } from '../dist/tokens.js'
import { TelegramAuthService } from '../dist/tg/service.js'

const TOKEN = 'send-test-token'
const CHAT = 'user:42'
const MESSAGE = '7'

function config() {
  return {
    apiId: 1,
    apiHash: 'a'.repeat(32),
    testDc: true,
    host: '127.0.0.1',
    port: 8787,
    dbPath: ':memory:',
    corsOrigins: [],
    encKey: randomBytes(32),
    socksProxy: null,
    mtProxy: null,
    llmBaseUrl: 'https://llm.example',
    llmApiKey: null,
    llmModel: 'deepseek-flash',
    llmModels: [],
  }
}

/**
 * A dialogs row as teleproto hands it over: `chatSummaryOf` needs the title,
 * the unread count and a last message; `peerEntryOf` needs the input peer and
 * the read watermark.
 */
function dialogRow(id = 42) {
  return {
    id: { toString: () => String(id) },
    title: 'Anton',
    name: 'Anton',
    isUser: true,
    isChannel: false,
    unreadCount: 1,
    message: { message: 'hi' },
    dialog: { readInboxMaxId: 0 },
    inputEntity: { className: 'InputPeerUser' },
  }
}

function harness(behavior = {}) {
  const events = []
  const log = new Logger('info', {
    write(chunk) {
      const line = JSON.parse(chunk)
      events.push(line)
      return true
    },
  })
  const calls = []
  const client = {
    connected: true,
    session: { save: () => '' },
    async getDialogs() {
      calls.push('getDialogs')
      return [dialogRow()]
    },
    async invoke(request) {
      const name = request?.className ?? request?.constructor?.name
      calls.push(name)
      if (name === 'messages.GetHistory') {
        // offsetId = id + 1, limit 1: the newest message below the target.
        const rows = behavior.historyRows ?? [{ id: Number(MESSAGE) }]
        return { messages: rows }
      }
      if (name === 'messages.SendMessage') {
        if (behavior.onSend) return behavior.onSend()
        return new Api.UpdateShortSentMessage({
          id: 99,
          date: 1_700_000_000,
          pts: 1,
          ptsCount: 1,
        })
      }
      throw new Error(`unexpected request ${name}`)
    },
  }
  const cfg = config()
  const db = new Db(':memory:')
  db.saveSession({
    id: 's1',
    user_id: '42',
    first_name: 'Account',
    username: 'account',
    // `sendReply` really decrypts the stored string, unlike the LLM tests.
    enc_session: encrypt('', cfg.encKey, 'session:s1'),
    test_dc: 1,
    created_at: 1,
  })
  db.putAuthToken(hashToken(TOKEN), 's1', 1)
  const service = new TelegramAuthService({
    config: cfg,
    db,
    clients: { forSession: async () => client, forget: () => undefined },
    log,
  })
  return {
    service,
    calls,
    events,
    event: (name) => events.find((line) => line.event === name),
    close: () => db.close(),
  }
}

test('sendReply sends the trimmed text and returns Telegram id and time', async () => {
  const h = harness()
  try {
    const sent = await h.service.sendReply(TOKEN, CHAT, MESSAGE, '  hi  ')
    assert.deepEqual(sent, { id: '99', at: '2023-11-14T22:13:20.000Z' })
    assert.deepEqual(h.calls, ['getDialogs', 'messages.GetHistory', 'messages.SendMessage'])
    // The log carries the length, never the text.
    assert.equal(h.event('send.ok')?.chars, 2)
  } finally {
    h.close()
  }
})

test('a flood wait on send is 502 send, logged and not retried', async () => {
  const h = harness({
    onSend() {
      throw new errors.FloodWaitError({ capture: 7, request: null })
    },
  })
  try {
    await assert.rejects(
      h.service.sendReply(TOKEN, CHAT, MESSAGE, 'hi'),
      (err) => err instanceof ContractError && err.code === 'send' && err.status === 502,
    )
    assert.equal(h.calls.filter((name) => name === 'messages.SendMessage').length, 1)
    assert.equal(h.event('send.flood')?.seconds, 7)
  } finally {
    h.close()
  }
})

test('a number that is not in this dialog is 404 and nothing is sent', async () => {
  // offsetId = id + 1 returns the newest message below the target: id 6 means
  // the target itself is not in this dialog.
  const h = harness({ historyRows: [{ id: 6 }] })
  try {
    await assert.rejects(
      h.service.sendReply(TOKEN, CHAT, MESSAGE, 'hi'),
      (err) => err instanceof ContractError && err.status === 404,
    )
    assert.equal(h.calls.filter((name) => name === 'messages.SendMessage').length, 0)
    // Not a Telegram failure: no `send.failed` line for a request that never left.
    assert.equal(h.event('send.failed'), undefined)
  } finally {
    h.close()
  }
})

test('a send without a session is 401 before any RPC', async () => {
  const h = harness()
  try {
    await assert.rejects(
      h.service.sendReply(null, CHAT, MESSAGE, 'hi'),
      (err) => err instanceof ContractError && err.status === 401,
    )
    assert.deepEqual(h.calls, [])
  } finally {
    h.close()
  }
})
