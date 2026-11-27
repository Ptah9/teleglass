import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'
import { ContractError } from '../dist/contract.js'
import { decrypt, encrypt } from '../dist/crypto.js'
import { Db } from '../dist/db.js'
import { langOf, scriptOf } from '../dist/llm/lang.js'
import { contextWindow } from '../dist/llm/prompt.js'
import { LlmService, parseAnswer } from '../dist/llm/service.js'
import { createOpenAiClient, LlmError } from '../dist/llm/provider.js'
import { Logger } from '../dist/log.js'
import { hashToken } from '../dist/tokens.js'

const TOKEN = 'test-bearer-token'

function config(overrides = {}) {
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
    llmApiKey: 'test-key',
    llmModel: 'deepseek-flash',
    llmModels: ['deepseek-flash', 'deepseek-v4-pro'],
    ...overrides,
  }
}

function setup(options = {}) {
  const cfg = config(options.config)
  const db = new Db(':memory:')
  db.saveSession({
    id: 's1',
    user_id: '42',
    first_name: 'Account',
    username: 'account',
    enc_session: 'v1:a:b:c',
    test_dc: 0,
    created_at: 1,
  })
  db.putAuthToken(hashToken(TOKEN), 's1', 1)
  db.putSettings(
    's1',
    {
      lang: options.lang ?? 'ru',
      quickReply: '',
      tone: options.tone ?? 'short',
      selectedChats: null,
      llmModel: options.model ?? 'deepseek-flash',
    },
    1,
  )
  const lines = []
  const log = new Logger('debug', {
    write(chunk) {
      lines.push(chunk)
      return true
    },
  })
  let messageCalls = 0
  const messageArgs = []
  const auth = {
    async messages(token, chatId, limit, withHistory) {
      messageCalls += 1
      messageArgs.push({ limit, withHistory })
      return options.messages ?? []
    },
    async unreadCount() {
      return options.unread ?? 0
    },
  }
  const service = new LlmService({
    config: cfg,
    db,
    log,
    auth,
    client: options.client,
  })
  return {
    db,
    cfg,
    service,
    lines,
    messageArgs,
    get messageCalls() {
      return messageCalls
    },
    close() {
      db.close()
    },
  }
}

function clientOf(answers) {
  const calls = []
  return {
    calls,
    async complete(messages, opts) {
      calls.push({ messages, opts })
      const next = answers[Math.min(calls.length - 1, answers.length - 1)]
      if (next instanceof Error) throw next
      return next
    },
  }
}

/**
 * A real HTTP endpoint on 127.0.0.1: the tests below need the production
 * client, not a stand-in, to see the body and headers the provider receives.
 */
function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}`,
        close() {
          server.closeAllConnections?.()
          server.close()
        },
      })
    })
  })
}

/** Answers in order (`null` = `content: null`), recording every request. */
async function jsonProvider(answers) {
  const calls = []
  const server = await listen((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const index = calls.length
      calls.push({ auth: req.headers.authorization, body: JSON.parse(raw) })
      const content = answers[Math.min(index, answers.length - 1)]
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content } }] }))
    })
  })
  return { ...server, calls }
}

const answer = JSON.stringify({
  summary: 'Кратко о встрече.',
  replies: ['Да, давай в 18:00.', 'Не смогу сегодня.', 'Давай завтра?'],
})

function message(id, text, out = false, media, voice) {
  return {
    id: String(id),
    at: '2026-11-26T10:00:00.000Z',
    text,
    out,
    ...(media === undefined ? {} : { media }),
    ...(voice === undefined ? {} : { voice }),
  }
}

test('language: Cyrillic wins, Latin wins, a tie falls back', () => {
  assert.equal(scriptOf('Привет, как дела?'), 'ru')
  assert.equal(scriptOf('Hello, how are you?'), 'en')
  assert.equal(scriptOf('Привет hello'), 'mixed')
  assert.equal(scriptOf('123 456'), 'none')
  // A media word produced by the backend is not the author's language.
  assert.equal(scriptOf('Photo', true), 'none')
})

test('language: the answered message decides; media inherits the previous incoming', () => {
  const messages = [
    message(1, 'Привет! Созвонимся?'),
    message(2, 'Да, давай.'),
    message(3, 'Photo', false, true),
  ]
  assert.equal(langOf(messages, 0, 'en'), 'ru')
  // Sticker/photo: the last textual incoming above, not the settings default.
  assert.equal(langOf(messages, 2, 'en'), 'ru')
  // Its own letters are Latin even though the previous message is Russian.
  const english = [message(1, 'Привет!'), message(2, 'Can we meet?')]
  assert.equal(langOf(english, 1, 'ru'), 'en')
  // No earlier text at all: the phone setting.
  assert.equal(langOf([message(1, 'Photo', false, true)], 0, 'en'), 'en')
})

test('a Russian message gets a hard Russian line in the prompt, not a request', async () => {
  const client = clientOf([answer])
  const s = setup({ messages: [message(1, 'Привет! Освободишься в 18:00?')], client })
  try {
    await s.service.replies(TOKEN, 'user:1', '1')
    const system = client.calls[0].messages[0].content
    assert.match(system, /Пиши по-русски\./)
    assert.doesNotMatch(system, /языке переписки/i)
    assert.match(system, /json/i)
    assert.match(system, /"summary"/)
    // The provider request itself carries the thinking switch.
    assert.equal(client.calls[0].opts.model, 'deepseek-flash')
  } finally {
    s.close()
  }
})

test('an English message gets "Write in English." even in a Russian chat', async () => {
  const client = clientOf([answer])
  const s = setup({
    lang: 'ru',
    messages: [message(1, 'Привет!'), message(2, 'Can we meet at 18:00?')],
    client,
  })
  try {
    await s.service.replies(TOKEN, 'user:1', '2')
    const system = client.calls[0].messages[0].content
    assert.match(system, /Write in English\./)
    assert.doesNotMatch(system, /Пиши по-русски/)
  } finally {
    s.close()
  }
})

test('the prompt holds at most ten messages of at most 500 characters', async () => {
  const long = 'word '.repeat(150).trim() // 749 characters
  const messages = Array.from({ length: 15 }, (_, i) => message(i + 1, `${i} ${long}`))
  const client = clientOf([answer])
  const s = setup({ messages, client })
  try {
    await s.service.replies(TOKEN, 'user:1', '15')
    const user = client.calls[0].messages[1].content
    const rows = user.split('\n').filter((line) => line.startsWith('Входящее: '))
    assert.equal(rows.length, 10)
    for (const row of rows) {
      assert.ok(row.length <= 'Входящее: '.length + 500, `${row.length} chars`)
    }
    // Nothing but the label and the text: no chat title, no account name.
    assert.doesNotMatch(user, /Account|user:1/)
  } finally {
    s.close()
  }
})

test('the answer is cleaned: numbering and quotes removed, lengths cut at words', () => {
  const longSummary = 'слово '.repeat(40).trim()
  const parsed = parseAnswer(
    JSON.stringify({
      summary: `«${longSummary}»`,
      replies: [
        '1. "Первый вариант"',
        `2) ${'вариант '.repeat(30)}`,
        '3. Третий',
      ],
    }),
    true,
  )
  assert.ok(parsed)
  assert.ok(parsed.summary.length <= 90, `summary ${parsed.summary.length}`)
  assert.ok(!parsed.summary.startsWith('«'))
  for (const reply of parsed.replies) {
    assert.ok(reply.length <= 120, `reply ${reply.length}`)
    assert.doesNotMatch(reply, /^\d[.)]\s/)
    assert.ok(!reply.startsWith('"'))
  }
  // A short message gets no summary at all, even if the model wrote one.
  const short = parseAnswer(answer, false)
  assert.equal(short.summary, '')
})

test('a short message without a summary still gives its three replies', () => {
  const parsed = parseAnswer(
    JSON.stringify({ replies: ['Да, давай.', 'Сейчас гляну.', 'Напишу позже.'] }),
    false,
  )
  assert.equal(parsed.summary, '')
  assert.equal(parsed.replies.length, 3)
})

test('the transcript shrinks to unread + 5 when that is smaller', async () => {
  const messages = Array.from({ length: 10 }, (_, index) => message(index + 1, `Строка ${index + 1}`))
  const client = clientOf([answer])
  const s = setup({ messages, unread: 1, client })
  try {
    const result = await s.service.replies(TOKEN, 'user:1', '10')
    assert.equal(result.replies.length, 3)
    const user = client.calls[0].messages[1].content
    const lines = user.split('\n').filter((line) => line.startsWith('Входящее:'))
    assert.equal(lines.length, 6)
  } finally {
    s.close()
  }
})

test('the context window keeps ten when the unread count is unknown', () => {
  assert.equal(contextWindow(0), 10)
  assert.equal(contextWindow(1), 6)
  assert.equal(contextWindow(5), 10)
  assert.equal(contextWindow(20), 10)
})

test('a voice note is answered from its cached transcript, not from the label', async () => {
  const client = clientOf([answer])
  const messages = [message(1, 'Пойдём есть?'), message(2, 'Voice message', false, true, true)]
  const s = setup({ messages, client })
  try {
    s.db.putSttCache('user:1', '2', 'Созвонимся в 19:00?', 3.2, Date.now())
    await s.service.replies(TOKEN, 'user:1', '2')
    const user = client.calls[0].messages[1].content
    assert.match(user, /19:00/)
    assert.doesNotMatch(user, /Voice message/)
  } finally {
    s.close()
  }
})

test('an answer cached for the label is not served once the transcript exists', async () => {
  const client = clientOf([answer])
  const s = setup({ messages: [message(1, 'Voice message', false, true, true)], client })
  try {
    await s.service.replies(TOKEN, 'user:1', '1')
    s.db.putSttCache('user:1', '1', 'Ты где?', 1.5, Date.now())
    await s.service.replies(TOKEN, 'user:1', '1')
    assert.equal(client.calls.length, 2)
    assert.match(client.calls[1].messages[1].content, /Ты где\?/)
  } finally {
    s.close()
  }
})

test('a bad answer is retried once, and a second failure is llm/badjson', async () => {
  const client = clientOf(['not json', 'still not json'])
  const s = setup({ messages: [message(1, 'Привет!')], client })
  try {
    await assert.rejects(
      s.service.replies(TOKEN, 'user:1', '1'),
      (err) => err instanceof ContractError && err.code === 'llm' && err.status === 502,
    )
    assert.equal(client.calls.length, 2)
    const bad = s.lines.filter((line) => line.includes('llm.badjson'))
    assert.equal(bad.length, 1)
    assert.equal(s.service.status(), 'error')
  } finally {
    s.close()
  }
})

test('an empty content is an error, and one good retry saves the request', async () => {
  const client = clientOf(['   ', answer])
  const s = setup({ messages: [message(1, 'Привет!')], client })
  try {
    const result = await s.service.replies(TOKEN, 'user:1', '1')
    assert.equal(result.replies.length, 3)
    assert.equal(client.calls.length, 2)
  } finally {
    s.close()
  }
})

test('the same message is served from the cache, the tone makes another key', async () => {
  const client = clientOf([answer])
  const s = setup({ messages: [message(1, 'Привет!')], client })
  try {
    await s.service.replies(TOKEN, 'user:1', '1')
    await s.service.replies(TOKEN, 'user:1', '1')
    assert.equal(client.calls.length, 1)
    const hits = s.lines.filter((line) => line.includes('llm.request') && line.includes('"cache":true'))
    assert.equal(hits.length, 1)

    s.db.putSettings(
      's1',
      { lang: 'ru', quickReply: '', tone: 'warm', selectedChats: null, llmModel: 'deepseek-flash' },
      2,
    )
    await s.service.replies(TOKEN, 'user:1', '1')
    assert.equal(client.calls.length, 2)
  } finally {
    s.close()
  }
})

test('no key: LLM is off and nothing goes out, not even to Telegram', async () => {
  const client = clientOf([answer])
  const s = setup({
    config: { llmApiKey: null },
    messages: [message(1, 'Привет!')],
    client,
  })
  try {
    assert.equal(s.service.status(), 'off')
    await assert.rejects(
      s.service.replies(TOKEN, 'user:1', '1'),
      (err) => err instanceof ContractError && err.code === 'llm' && err.status === 502,
    )
    assert.equal(client.calls.length, 0)
    assert.equal(s.messageCalls, 0)
  } finally {
    s.close()
  }
})

test('a provider refusal marks the status error until a real success', async () => {
  let calls = 0
  const client = {
    async complete() {
      calls += 1
      if (calls === 1) throw new LlmError('timeout')
      return answer
    },
  }
  const s = setup({
    messages: [message(1, 'Привет!'), message(2, 'Как дела?')],
    client,
  })
  try {
    assert.equal(s.service.status(), 'ok')
    await assert.rejects(s.service.replies(TOKEN, 'user:1', '1'))
    assert.equal(s.service.status(), 'error')

    // A later success clears the failure; without this the name of the test
    // promises more than it checks.
    const result = await s.service.replies(TOKEN, 'user:1', '2')
    assert.equal(result.replies.length, 3)
    assert.equal(s.service.status(), 'ok')
  } finally {
    s.close()
  }
})

test('the LLM asks Telegram for read history, not only the unread block', async () => {
  const s = setup({
    messages: [message(1, 'Привет')],
    client: clientOf([answer]),
  })
  try {
    await s.service.replies(TOKEN, 'user:1', '1')
    assert.deepEqual(s.messageArgs, [{ limit: 30, withHistory: true }])
  } finally {
    s.close()
  }
})

test('a T3 key works without an env key, and an unreadable blob turns it off', async () => {
  const client = clientOf([answer])
  const s = setup({
    config: { llmApiKey: null },
    messages: [message(1, 'Привет!')],
    client,
  })
  try {
    // No env key: only a readable T3 blob makes the LLM configured.
    assert.equal(s.service.status(), 'off')
    s.db.putLlmKey(encrypt('key-from-t3', s.cfg.encKey, 'llm'), 2)
    assert.equal(s.service.status(), 'ok')
    const result = await s.service.replies(TOKEN, 'user:1', '1')
    assert.equal(result.replies.length, 3)

    // A blob encrypted under a different master key is not usable; with no env
    // key the LLM must go back to `off` rather than send a broken key.
    s.db.putLlmKey(encrypt('other-master', randomBytes(32), 'llm'), 3)
    assert.equal(s.service.status(), 'off')
    // And the stored blob is a ciphertext, not the key.
    assert.notEqual(s.db.getLlmKey()?.includes('key-from-t3'), true)
  } finally {
    s.close()
  }
})

test('the T3 key decrypts with the configured master key', () => {
  const key = randomBytes(32)
  const blob = encrypt('sk-live-secret', key, 'llm')
  assert.equal(decrypt(blob, key, 'llm'), 'sk-live-secret')
  assert.equal(blob.includes('sk-live-secret'), false)
})

test('the T3 key wins over the env key and the request carries the provider switches', async () => {
  const provider = await jsonProvider([answer, answer])
  const s = setup({
    config: { llmBaseUrl: provider.url, llmApiKey: 'key-from-env' },
    messages: [message(1, 'Привет'), message(2, 'Как дела?')],
  })
  try {
    // No T3 key yet: the env key is what reaches the provider.
    await s.service.replies(TOKEN, 'user:1', '1')
    s.db.putLlmKey(encrypt('key-from-t3', s.cfg.encKey, 'llm'), 2)
    // A different message id, otherwise the cache hides the second call.
    await s.service.replies(TOKEN, 'user:1', '2')

    assert.equal(provider.calls.length, 2)
    assert.equal(provider.calls[0].auth, 'Bearer key-from-env')
    assert.equal(provider.calls[1].auth, 'Bearer key-from-t3')

    // The switches the provider must see on every request (26.11.2026).
    const body = provider.calls[0].body
    assert.equal(body.model, 'deepseek-flash')
    assert.equal(body.temperature, 0.3)
    assert.equal(body.max_tokens, 400)
    assert.deepEqual(body.response_format, { type: 'json_object' })
    assert.deepEqual(body.thinking, { type: 'disabled' })
    assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user'])
  } finally {
    provider.close()
    s.close()
  }
})

test('a provider that never answers aborts at the timeout', { timeout: 5000 }, async () => {
  const server = await listen(() => {})
  const client = createOpenAiClient(server.url, 'key')
  const started = Date.now()
  try {
    await assert.rejects(
      client.complete([{ role: 'user', content: 'hi' }], { model: 'm', timeoutMs: 120 }),
      (err) => err instanceof LlmError && err.reason === 'timeout',
    )
    assert.ok(Date.now() - started < 3000)
  } finally {
    server.close()
  }
})

test('a null content is an empty answer and gets the same single retry', async () => {
  const provider = await jsonProvider([null, answer])
  const s = setup({
    config: { llmBaseUrl: provider.url },
    messages: [message(1, 'Привет')],
  })
  try {
    const result = await s.service.replies(TOKEN, 'user:1', '1')
    assert.equal(provider.calls.length, 2)
    assert.equal(result.replies.length, 3)
  } finally {
    provider.close()
    s.close()
  }
})

test('two null contents are a bad answer, not a success', async () => {
  const provider = await jsonProvider([null, null])
  const s = setup({
    config: { llmBaseUrl: provider.url },
    messages: [message(1, 'Привет')],
  })
  try {
    await assert.rejects(
      s.service.replies(TOKEN, 'user:1', '1'),
      (err) => err instanceof ContractError && err.code === 'llm' && err.status === 502,
    )
    assert.equal(provider.calls.length, 2)
    assert.equal(s.service.status(), 'error')
  } finally {
    provider.close()
    s.close()
  }
})

test('replacing the account drops the LLM cache', () => {
  const s = setup({ messages: [] })
  try {
    s.db.putLlmCache('key', 'summary', ['a', 'b', 'c'], Date.now())
    assert.notEqual(s.db.getLlmCache('key', 0), null)
    s.db.saveSession({
      id: 's2',
      user_id: '7',
      first_name: 'Other',
      username: 'other',
      enc_session: 'v1:a:b:c',
      test_dc: 0,
      created_at: 2,
    })
    assert.equal(s.db.getLlmCache('key', 0), null)
  } finally {
    s.close()
  }
})

test('the reply endpoint admits twenty a minute per session', async () => {
  const client = clientOf([answer])
  const s = setup({ messages: [message(1, 'Привет')], client })
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    for (let i = 0; i < 20; i++) {
      // A missing message id is a 404 after the slot is taken: the budget is
      // spent the same way a real request spends it.
      await assert.rejects(
        s.service.replies(TOKEN, 'user:1', String(100 + i)),
        (err) => err instanceof ContractError && err.code === 'unknown',
      )
    }
    await assert.rejects(
      s.service.replies(TOKEN, 'user:1', '1'),
      (err) => err instanceof ContractError && err.code === 'llm' && err.status === 429,
    )
    // The window is one minute, not twenty forever: a minute later the budget
    // is fresh. Without moving the clock this test would pass even if it never ran out.
    now += 61_000
    await assert.rejects(
      s.service.replies(TOKEN, 'user:1', '999'),
      (err) => err instanceof ContractError && err.code === 'unknown',
    )
  } finally {
    Date.now = realNow
    s.close()
  }
})

test('one request per chat: a second while the first is in flight is 429', async () => {
  let open = () => {}
  const gate = new Promise((resolve) => {
    open = resolve
  })
  let inside = () => {}
  const entered = new Promise((resolve) => {
    inside = resolve
  })
  const client = {
    async complete() {
      inside()
      await gate
      return answer
    },
  }
  const s = setup({ messages: [message(1, 'Привет')], client })
  try {
    const first = s.service.replies(TOKEN, 'user:1', '1')
    await entered
    await assert.rejects(
      s.service.replies(TOKEN, 'user:1', '1'),
      (err) => err instanceof ContractError && err.code === 'llm' && err.status === 429,
    )
    open()
    const result = await first
    assert.equal(result.replies.length, 3)
  } finally {
    s.close()
  }
})
