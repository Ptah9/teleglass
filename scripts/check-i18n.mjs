/**
 * Dictionary check before the build. Wired into `npm run build` — a failure
 * means a failing build, not an empty line on the glasses screen.
 *
 * Rules from i18n-strings.md:
 * 1. en and ru carry the same set of keys;
 * 2. both strings carry the same set of {name} arguments;
 * 3. braces are balanced;
 * 4. a string fits one line of its container, measured with the official
 *    `@evenrealities/pretext` (the same LVGL metrics the firmware uses);
 * 5. a context-menu item name is ≤ 32 bytes UTF-8 (firmware limit).
 */

import { readFileSync } from 'node:fs'
import { getTextWidth } from '@evenrealities/pretext'

const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'))
const ru = JSON.parse(readFileSync(new URL('../src/i18n/ru.json', import.meta.url), 'utf8'))

/**
 * One line of a full-width G2 text container: 576 − 2×20 = 536 px
 * (design-system.md §2). Every dictionary string is laid out by the firmware
 * at that width, so the check is the same measurement, not a character guess.
 */
const LINE_PX = 536

/** Keys that live in a narrower box than the body: their own pixel budget. */
const NARROW_PX = {
  /** Counter inside the chat header: "1/2", "10/10". */
  'page.counter': 70,
}

/** Context-menu items are limited by UTF-8 bytes, not pixels. */
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

  // Measure the rendered form: placeholders are replaced by the shortest value.
  // Variable parts (names, message texts) are bounded by data budgets, not the dictionary.
  const limit = NARROW_PX[k] ?? LINE_PX
  const fit = (x) => x.replace(/\{(\w+)(?:,\s*plural\s*,[\s\S]*?)?\}/g, '1')
  for (const [name, dict] of [
    ['en', a],
    ['ru', b],
  ]) {
    const px = getTextWidth(fit(dict))
    if (px > limit) errors.push(`${name}.${k}: ${px} px > ${limit} px`)
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
