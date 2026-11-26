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
    async setLlmKey(token, key) {
      calls.push(['setLlmKey', token, key])
    },
    async stop() {},
    ...overrides,
  }
  return { service, calls }
}

function request(method, path, { token, body, origin } = {}) {
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (origin) headers.origin = origin
  return { method, path, headers, body: body === undefined ? '' : body }
}

function deps(service, corsOrigins = ['http://localhost:5173']) {
  return { auth: service, log: silent, corsOrigins }
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
