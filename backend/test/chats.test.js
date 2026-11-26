import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chatIdOf,
  chatSummaryOf,
  forwardQuery,
  historyQuery,
  messageQuery,
  messageSummaryOf,
  normalizePhone,
  oldestMessageId,
  prettyPhone,
} from '../dist/tg/service.js'

function dialog(overrides = {}) {
  return {
    id: { toString: () => '-100123' },
    title: 'Team',
    name: 'Team',
    isUser: false,
    isChannel: true,
    unreadCount: 3,
    message: { message: '  hello\nworld  ' },
    ...overrides,
  }
}

test('a chat row carries a stable id, one-line preview and unread count', () => {
  assert.deepEqual(chatSummaryOf(dialog()), {
    id: 'channel:-100123',
    title: 'Team',
    preview: 'hello world',
    unread: 3,
  })
})

test('user chats are marked as user, and a missing count is zero', () => {
  const row = chatSummaryOf(
    dialog({
      id: { toString: () => '42' },
      title: undefined,
      name: 'Anton',
      isUser: true,
      isChannel: false,
      unreadCount: undefined,
    }),
  )
  assert.equal(row.id, 'user:42')
  assert.equal(row.title, 'Anton')
  assert.equal(row.unread, 0)
})

test('a dialog without a last message is skipped', () => {
  assert.equal(chatSummaryOf(dialog({ message: undefined })), null)
})

test('a chat id carries the kind Telegram needs to resolve the peer', () => {
  assert.equal(chatIdOf(dialog()), 'channel:-100123')
  assert.equal(chatIdOf(dialog({ id: undefined })), null)
})

test('a title cannot bring a newline or a control character to the screen', () => {
  const row = chatSummaryOf(dialog({ title: '  Team\nred\u0007  ' }))
  assert.equal(row.title, 'Team red')
})

test('messages are read as the newest part of the unread window', () => {
  const entry = { peer: {}, readInboxMaxId: 500, unread: 5 }
  assert.deepEqual(messageQuery(entry, 30), { minId: 500, limit: 25 })
})

test('the fallback direction walks forward from the watermark', () => {
  assert.deepEqual(forwardQuery({ peer: {}, readInboxMaxId: 500, unread: 5 }), {
    minId: 500,
    reverse: true,
    limit: 25,
  })
})

test('without a watermark the newest messages are the fallback', () => {
  assert.deepEqual(messageQuery({ peer: {}, readInboxMaxId: 0, unread: 5 }, 30), { limit: 30 })
  assert.deepEqual(messageQuery({ peer: {}, readInboxMaxId: 0, unread: 5 }, 500), { limit: 50 })
})

test('the LLM history walks back from the oldest fetched message, capped', () => {
  assert.deepEqual(historyQuery(500, 30), { offsetId: 500, limit: 30 })
  assert.deepEqual(historyQuery(500, 500), { offsetId: 500, limit: 50 })
  assert.deepEqual(historyQuery(500, 0), { offsetId: 500, limit: 1 })
})

test('the history anchor is the oldest fetched id, not the newest', () => {
  assert.equal(oldestMessageId([{ id: 12 }, { id: 7 }, { id: 0 }]), 7)
  assert.equal(oldestMessageId([]), 0)
})

test('a message becomes an ISO stamp, its own newlines and an out flag', () => {
  assert.deepEqual(
    messageSummaryOf({
      id: 42,
      date: 1_700_000_000,
      message: '  hi\nthere  ',
      out: false,
    }),
    {
      id: '42',
      at: '2023-11-14T22:13:20.000Z',
      text: 'hi\nthere',
      out: false,
      media: false,
    },
  )
})

test('the message body is not cut like a list preview', () => {
  const long = 'word '.repeat(80).trim()
  const message = messageSummaryOf({ id: 3, date: 0, message: long, out: false })
  assert.equal(message.text.length, long.length)
})

test('media is a word on the glasses, never an empty body', () => {
  const message = messageSummaryOf({
    id: 7,
    date: 0,
    media: { className: 'MessageMediaPhoto' },
    out: true,
  })
  assert.equal(message.text, 'Photo')
  assert.equal(message.out, true)
  // A media word is not the author's text: the language rule must skip it.
  assert.equal(message.media, true)
})

test('phone numbers are normalised and pretty-printed', () => {
  assert.equal(normalizePhone('+7 (999) 123-45-67'), '+79991234567')
  assert.equal(normalizePhone('8 999 123 45 67'), '+89991234567')
  assert.throws(() => normalizePhone('123'))
  assert.throws(() => normalizePhone(null))
  assert.equal(prettyPhone('+79991234567'), '+7 999 123-45-67')
  assert.equal(prettyPhone('+442071234567'), '+442071234567')
})
