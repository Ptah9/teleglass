/**
 * The ICU subset the project uses: `{name}` and `{n, plural, …}`.
 *
 * Kept free of imports so it can be exercised directly by
 * `scripts/check-format.mjs` (Node runs TypeScript here) and by the app.
 * The previous regex-based version could not see through nested braces: for
 * `{n, plural, one{# item} other{# items}}` it captured ` one{# item` and the
 * whole message rendered as an empty string. A scanner that counts braces does
 * not have that failure mode.
 *
 * Plural categories come from the platform (`Intl.PluralRules`), so a third
 * language needs no code change.
 */

export type Args = Record<string, string | number>

const pluralRules = new Map<string, Intl.PluralRules>()

function rulesFor(locale: string): Intl.PluralRules {
  let rules = pluralRules.get(locale)
  if (!rules) {
    rules = new Intl.PluralRules(locale)
    pluralRules.set(locale, rules)
  }
  return rules
}

/** Index of the brace that closes the one at `start`, or -1 if unbalanced. */
function closingBrace(text: string, start: number): number {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** `one{…} few{…} other{…}` → Map, braces counted so nested text is safe. */
function parseBranches(spec: string): Map<string, string> {
  const out = new Map<string, string>()
  let i = 0
  while (i < spec.length) {
    while (i < spec.length && !/[A-Za-z=]/.test(spec[i] ?? '')) i++
    const keyStart = i
    while (i < spec.length && /[A-Za-z=]/.test(spec[i] ?? '')) i++
    const key = spec.slice(keyStart, i)
    while (i < spec.length && spec[i] !== '{') i++
    if (key === '' || i >= spec.length) break
    const end = closingBrace(spec, i)
    if (end < 0) break
    out.set(key, spec.slice(i + 1, end))
    i = end + 1
  }
  return out
}

function argument(locale: string, body: string, args?: Args): string {
  const comma = body.indexOf(',')
  const name = (comma < 0 ? body : body.slice(0, comma)).trim()
  const value = args?.[name]

  if (comma < 0) {
    if (value === undefined) {
      console.error(`[teleglass] i18n: missing argument {${name}}`)
      return `{${name}}`
    }
    return String(value)
  }

  const rest = body.slice(comma + 1).trim()
  const kindEnd = rest.indexOf(',')
  const kind = (kindEnd < 0 ? rest : rest.slice(0, kindEnd)).trim()
  if (kind !== 'plural') {
    // `{n, number}` and friends are not part of the subset: show the raw body
    // instead of silently dropping the sentence.
    console.error(`[teleglass] i18n: unsupported format type "${kind}" in {${name}}`)
    return `{${body}}`
  }

  const n = Number(value)
  if (!Number.isFinite(n)) {
    console.error(`[teleglass] i18n: plural needs a numeric {${name}}`)
    return `{${name}}`
  }

  const branches = parseBranches(rest.slice(kindEnd + 1))
  const category = rulesFor(locale).select(n)
  const chosen = branches.get(category) ?? branches.get('other')
  if (chosen === undefined) {
    console.error(`[teleglass] i18n: plural {${name}} has no "${category}" or "other" branch`)
    return ''
  }
  return chosen.replace(/#/g, String(n))
}

export function formatMessage(locale: string, template: string, args?: Args): string {
  let out = ''
  let i = 0
  while (i < template.length) {
    const ch = template[i]
    if (ch !== '{') {
      out += ch
      i++
      continue
    }
    const end = closingBrace(template, i)
    if (end < 0) {
      // A lone brace is text, not a placeholder.
      out += ch
      i++
      continue
    }
    out += argument(locale, template.slice(i + 1, end), args)
    i = end + 1
  }
  return out
}
