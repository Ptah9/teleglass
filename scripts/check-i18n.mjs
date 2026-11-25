/**
 * Dictionary check before the build. Wired into `npm run build` — a failure
 * means a failing build, not an empty line on the glasses screen.
 *
 * Rules from i18n-strings.md, now stated in i18next terms:
 * 1. en and ru carry the same set of keys;
 * 2. a plural group (`key_one`, `key_few`, …) carries every plural category the
 *    language actually has, and no category it does not have;
 * 3. both languages use the same `{name}` arguments, including `{count}`;
 * 4. braces are balanced and nothing is left in the old ICU syntax;
 * 5. a string fits one line of its container, measured with the official
 *    `@evenrealities/pretext` (the same LVGL metrics the firmware uses);
 * 6. a context-menu item name is ≤ 32 bytes UTF-8 (firmware limit);
 * 7. every key and every plural form really resolves through i18next with the
 *    options the app uses.
 */

import { readFileSync } from 'node:fs'
import { getTextWidth } from '@evenrealities/pretext'
import i18next from 'i18next'
import { initOptions } from '../src/i18n/options.ts'

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

/**
 * Phone labels are not measured with `pretext`: it carries the glasses font
 * (LVGL metrics), and the phone renders in FK Grotesk Neue, whose files are not
 * in the repository (i18n-strings.md §7). Phone text wraps by design, so the
 * only hard budget is the 24 characters for a one-line button at 15 px.
 */
const PHONE_PREFIX = 'phone.'
const PHONE_ONE_LINE = new Set([
  'phone.auth.connect',
  'phone.auth.sendCode',
  'phone.auth.password.action',
  'phone.auth.link.open',
  'phone.auth.link.new',
  'phone.auth.link.usePhone',
  'phone.common.cancel',
  'phone.common.continue',
  'phone.common.retry',
  'phone.chats.save',
  'phone.llm.save',
  'phone.settings.checkNow',
  'phone.danger.disconnect.action',
  'phone.danger.delete.action',
  'phone.tabs.chats',
  'phone.tabs.agent',
  'phone.tabs.settings',
])
const PHONE_LABEL_CHARS = 24

/** i18next plural suffixes and the counts used to exercise them. */
const PLURAL = /_(zero|one|two|few|many|other)$/
const SAMPLE_COUNTS = [0, 1, 2, 5, 11, 21]

const errors = []

/** `phone.chats.selectedCount_one` → base `phone.chats.selectedCount`, form `one`. */
function group(dict) {
  const out = new Map()
  for (const [key, value] of Object.entries(dict)) {
    const m = PLURAL.exec(key)
    const base = m ? key.slice(0, m.index) : key
    if (!out.has(base)) out.set(base, { plain: null, forms: {} })
    const entry = out.get(base)
    if (m) entry.forms[m[1]] = String(value)
    else entry.plain = String(value)
  }
  return out
}

const grouped = { en: group(en), ru: group(ru) }
const bases = [...new Set([...grouped.en.keys(), ...grouped.ru.keys()])].sort()

/** `{name}` is the only placeholder the project allows; anything else is a bug. */
function placeholders(lang, key, text) {
  const out = new Set()
  const rest = text.replace(/\{(\w+)\}/g, (_, name) => {
    out.add(name)
    return ''
  })
  if (rest.includes('{') || rest.includes('}')) {
    errors.push(`${lang}.${key}: unsupported placeholder syntax (only {name} is allowed)`)
  }
  return out
}

/** Pixel budget for glasses keys, character budget for one-line phone buttons. */
function checkBudget(lang, key, text) {
  if (key.startsWith(PHONE_PREFIX)) {
    if (text.includes('\n')) {
      errors.push(`${lang}.${key}: \\n is layout, not translation, on the phone`)
    }
    if (PHONE_ONE_LINE.has(key)) {
      const length = [...text.replace(/\{\w+\}/g, '1')].length
      if (length > PHONE_LABEL_CHARS) {
        errors.push(`${lang}.${key}: ${length} characters > ${PHONE_LABEL_CHARS} for a one-line label`)
      }
    }
    return
  }

  // Measure the rendered form: placeholders are replaced by the shortest value.
  // Variable parts (names, message texts) are bounded by data budgets, not the dictionary.
  const limit = NARROW_PX[key] ?? LINE_PX
  const px = getTextWidth(text.replace(/\{\w+\}/g, '1'))
  if (px > limit) errors.push(`${lang}.${key}: ${px} px > ${limit} px`)

  if (BYTE_LIMIT.includes(key)) {
    if (Buffer.byteLength(text, 'utf8') > 32) errors.push(`${lang}.${key}: longer than 32 bytes UTF-8`)
  }
}

// 1. Base key parity (plural forms are checked per language below).
for (const base of bases) {
  if (!grouped.en.has(base)) errors.push(`missing in en.json: ${base}`)
  if (!grouped.ru.has(base)) errors.push(`missing in ru.json: ${base}`)
}

// 2–6. Content.
for (const base of bases) {
  const e = grouped.en.get(base)
  const r = grouped.ru.get(base)
  if (!e || !r) continue

  const isPlural = Object.keys(e.forms).length > 0 || Object.keys(r.forms).length > 0

  if (!isPlural) {
    const pa = placeholders('en', base, e.plain)
    const pb = placeholders('ru', base, r.plain)
    for (const p of pa) if (!pb.has(p)) errors.push(`ru.${base}: missing argument {${p}}`)
    for (const p of pb) if (!pa.has(p)) errors.push(`en.${base}: missing argument {${p}}`)
    checkBudget('en', base, e.plain)
    checkBudget('ru', base, r.plain)
    continue
  }

  // One style per key: forms only, no plain string next to them.
  if (e.plain !== null) errors.push(`en.${base}: plain value next to plural forms, use ${base}_one, …`)
  if (r.plain !== null) errors.push(`ru.${base}: plain value next to plural forms, use ${base}_one, …`)

  const union = { en: new Set(), ru: new Set() }
  for (const lang of ['en', 'ru']) {
    const entry = grouped[lang].get(base)
    const required = new Intl.PluralRules(lang).resolvedOptions().pluralCategories
    for (const category of required) {
      if (!(category in entry.forms)) {
        errors.push(`${lang}.${base}: no "${category}" form (${base}_${category})`)
      }
    }
    for (const category of Object.keys(entry.forms)) {
      if (!required.includes(category)) {
        errors.push(`${lang}.${base}: "${category}" is not a plural category of ${lang}`)
      }
      const key = `${base}_${category}`
      const found = placeholders(lang, key, entry.forms[category])
      for (const p of found) union[lang].add(p)
      checkBudget(lang, key, entry.forms[category])
    }
    if (!union[lang].has('count')) {
      errors.push(`${lang}.${base}: plural forms do not use {count}`)
    }
  }
  for (const p of union.en) if (!union.ru.has(p)) errors.push(`ru.${base}: missing argument {${p}}`)
  for (const p of union.ru) if (!union.en.has(p)) errors.push(`en.${base}: missing argument {${p}}`)
}

// 7. The real library must resolve every key with the options the app uses.
await i18next.init({
  ...initOptions,
  resources: {
    en: { translation: en },
    ru: { translation: ru },
  },
})
for (const base of bases) {
  for (const lang of ['en', 'ru']) {
    const t = i18next.getFixedT(lang)
    const entry = grouped[lang].get(base)
    if (entry && Object.keys(entry.forms).length > 0) {
      for (const count of SAMPLE_COUNTS) {
        const out = t(base, { count })
        if (typeof out !== 'string' || out === base || out.trim() === '') {
          errors.push(`${lang}.${base}: count=${count} did not resolve through i18next`)
        }
      }
    } else {
      const out = t(base)
      if (typeof out !== 'string' || out === base) {
        errors.push(`${lang}.${base}: did not resolve through i18next`)
      }
    }
  }
}

if (errors.length > 0) {
  console.error('i18n: FAILED')
  for (const e of errors) console.error('  - ' + e)
  process.exit(1)
}

const enLines = Object.keys(en).length
const ruLines = Object.keys(ru).length
console.log(
  `i18n: OK — ${bases.length} keys, ${enLines} en / ${ruLines} ru strings, parity and budgets respected`,
)
