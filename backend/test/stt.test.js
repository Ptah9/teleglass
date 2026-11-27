import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { ContractError } from '../dist/contract.js'
import { Db } from '../dist/db.js'
import { Logger } from '../dist/log.js'
import { SttService, sttTimeoutMs } from '../dist/stt/service.js'
import { wavOf } from '../dist/audio/pcm.js'

const TOKEN = 'stt-test-token'
const MODEL = fileURLToPath(import.meta.url)

function config(overrides = {}) {
  return {
    whisperUrl: 'http://127.0.0.1:1',
    whisperModel: MODEL,
    ...overrides,
  }
}

function logHarness() {
  const events = []
  const log = new Logger('info', {
    write(chunk) {
      events.push(JSON.parse(chunk))
      return true
    },
  })
  return { log, event: (name) => events.find((line) => line.event === name), events }
}
/** A whisper-server stand-in: counts requests, remembers the body, answers text. */
async function fakeWhisper(answer = { text: 'hello there' }) {
  const requests = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      requests.push({ url: request.url, body })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(answer))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** A port that is known to be closed: bound once, then released. */
async function closedPort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

function harness({ url, model = MODEL, voiceCalls = { n: 0 } } = {}) {
  const db = new Db(':memory:')
  const { log, event, events } = logHarness()
  const auth = {
    sessionId: (token) => (token === TOKEN ? 's1' : null),
    async voiceMessageOf() {
      voiceCalls.n += 1
      // The bytes themselves do not matter: the converter is injected.
      return { audio: Buffer.from('fake-ogg'), mime: 'audio/ogg', durationSec: 3 }
    },
  }
  const convert = async () => wavOf(Buffer.alloc(3 * 32_000))
  const service = new SttService({
    config: config({ whisperUrl: url, whisperModel: model }),
    db,
    log,
    auth,
    convert,
  })
  return { service, db, event, events, voiceCalls, close: () => db.close() }
}

test('the recognition budget grows with the recording and stays clamped', () => {
  // 0.5 × duration + 8 s, never below 12 s (startup jitter) and never above
  // 25 s (a stuck request must not hold a whisper slot longer than that).
  assert.equal(sttTimeoutMs(0), 12_000)
  assert.equal(sttTimeoutMs(3_000), 12_000)
  assert.equal(sttTimeoutMs(20_000), 18_000)
  assert.equal(sttTimeoutMs(45_000), 25_000)
  assert.equal(sttTimeoutMs(120_000), 25_000)
})

test('a PCM recording is wrapped in a RIFF header and recognized once', async () => {
  const whisper = await fakeWhisper()
  const h = harness({ url: whisper.url })
  try {
    const pcm = Buffer.alloc(32_000) // one second of 16 kHz mono
    const result = await h.service.transcribe(TOKEN, pcm.toString('base64'), 'pcm')
    assert.deepEqual(result, { text: 'hello there', durationMs: 1000 })
    assert.equal(whisper.requests.length, 1)
    const body = whisper.requests[0].body
    // The WAV header is the backend's job: the phone sends bare PCM.
    assert.ok(body.includes(Buffer.from('RIFF')))
    assert.ok(body.includes(Buffer.from('WAVE')))
    // The provider parameters are part of the contract: auto-detect, JSON out.
    assert.ok(body.includes(Buffer.from('name="language"\r\n\r\nauto')))
    assert.ok(body.includes(Buffer.from('name="response_format"\r\n\r\njson')))
    assert.equal(h.event('stt.ok')?.cached, false)
    assert.equal(h.event('stt.ok')?.seconds, 1)
    // The transcript never reaches the log.
    assert.ok(!JSON.stringify(h.event('stt.ok')).includes('hello'))
  } finally {
    await whisper.close()
    h.close()
  }
})

test('a 45 s wav fits; one chunk over does not', async () => {
  const whisper = await fakeWhisper()
  const h = harness({ url: whisper.url })
  try {
    // Dictation is capped at 45 s: the full-length WAV reaches the provider,
    // and the RIFF header does not push it over the base64 precheck.
    const full = wavOf(Buffer.alloc(1_440_000))
    const result = await h.service.transcribe(TOKEN, full.toString('base64'), 'wav')
    assert.deepEqual(result, { text: 'hello there', durationMs: 45_000 })
    assert.equal(whisper.requests.length, 1)

    const over = wavOf(Buffer.alloc(1_440_064)) // 45 s + 2 ms
    await assert.rejects(
      h.service.transcribe(TOKEN, over.toString('base64'), 'wav'),
      (err) => err instanceof ContractError && err.status === 400,
    )
    assert.equal(whisper.requests.length, 1)
  } finally {
    await whisper.close()
    h.close()
  }
})

test('empty, broken and too long audio is 400 before the provider', async () => {
  const whisper = await fakeWhisper()
  const h = harness({ url: whisper.url })
  try {
    const cases = [
      '',
      'not base64!!',
      Buffer.alloc(3).toString('base64'), // odd number of PCM bytes
      Buffer.alloc(1_440_002).toString('base64'), // 45 s + 1 sample
      Buffer.alloc(3_840_002).toString('base64'), // 120 s + 1 sample
    ]
    for (const audio of cases) {
      await assert.rejects(
        h.service.transcribe(TOKEN, audio, 'pcm'),
        (err) => err instanceof ContractError && err.status === 400,
      )
    }
    assert.equal(whisper.requests.length, 0)
  } finally {
    await whisper.close()
    h.close()
  }
})

test('an unknown format is 400, not a pass-through', async () => {
  const whisper = await fakeWhisper()
  const h = harness({ url: whisper.url })
  try {
    await assert.rejects(
      h.service.transcribe(TOKEN, Buffer.alloc(320).toString('base64'), 'mp3'),
      (err) => err instanceof ContractError && err.status === 400,
    )
    assert.equal(whisper.requests.length, 0)
  } finally {
    await whisper.close()
    h.close()
  }
})

test('a dead whisper-server is 502 stt with stt.unavailable in the log', async () => {
  const port = await closedPort()
  const h = harness({ url: `http://127.0.0.1:${port}` })
  try {
    await assert.rejects(
      h.service.transcribe(TOKEN, Buffer.alloc(32_000).toString('base64'), 'pcm'),
      (err) => err instanceof ContractError && err.code === 'stt' && err.status === 502,
    )
    assert.ok(h.event('stt.unavailable'))
  } finally {
    h.close()
  }
})

test('silence (an empty answer) is 502 stt, never an empty screen', async () => {
  const whisper = await fakeWhisper({ text: '   ' })
  const h = harness({ url: whisper.url })
  try {
    await assert.rejects(
      h.service.transcribe(TOKEN, Buffer.alloc(32_000).toString('base64'), 'pcm'),
      (err) => err instanceof ContractError && err.code === 'stt' && err.status === 502,
    )
    assert.equal(h.event('stt.failed')?.reason, 'empty')
  } finally {
    await whisper.close()
    h.close()
  }
})

test('whisper\'s no-speech marker is not a transcript', async () => {
  // Real response to 5 s of digital silence: whisper.cpp returns the marker,
  // not an empty string. HEARD must not show `[BLANK_AUDIO]` as words.
  const whisper = await fakeWhisper({ text: ' [BLANK_AUDIO] ' })
  const h = harness({ url: whisper.url })
  try {
    await assert.rejects(
      h.service.transcribe(TOKEN, Buffer.alloc(32_000).toString('base64'), 'pcm'),
      (err) => err instanceof ContractError && err.code === 'stt' && err.status === 502,
    )
    assert.equal(h.event('stt.failed')?.reason, 'empty')
  } finally {
    await whisper.close()
    h.close()
  }
})

test('a missing model is stt.modelMissing and no request leaves', async () => {
  const whisper = await fakeWhisper()
  const h = harness({ url: whisper.url, model: 'C:\\definitely\\not\\here.bin' })
  try {
    await assert.rejects(
      h.service.transcribe(TOKEN, Buffer.alloc(32_000).toString('base64'), 'pcm'),
      (err) => err instanceof ContractError && err.code === 'stt' && err.status === 502,
    )
    assert.ok(h.event('stt.modelMissing'))
    assert.equal(whisper.requests.length, 0)
  } finally {
    await whisper.close()
    h.close()
  }
})

test('a voice message is downloaded and recognized once, then cached', async () => {
  const whisper = await fakeWhisper({ text: 'привет' })
  const voiceCalls = { n: 0 }
  const h = harness({ url: whisper.url, voiceCalls })
  try {
    const first = await h.service.transcribeMessage(TOKEN, 'user:42', '7')
    assert.deepEqual(first, { text: 'привет' })
    assert.equal(h.voiceCalls.n, 1)
    assert.equal(whisper.requests.length, 1)
    assert.equal(h.event('stt.ok')?.cached, false)

    const second = await h.service.transcribeMessage(TOKEN, 'user:42', '7')
    assert.deepEqual(second, { text: 'привет' })
    // No second download, no second provider call: only a database read.
    assert.equal(h.voiceCalls.n, 1)
    assert.equal(whisper.requests.length, 1)

    const cached = h.events.filter((line) => line.event === 'stt.ok').at(-1)
    assert.equal(cached?.cached, true)
  } finally {
    await whisper.close()
    h.close()
  }
})

test('the cache does not serve a request without a session', async () => {
  const whisper = await fakeWhisper()
  const h = harness({ url: whisper.url })
  try {
    await assert.rejects(
      h.service.transcribeMessage(null, 'user:42', '7'),
      (err) => err instanceof ContractError && err.status === 401,
    )
  } finally {
    await whisper.close()
    h.close()
  }
})
