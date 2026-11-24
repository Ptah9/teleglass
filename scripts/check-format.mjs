/**
 * Format check for the ICU subset, run by `npm run build`.
 *
 * Node runs the TypeScript directly (type stripping), so the check exercises
 * the same code the glasses get — a broken plural fails the build instead of
 * arriving on the screen as an empty line.
 */

import { formatMessage } from '../src/i18n/format.ts'

let failed = 0

const logError = console.error

/** Expected errors (bad input tests) must not pollute the build log. */
function quiet(fn) {
  console.error = () => {}
  try {
    return fn()
  } finally {
    console.error = logError
  }
}

function check(name, actual, expected) {
  if (actual === expected) return
  failed++
  console.error(`format: FAIL ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`)
}

check('plain text', formatMessage('en', 'tap — open'), 'tap — open')
check('argument', formatMessage('en', '{n} unread', { n: 3 }), '3 unread')
check('two arguments', formatMessage('en', '{chat} · {time}', { chat: 'IVAN', time: '19:31' }), 'IVAN · 19:31')

const pluralEn = '{n, plural, one{# item} other{# items}}'
check('en plural one', formatMessage('en', pluralEn, { n: 1 }), '1 item')
check('en plural other', formatMessage('en', pluralEn, { n: 5 }), '5 items')
check('en plural zero', formatMessage('en', pluralEn, { n: 0 }), '0 items')

const pluralRu = '{n, plural, one{# файл} few{# файла} many{# файлов} other{# файла}}'
check('ru plural one', formatMessage('ru', pluralRu, { n: 1 }), '1 файл')
check('ru plural few', formatMessage('ru', pluralRu, { n: 2 }), '2 файла')
check('ru plural many', formatMessage('ru', pluralRu, { n: 5 }), '5 файлов')
check('ru plural 21', formatMessage('ru', pluralRu, { n: 21 }), '21 файл')
check('ru plural 11', formatMessage('ru', pluralRu, { n: 11 }), '11 файлов')

check('sentence around plural', formatMessage('en', 'Inbox: {n, plural, one{# message} other{# messages}}.', { n: 2 }), 'Inbox: 2 messages.')
check('lone brace is text', formatMessage('en', 'a { b', {}), 'a { b')
check('missing argument is visible', quiet(() => formatMessage('en', '{n} unread', {})), '{n} unread')
check('non-numeric plural', quiet(() => formatMessage('en', pluralEn, { n: 'many' })), '{n}')
check('unknown format type', quiet(() => formatMessage('en', '{n, number}', { n: 3 })), '{n, number}')

if (failed > 0) {
  console.error(`format: ${failed} check(s) failed`)
  process.exit(1)
}
console.log('format: OK — ICU subset behaves')
