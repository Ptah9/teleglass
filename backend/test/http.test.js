import assert from 'node:assert/strict'
import test from 'node:test'
import { ContractError } from '../dist/contract.js'
import { handle } from '../dist/http/handler.js'
import { Logger } from '../dist/log.js'

const silent = new Logger('error', { write: () => true })

function makeService(overrides = {}) {
  const calls = []
  const service = {
    boot() {},
    async health() {
      return { backend: 'ok', llm: 'off', checkedAt: '2026-01-01T00:00:00.000Z' }
    },
    async state(token) {
      calls.push(['state', token])
      return { step: 'idle' }
    },
    async sendCode(phone) {
      calls.push(['sendCode', phone])
      return { step: 'code', phone, resendAt: 5 }
    },
    async verifyCode(phone, code) {
      calls.push(['verifyCode', phone, code])
      return { step: 'connected', token: 'bearer' }
    },
    async verifyPassword(password) {
      calls.push(['verifyPassword', password])
      return { step: 'connected', token: 'bearer' }
    },
    async startLink() {
      calls.push(['startLink'])
      return { step: 'link', url: 'tg://login?token=x', expiresAt: 10 }
    },
    async linkState(token) {
      calls.push(['linkState', token])
      return { status: 'pending' }
    },
    async logout(token) {
      calls.push(['logout', token])
    },
    async deleteAll(token) {
      calls.push(['deleteAll', token])
    },
    async chats(token) {
      calls.push(['chats', token])
      return [{ id: 'user:1', title: 'Mom', preview: 'Hi' }]
    },
    async messages(token, chatId) {
      calls.push(['messages', token, chatId])
      return [{ id: '7', at: '2026-01-01T10:00:00.000Z', text: 'Hi', out: false }]
    },
    async putSettings(token, payload) {
      calls.push(['putSettings', token, payload])
    },
    async unreadCount() {
      return 0
    },
    async sendReply(token, chatId, messageId, text) {
      calls.push(['sendReply', token, chatId, messageId, text])
      return { id: '42', at: '2026-01-01T10:00:00.000Z' }
    },
    async markRead(token, chatId, messageId) {
      calls.push(['markRead', token, chatId, messageId])
    },
    async markChatRead(token, chatId) {
      calls.push(['markChatRead', token, chatId])
    },
    async setLlmKey(token, key) {
      calls.push(['setLlmKey', token, key])
    },
    async stop() {},
    ...overrides,
  }
  return { service, calls }
}

function makeLlm(overrides = {}) {
  const calls = []
  const llm = {
    status() {
      return 'off'
    },
    models(token) {
      calls.push(['models', token])
      return {
        models: [{ id: 'deepseek-flash', label: 'DeepSeek Flash' }],
        current: 'deepseek-flash',
      }
    },
    async replies(token, chatId, messageId) {
      calls.push(['replies', token, chatId, messageId])
      return { summary: 's', replies: ['a', 'b', 'c'] }
    },
    ...overrides,
  }
  return { llm, calls }
}

function makeStt(overrides = {}) {
  const calls = []
  const stt = {
    async transcribe(token, audio, format) {
      calls.push(['transcribe', token, audio.length, format])
      return { text: 'hello', durationMs: 1000 }
    },
    async transcribeMessage(token, chatId, messageId) {
      calls.push(['transcribeMessage', token, chatId, messageId])
      return { text: 'voice text' }
    },
    ...overrides,
  }
  return { stt, calls }
}

function makeVoice(overrides = {}) {
  const calls = []
  const voice = {
    async send(token, chatId, messageId, audio) {
      calls.push(['send', token, chatId, messageId, audio.length])
      return { id: '77', at: '2026-01-01T10:00:00.000Z' }
    },
    ...overrides,
  }
  return { voice, calls }
}

function request(method, path, { token, body, origin } = {}) {
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (origin) headers.origin = origin
  return { method, path, headers, body: body === undefined ? '' : body }
}

function deps(
  service,
  corsOrigins = ['http://localhost:5173'],
  llm = makeLlm().llm,
  stt = makeStt().stt,
  voice = makeVoice().voice,
) {
  return { auth: service, llm, stt, voice, log: silent, corsOrigins }
}

test('GET /health answers the probe', async () => {
  const { service } = makeService()
  const response = await handle(deps(service), request('GET', '/health'))
  assert.equal(response.status, 200)
  assert.match(response.headers['Content-Type'], /application\/json/)
  const body = JSON.parse(response.body)
  assert.equal(body.backend, 'ok')
  assert.equal(body.llm, 'off')
})

test('/health takes the LLM status from the LLM, not from a stored key', async () => {
  const { service } = makeService()
  for (const level of ['ok', 'error', 'off']) {
    const { llm } = makeLlm({
      status() {
        return level
      },
    })
    const response = await handle(deps(service, undefined, llm), request('GET', '/health'))
    assert.equal(response.status, 200)
    assert.equal(JSON.parse(response.body).llm, level)
  }
})

test('GET /llm/models lists the provider models and the chosen one', async () => {
  const { service } = makeService()
  const { llm, calls } = makeLlm()
  const response = await handle(deps(service, undefined, llm), request('GET', '/llm/models', { token: 't' }))
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), {
    models: [{ id: 'deepseek-flash', label: 'DeepSeek Flash' }],
    current: 'deepseek-flash',
  })
  assert.deepEqual(calls[0], ['models', 't'])
})

test('POST /llm/replies passes both ids and returns three options', async () => {
  const { service } = makeService()
  const { llm, calls } = makeLlm()
  const response = await handle(
    deps(service, undefined, llm),
    request('POST', '/llm/replies', {
      token: 't',
      body: JSON.stringify({ chatId: 'user:1', messageId: '42' }),
    }),
  )
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), { summary: 's', replies: ['a', 'b', 'c'] })
  assert.deepEqual(calls.at(-1), ['replies', 't', 'user:1', '42'])
})

test('a broken replies request is 400 and never reaches the LLM', async () => {
  const { service } = makeService()
  const { llm, calls } = makeLlm()
  for (const body of ['{', '[]', '{"chatId":"user:1"}', '{"chatId":"","messageId":"1"}']) {
    const response = await handle(
      deps(service, undefined, llm),
      request('POST', '/llm/replies', { token: 't', body }),
    )
    assert.equal(response.status, 400)
    assert.deepEqual(JSON.parse(response.body), { error: 'unknown' })
  }
  assert.equal(calls.length, 0)
})

test('an LLM refusal is 502 llm — the screen shows NO REPLIES', async () => {
  const { service } = makeService()
  const { llm } = makeLlm({
    async replies() {
      throw new ContractError('llm', 502)
    },
  })
  const response = await handle(
    deps(service, undefined, llm),
    request('POST', '/llm/replies', {
      token: 't',
      body: JSON.stringify({ chatId: 'user:1', messageId: '42' }),
    }),
  )
  assert.equal(response.status, 502)
  assert.deepEqual(JSON.parse(response.body), { error: 'llm' })
})

test('/api prefix is accepted, and GET /auth is idle without a token', async () => {
  const { service, calls } = makeService()
  const response = await handle(deps(service), request('GET', '/api/auth'))
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), { step: 'idle' })
  assert.deepEqual(calls[0], ['state', null])
})

test('the bearer token reaches the service unchanged', async () => {
  const { service, calls } = makeService()
  await handle(deps(service), request('GET', '/auth', { token: 'abc.def' }))
  assert.deepEqual(calls[0], ['state', 'abc.def'])
})

test('sendCode passes the phone and returns the code step', async () => {
  const { service } = makeService()
  const response = await handle(
    deps(service),
    request('POST', '/auth/phone', { body: JSON.stringify({ phone: '+79991234567' }) }),
  )
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), {
    step: 'code',
    phone: '+79991234567',
    resendAt: 5,
  })
})

test('a broken body is 400 unknown and never reaches Telegram', async () => {
  const { service, calls } = makeService()
  for (const body of ['{', '[]', '{"phone":""}', '{"phone":42}', '']) {
    const response = await handle(deps(service), request('POST', '/auth/phone', { body }))
    assert.equal(response.status, 400)
    assert.deepEqual(JSON.parse(response.body), { error: 'unknown' })
  }
  assert.equal(calls.length, 0)
})

test('Telegram failures become the contract code and status', async () => {
  const cases = [
    ['tooMany', 429],
    ['wrongCode', 400],
    ['expiredCode', 400],
    ['wrongPassword', 400],
    ['network', 502],
    ['linkExpired', 400],
    ['unknown', 400],
  ]
  for (const [code, status] of cases) {
    const { service } = makeService({
      async sendCode() {
        throw new ContractError(code, status)
      },
    })
    const response = await handle(
      deps(service),
      request('POST', '/auth/phone', { body: '{"phone":"+79991234567"}' }),
    )
    assert.equal(response.status, status, code)
    assert.deepEqual(JSON.parse(response.body), { error: code })
  }
})

test('unexpected failures are 500 unknown, not a stack trace', async () => {
  const { service } = makeService({
    async chats() {
      throw new Error('socket exploded +79991234567')
    },
  })
  const response = await handle(deps(service), request('GET', '/chats', { token: 't' }))
  assert.equal(response.status, 500)
  assert.deepEqual(JSON.parse(response.body), { error: 'unknown' })
  assert.ok(!response.body.includes('+7999'))
})

test('chats needs a token: the service says 401', async () => {
  const { service } = makeService({
    async chats() {
      throw new ContractError('unknown', 401)
    },
  })
  const response = await handle(deps(service), request('GET', '/chats'))
  assert.equal(response.status, 401)
  assert.deepEqual(JSON.parse(response.body), { error: 'unknown' })
})

test('chats returns the array as-is', async () => {
  const { service } = makeService()
  const response = await handle(deps(service), request('GET', '/chats', { token: 't' }))
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), [
    { id: 'user:1', title: 'Mom', preview: 'Hi' },
  ])
})

test('GET /chats/:id/messages decodes the chat id and returns the array', async () => {
  const { service, calls } = makeService()
  const response = await handle(
    deps(service),
    request('GET', '/chats/user%3A1/messages', { token: 't' }),
  )
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), [
    { id: '7', at: '2026-01-01T10:00:00.000Z', text: 'Hi', out: false },
  ])
  assert.deepEqual(calls.at(-1), ['messages', 't', 'user:1'])
})

test('a messages route without an id is not a messages route', async () => {
  const { service, calls } = makeService()
  const response = await handle(deps(service), request('GET', '/chats//messages', { token: 't' }))
  assert.equal(response.status, 404)
  assert.equal(calls.length, 0)
})

test('link state carries the token when it is issued', async () => {
  const { service } = makeService({
    async linkState() {
      return { status: 'connected', token: 'bearer' }
    },
  })
  const response = await handle(deps(service), request('GET', '/auth/link'))
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), { status: 'connected', token: 'bearer' })
})

test('settings accept null and an array, reject a missing field', async () => {
  const { service, calls } = makeService()
  const base = { lang: 'ru', quickReply: 'ok', tone: 'short', llmModel: 'gpt' }

  let response = await handle(
    deps(service),
    request('PUT', '/settings', {
      token: 't',
      body: JSON.stringify({ ...base, selectedChats: null }),
    }),
  )
  assert.equal(response.status, 200)
  assert.deepEqual(calls.at(-1)[2].selectedChats, null)

  response = await handle(
    deps(service),
    request('PUT', '/settings', {
      token: 't',
      body: JSON.stringify({ ...base, selectedChats: ['user:1', 'channel:2'] }),
    }),
  )
  assert.equal(response.status, 200)
  assert.deepEqual(calls.at(-1)[2].selectedChats, ['user:1', 'channel:2'])

  response = await handle(
    deps(service),
    request('PUT', '/settings', { token: 't', body: JSON.stringify(base) }),
  )
  assert.equal(response.status, 400)
})

test('logout and DELETE /data are wired, including the /api prefix', async () => {
  const { service, calls } = makeService()
  await handle(deps(service), request('POST', '/auth/logout', { token: 't' }))
  await handle(deps(service), request('DELETE', '/api/data', { token: 't' }))
  assert.deepEqual(calls, [
    ['logout', 't'],
    ['deleteAll', 't'],
  ])
})

test('CORS allows only configured origins', async () => {
  const { service } = makeService()
  const allowed = await handle(
    deps(service),
    request('GET', '/health', { origin: 'http://localhost:5173' }),
  )
  assert.equal(allowed.headers['Access-Control-Allow-Origin'], 'http://localhost:5173')

  const foreign = await handle(
    deps(service),
    request('GET', '/health', { origin: 'https://evil.example' }),
  )
  assert.equal(foreign.headers['Access-Control-Allow-Origin'], undefined)

  const preflight = await handle(
    deps(service),
    request('OPTIONS', '/auth/phone', { origin: 'http://localhost:5173' }),
  )
  assert.equal(preflight.status, 204)
  assert.match(preflight.headers['Access-Control-Allow-Headers'], /Authorization/)
  assert.match(preflight.headers['Access-Control-Allow-Methods'], /POST/)
})

test('unknown routes are 404 with the contract error shape', async () => {
  const { service } = makeService()
  const response = await handle(deps(service), request('GET', '/nope'))
  assert.equal(response.status, 404)
  assert.deepEqual(JSON.parse(response.body), { error: 'unknown' })
})

test('POST /chats/:id/send carries the text and answers id and time', async () => {
  const { service, calls } = makeService()
  const response = await handle(
    deps(service),
    request('POST', '/chats/user%3A1/send', {
      token: 't',
      body: JSON.stringify({ messageId: '7', text: 'Привет' }),
    }),
  )
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), { id: '42', at: '2026-01-01T10:00:00.000Z' })
  assert.deepEqual(calls.at(-1), ['sendReply', 't', 'user:1', '7', 'Привет'])
})

test('POST /send refuses a blank text before Telegram is touched', async () => {
  const { service, calls } = makeService()
  const response = await handle(
    deps(service),
    request('POST', '/chats/user%3A1/send', {
      token: 't',
      body: JSON.stringify({ messageId: '7', text: '   \n ' }),
    }),
  )
  assert.equal(response.status, 400)
  assert.deepEqual(JSON.parse(response.body), { error: 'unknown' })
  assert.equal(calls.length, 0)
})

test('POST /read marks one message and answers 204', async () => {
  const { service, calls } = makeService()
  const response = await handle(
    deps(service),
    request('POST', '/chats/user%3A1/read', {
      token: 't',
      body: JSON.stringify({ messageId: '7' }),
    }),
  )
  assert.equal(response.status, 204)
  assert.equal(response.body, '')
  assert.deepEqual(calls.at(-1), ['markRead', 't', 'user:1', '7'])
})

test('POST /read with an empty body marks the whole chat', async () => {
  const { service, calls } = makeService()
  const response = await handle(
    deps(service),
    request('POST', '/chats/user%3A1/read', { token: 't', body: '{}' }),
  )
  assert.equal(response.status, 204)
  assert.deepEqual(calls.at(-1), ['markChatRead', 't', 'user:1'])
})

test('POST /send without a bearer is 401 and the send is refused', async () => {
  const { service, calls } = makeService({
    async sendReply(token) {
      calls.push(['sendReply', token])
      throw new ContractError('unknown', 401)
    },
  })
  const response = await handle(
    deps(service),
    request('POST', '/chats/user%3A1/send', {
      body: JSON.stringify({ messageId: '7', text: 'hi' }),
    }),
  )
  assert.equal(response.status, 401)
  // The handler refuses without a bearer before the service is asked: the stub
  // would have recorded a call if the request had been passed on.
  assert.equal(calls.length, 0)
})

test('POST /send maps a refused send to 502 send', async () => {
  const { service } = makeService({
    async sendReply() {
      throw new ContractError('send', 502)
    },
  })
  const response = await handle(
    deps(service),
    request('POST', '/chats/user%3A1/send', {
      token: 't',
      body: JSON.stringify({ messageId: '7', text: 'hi' }),
    }),
  )
  assert.equal(response.status, 502)
  assert.deepEqual(JSON.parse(response.body), { error: 'send' })
})

test('POST /send keeps a foreign chat or message at 404', async () => {
  const { service } = makeService({
    async sendReply() {
      throw new ContractError('unknown', 404)
    },
  })
  const response = await handle(
    deps(service),
    request('POST', '/chats/user%3A999/send', {
      token: 't',
      body: JSON.stringify({ messageId: '7', text: 'hi' }),
    }),
  )
  assert.equal(response.status, 404)
  assert.deepEqual(JSON.parse(response.body), { error: 'unknown' })
})

test('POST /send refuses more than 4096 characters', async () => {
  const { service, calls } = makeService()
  const response = await handle(
    deps(service),
    request('POST', '/chats/user%3A1/send', {
      token: 't',
      body: JSON.stringify({ messageId: '7', text: 'x'.repeat(4097) }),
    }),
  )
  assert.equal(response.status, 400)
  assert.equal(calls.length, 0)
})

test('POST /read with a non-string messageId is a 400, not a whole chat', async () => {
  const { service, calls } = makeService()
  const response = await handle(
    deps(service),
    request('POST', '/chats/user%3A1/read', {
      token: 't',
      body: JSON.stringify({ messageId: 7 }),
    }),
  )
  assert.equal(response.status, 400)
  assert.equal(calls.length, 0)
})

test('POST /stt passes the audio and the format to the recognizer', async () => {
  const { service } = makeService()
  const { stt, calls } = makeStt()
  const audio = Buffer.alloc(640).toString('base64')
  const response = await handle(
    deps(service, undefined, undefined, stt),
    request('POST', '/stt', { token: 't', body: JSON.stringify({ audio, format: 'pcm' }) }),
  )
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), { text: 'hello', durationMs: 1000 })
  assert.deepEqual(calls.at(-1), ['transcribe', 't', audio.length, 'pcm'])
})

test('POST /stt without audio or format never reaches the recognizer', async () => {
  const { service } = makeService()
  const { stt, calls } = makeStt()
  for (const body of ['{"format":"pcm"}', '{"audio":"AAAA"}', '{"audio":"","format":"pcm"}']) {
    const response = await handle(
      deps(service, undefined, undefined, stt),
      request('POST', '/stt', { token: 't', body }),
    )
    assert.equal(response.status, 400)
  }
  assert.equal(calls.length, 0)
})

test('POST /stt without a bearer is 401 before the body is judged', async () => {
  const { service } = makeService()
  const { stt, calls } = makeStt()
  const response = await handle(
    deps(service, undefined, undefined, stt),
    request('POST', '/stt', { body: '{}' }),
  )
  assert.equal(response.status, 401)
  assert.equal(calls.length, 0)
})

test('POST /stt maps a dead provider to 502 stt', async () => {
  const { service } = makeService()
  const { stt } = makeStt({
    async transcribe() {
      throw new ContractError('stt', 502)
    },
  })
  const response = await handle(
    deps(service, undefined, undefined, stt),
    request('POST', '/stt', {
      token: 't',
      body: JSON.stringify({ audio: 'AAAA', format: 'pcm' }),
    }),
  )
  assert.equal(response.status, 502)
  assert.deepEqual(JSON.parse(response.body), { error: 'stt' })
})

test('POST /chats/:id/voice carries the audio and answers id and time', async () => {
  const { service } = makeService()
  const { voice, calls } = makeVoice()
  const audio = Buffer.alloc(320).toString('base64')
  const response = await handle(
    deps(service, undefined, undefined, undefined, voice),
    request('POST', '/chats/user%3A1/voice', {
      token: 't',
      body: JSON.stringify({ messageId: '7', audio }),
    }),
  )
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), { id: '77', at: '2026-01-01T10:00:00.000Z' })
  assert.deepEqual(calls.at(-1), ['send', 't', 'user:1', '7', audio.length])
})

test('POST /voice without a bearer is 401 before the audio is judged', async () => {
  const { service } = makeService()
  const { voice, calls } = makeVoice()
  const response = await handle(
    deps(service, undefined, undefined, undefined, voice),
    request('POST', '/chats/user%3A1/voice', {
      body: JSON.stringify({ messageId: '7', audio: 'AAAA' }),
    }),
  )
  assert.equal(response.status, 401)
  assert.equal(calls.length, 0)
})

test('POST /messages/:id/transcribe decodes both ids', async () => {
  const { service } = makeService()
  const { stt, calls } = makeStt()
  const response = await handle(
    deps(service, undefined, undefined, stt),
    request('POST', '/api/chats/user%3A1/messages/42/transcribe', { token: 't' }),
  )
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), { text: 'voice text' })
  assert.deepEqual(calls.at(-1), ['transcribeMessage', 't', 'user:1', '42'])
})
