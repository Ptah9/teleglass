/**
 * Dictionary check before the build. Wired into `npm run build` — a failure
 * means a failing build, not an empty line on the glasses screen.
 *
 * Rules from i18n-strings.md:
 * 1. en and ru carry the same set of keys;
 * 2. both strings carry the same set of {name} arguments;
 * 3. braces are balanced;
 * 4. a string is not longer than the budget of its key (characters, not bytes);
 * 5. a context-menu item name is ≤ 32 bytes UTF-8 (firmware limit).
 */

import { readFileSync } from 'node:fs'

const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'))
const ru = JSON.parse(readFileSync(new URL('../src/i18n/ru.json', import.meta.url), 'utf8'))

/** Length budgets — the "Limit" column of i18n-strings.md §6, in characters. */
const LIMITS = {
  'app.name': 11,
  'idle.title': 20,
  'idle.empty': 50,
  'idle.stamp': 50,
  'idle.hint': 50,
  'chats.hint': 50,
  'chats.unread': 24,
  'chats.sending': 24,
  'chats.sent': 50,
  'chats.notSent': 50,
  'message.hint.next': 50,
  'message.hint.prev': 50,
  'chat.hint.short': 50,
  'chat.hint.long': 50,
  'chat.summaryBadge': 50,
  'fulltext.hint': 50,
  'chat.empty': 50,
  'chat.emptyHint': 50,
  'options.title': 20,
  'options.hint': 50,
  'options.sayIt': 24,
  'replies.emptyTitle': 20,
  'replies.emptyHint': 50,
  'confirm.title': 20,
  'confirm.to': 50,
  'confirm.hint': 50,
  'quickReply.title': 20,
  'quickReply.hint': 50,
  'quickReply.to': 50,
  'skip.title': 20,
  'skip.body': 50,
  'skip.meta': 24,
  'skip.hint': 50,
  'sent.title': 20,
  'sent.hint': 50,
  'error.title': 20,
  'error.body': 50,
  'error.sub': 50,
  'error.hint': 50,
  'voice.listening.title': 24,
  'voice.listening.hint': 50,
  'voice.listening.hintTap': 50,
  'voice.heard.title': 24,
  'voice.heard.hint': 50,
  'voice.heard.phoneMic': 24,
  'voice.heard.errorHint': 50,
  'voice.heard.longHint': 50,
  'voice.error.body': 50,
  'voice.tooLong': 50,
  'page.counter': 5,
  'demo.lang': 32,
  'demo.backend': 32,
  'demo.mic': 32,
}

/** Context-menu items are limited by UTF-8 bytes, not characters. */
const BYTE_LIMIT = ['demo.lang', 'demo.backend', 'demo.mic']

const errors = []

function keys(dict) {
  return Object.keys(dict).sort()
}

function placeholders(template) {
  const out = new Set()
  const re = /\{(\w+)(?=[,}])/g
  let m
  while ((m = re.exec(template)) !== null) out.add(m[1])
  return out
}

// 1. Key parity.
const enKeys = keys(en)
const ruKeys = keys(ru)
for (const k of enKeys) {
  if (!(k in ru)) errors.push(`missing in ru.json: ${k}`)
}
for (const k of ruKeys) {
  if (!(k in en)) errors.push(`missing in en.json: ${k}`)
}

// 2–4. Content of the shared keys.
for (const k of enKeys) {
  if (!(k in ru)) continue
  const a = String(en[k])
  const b = String(ru[k])

  if ((a.match(/\{/g) ?? []).length !== (a.match(/\}/g) ?? []).length) {
    errors.push(`en.${k}: unbalanced braces`)
  }
  if ((b.match(/\{/g) ?? []).length !== (b.match(/\}/g) ?? []).length) {
    errors.push(`ru.${k}: unbalanced braces`)
  }

  const pa = [...placeholders(a)]
  const pb = [...placeholders(b)]
  for (const p of pa) {
    if (!pb.includes(p)) errors.push(`ru.${k}: missing argument {${p}}`)
  }
  for (const p of pb) {
    if (!pa.includes(p)) errors.push(`en.${k}: missing argument {${p}}`)
  }

  if (/\{(\w+),\s*plural/.test(a) && !/other\{/.test(a)) {
    errors.push(`en.${k}: plural without an "other" branch`)
  }
  if (/\{(\w+),\s*plural/.test(b) && !/other\{/.test(b)) {
    errors.push(`ru.${k}: plural without an "other" branch`)
  }

  const limit = LIMITS[k]
  if (limit !== undefined) {
    // Measure the rendered form: placeholders are replaced by the shortest value.
    // Variable parts (names, message texts) are bounded by data budgets, not the dictionary.
    const fit = (x) => x.replace(/\{(\w+)(?:,\s*plural\s*,[\s\S]*?)?\}/g, '1')
    const lenA = [...fit(a)].length
    const lenB = [...fit(b)].length
    if (lenA > limit) errors.push(`en.${k}: ${lenA} chars > ${limit}`)
    if (lenB > limit) errors.push(`ru.${k}: ${lenB} chars > ${limit}`)
  }

  if (BYTE_LIMIT.includes(k)) {
    if (Buffer.byteLength(a, 'utf8') > 32) errors.push(`en.${k}: longer than 32 bytes UTF-8`)
    if (Buffer.byteLength(b, 'utf8') > 32) errors.push(`ru.${k}: longer than 32 bytes UTF-8`)
  }
}

if (errors.length > 0) {
  console.error('i18n: FAILED')
  for (const e of errors) console.error('  - ' + e)
  process.exit(1)
}

console.log(`i18n: OK — ${enKeys.length} keys, en/ru parity, budgets respected`)
