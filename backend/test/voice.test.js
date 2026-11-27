import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { Api } from 'teleproto'
import { ContractError } from '../dist/contract.js'
import { encrypt } from '../dist/crypto.js'
import { Db } from '../dist/db.js'
import { Logger } from '../dist/log.js'
import { hashToken } from '../dist/tokens.js'
import {
  messageSummaryOf,
  sendRandomId,
  TelegramAuthService,
  voiceRandomId,
} from '../dist/tg/service.js'
import { VoiceService } from '../dist/voice/service.js'

const TOKEN = 'voice-test-token'
const CHAT = 'user:42'
const MESSAGE = '7'

function logHarness() {
  const events = []
  const log = new Logger('info', {
    write(chunk) {
      events.push(JSON.parse(chunk))
      return true
    },
  })
  return { log, event: (name) => events.find((line) => line.event === name) }
}

function voiceMessage(id = Number(MESSAGE), voice = true, size = 10) {
  return new Api.Message({
    id,
    peerId: {},
    date: 1_700_000_000,
    message: '',
    media: new Api.MessageMediaDocument({
      document: new Api.Document({
        id: 1,
        accessHash: 1,
        fileReference: Buffer.alloc(0),
        date: 1,
        mimeType: 'audio/ogg',
        size,
        dcId: 2,
        attributes: [new Api.DocumentAttributeAudio({ voice, duration: 3 })],
      }),
    }),
  })
}

function serviceConfig() {
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
    llmBaseUrl: null,
    llmApiKey: null,
    llmModel: null,
    llmModels: [],
    whisperUrl: 'http://127.0.0.1:1',
    whisperModel: 'model.bin',
  }
}

function tgHarness(behavior = {}) {
  const { log, event } = logHarness()
  const calls = []
  const client = {
    connected: true,
    session: { save: () => '' },
    async getDialogs() {
      return [
        {
          id: { toString: () => '42' },
          title: 'Anton',
          name: 'Anton',
          isUser: true,
          isChannel: false,
          unreadCount: 1,
          message: { message: 'hi' },
          dialog: { readInboxMaxId: 0 },
          inputEntity: { className: 'InputPeerUser' },
        },
      ]
    },
    async invoke(request) {
      const name = request?.className ?? request?.constructor?.name
      calls.push(name)
      if (name === 'messages.GetHistory') {
        const rows = behavior.historyRows ?? [behavior.message ?? voiceMessage()]
        return { messages: rows }
      }
      if (name === 'messages.SendMedia') {
        calls.push(request)
        if (behavior.onSendMedia) return behavior.onSendMedia()
        return new Api.UpdateShortSentMessage({
          id: 88,
          date: 1_700_000_100,
          pts: 1,
          ptsCount: 1,
        })
      }
      throw new Error(`unexpected request ${name}`)
    },
    async uploadFile(params) {
      calls.push(['upload', params.file.name, params.file.size])
      return { className: 'InputFile' }
    },
    async downloadMedia() {
      calls.push('download')
      return behavior.download ?? Buffer.from('telegram-ogg')
    },
  }
  const cfg = serviceConfig()
  const db = new Db(':memory:')
  db.saveSession({
    id: 's1',
    user_id: '42',
    first_name: 'Account',
    username: 'account',
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
  return { service, calls, event, close: () => db.close() }
}

test('sendVoiceFile uploads voice.ogg with its own random_id, not the text one', async () => {
  const h = tgHarness()
  try {
    const sent = await h.service.sendVoiceFile(TOKEN, CHAT, MESSAGE, {
      path: 'C:\\temp\\voice.ogg',
      size: 1234,
      durationSec: 2.6,
    })
    assert.deepEqual(sent, { id: '88', at: '2023-11-14T22:15:00.000Z' })
    assert.deepEqual(
      h.calls.find((call) => call?.[0] === 'upload'),
      ['upload', 'voice.ogg', 1234],
    )

    const request = h.calls.find((call) => call?.className === 'messages.SendMedia')
    assert.ok(request)
    assert.equal(request.media.mimeType, 'audio/ogg')
    const attribute = request.media.attributes[0]
    assert.equal(attribute.voice, true)
    assert.equal(attribute.duration, 3)
    // Stable for retries of the same pair, but distinct from the text id:
    // Telegram dedupes across media types and would return the text message.
    assert.equal(String(request.randomId), voiceRandomId(CHAT, MESSAGE).toString())
    assert.notEqual(String(request.randomId), sendRandomId(CHAT, MESSAGE).toString())
    assert.equal(h.event('voice.ok')?.seconds, 3)
    // No transcript and no file name in the log.
    assert.ok(!JSON.stringify(h.event('voice.ok')).includes('voice.ogg'))
  } finally {
    h.close()
  }
})

test('a voice message is flagged for the page, a plain audio file is not', () => {
  const voice = messageSummaryOf(voiceMessage(12, true))
  assert.equal(voice.text, 'Voice message')
  assert.equal(voice.media, true)
  assert.equal(voice.voice, true)

  const audio = messageSummaryOf(voiceMessage(13, false))
  assert.equal(audio.text, 'Audio')
  assert.equal(audio.voice, undefined)
})

test('a voice send to a foreign message id is 404 and nothing is uploaded', async () => {
  const h = tgHarness({ historyRows: [] })
  try {
    await assert.rejects(
      h.service.sendVoiceFile(TOKEN, CHAT, MESSAGE, {
        path: 'C:\\temp\\voice.ogg',
        size: 10,
        durationSec: 1,
      }),
      (err) => err instanceof ContractError && err.status === 404,
    )
    assert.equal(h.calls.filter((call) => call?.[0] === 'upload').length, 0)
  } finally {
    h.close()
  }
})

test('voiceMessageOf downloads the voice note and reports its mime and duration', async () => {
  const h = tgHarness()
  try {
    const voice = await h.service.voiceMessageOf(TOKEN, CHAT, MESSAGE)
    assert.equal(voice.audio.toString(), 'telegram-ogg')
    assert.equal(voice.mime, 'audio/ogg')
    assert.equal(voice.durationSec, 3)
    assert.ok(h.calls.includes('download'))
  } finally {
    h.close()
  }
})

test('voiceMessageOf refuses a message that is not a voice note', async () => {
  const h = tgHarness({ message: voiceMessage(Number(MESSAGE), false) })
  try {
    await assert.rejects(
      h.service.voiceMessageOf(TOKEN, CHAT, MESSAGE),
      (err) => err instanceof ContractError && err.status === 400,
    )
    assert.ok(!h.calls.includes('download'))
  } finally {
    h.close()
  }
})

test('voiceMessageOf refuses an oversized voice note before downloading it', async () => {
  // The author sets `document.size`, and the page asks for a transcript by
  // itself: an unbounded download would land in memory with no one to ask.
  const h = tgHarness({ message: voiceMessage(Number(MESSAGE), true, 12 * 1024 * 1024) })
  try {
    await assert.rejects(
      h.service.voiceMessageOf(TOKEN, CHAT, MESSAGE),
      (err) => err instanceof ContractError && err.status === 400,
    )
    assert.ok(!h.calls.includes('download'))
    assert.equal(h.event('voice.refused')?.bytes, 12 * 1024 * 1024)
  } finally {
    h.close()
  }
})

function voiceHarness({ encode } = {}) {
  const { log, event } = logHarness()
  const calls = []
  let cleaned = 0
  const auth = {
    sessionId: (token) => (token === TOKEN ? 's1' : null),
    async sendVoiceFile(token, chatId, messageId, file) {
      calls.push({ token, chatId, messageId, file })
      return { id: '5', at: '2026-01-01T10:00:00.000Z' }
    },
  }
  const encoder =
    encode ??
    (async () => ({
      dir: {
        async cleanup() {
          cleaned += 1
        },
      },
      path: 'voice.ogg',
      size: 99,
      durationSec: 1.5,
    }))
  const service = new VoiceService({ log, auth, encode: encoder })
  return { service, calls, event, cleaned: () => cleaned }
}

test('the voice service decodes PCM, encodes it and removes the temp directory', async () => {
  const h = voiceHarness()
  const pcm = Buffer.alloc(32_000).toString('base64')
  const sent = await h.service.send(TOKEN, CHAT, MESSAGE, pcm)
  assert.deepEqual(sent, { id: '5', at: '2026-01-01T10:00:00.000Z' })
  assert.equal(h.calls[0].file.size, 99)
  assert.ok(Math.abs(h.calls[0].file.durationSec - 1.5) < 0.001)
  assert.equal(h.cleaned(), 1)
})

test('bad base64 and audio over 120 s are 400 without encoding', async () => {
  const h = voiceHarness()
  for (const audio of ['', '!!!!', Buffer.alloc(3_840_002).toString('base64')]) {
    await assert.rejects(
      h.service.send(TOKEN, CHAT, MESSAGE, audio),
      (err) => err instanceof ContractError && err.status === 400,
    )
  }
  assert.equal(h.calls.length, 0)
})

test('a 120 s voice note is accepted; a sample over is 400', async () => {
  // `/voice` has no recognition, so its limit stays at Telegram's 120 s while
  // `/stt` dropped to 45 s. The exact boundary is part of the contract.
  const h = voiceHarness()
  const sent = await h.service.send(
    TOKEN,
    CHAT,
    MESSAGE,
    Buffer.alloc(3_840_000).toString('base64'),
  )
  assert.deepEqual(sent, { id: '5', at: '2026-01-01T10:00:00.000Z' })
  assert.equal(h.calls.length, 1)

  await assert.rejects(
    h.service.send(TOKEN, CHAT, MESSAGE, Buffer.alloc(3_840_002).toString('base64')),
    (err) => err instanceof ContractError && err.status === 400,
  )
  assert.equal(h.calls.length, 1)
})

test('an unparseable message id is 404 before ffmpeg runs', async () => {
  let encodes = 0
  const h = voiceHarness({
    encode: async () => {
      encodes += 1
      return {
        dir: { async cleanup() {} },
        path: 'voice.ogg',
        size: 1,
        durationSec: 1,
      }
    },
  })
  await assert.rejects(
    h.service.send(TOKEN, CHAT, 'abcd', Buffer.alloc(320).toString('base64')),
    (err) => err instanceof ContractError && err.status === 404,
  )
  assert.equal(encodes, 0)
  assert.equal(h.calls.length, 0)
})

test('a failed conversion is 502 send and the encoder is not asked again', async () => {
  const h = voiceHarness({
    encode: async () => {
      throw new Error('ffmpeg is not there')
    },
  })
  await assert.rejects(
    h.service.send(TOKEN, CHAT, MESSAGE, Buffer.alloc(320).toString('base64')),
    (err) => err instanceof ContractError && err.code === 'send' && err.status === 502,
  )
  assert.equal(h.event('voice.failed')?.reason, 'convert')
  assert.equal(h.calls.length, 0)
})

test('the voice service refuses a request without a session', async () => {
  const h = voiceHarness()
  await assert.rejects(
    h.service.send(null, CHAT, MESSAGE, Buffer.alloc(320).toString('base64')),
    (err) => err instanceof ContractError && err.status === 401,
  )
  assert.equal(h.calls.length, 0)
})
