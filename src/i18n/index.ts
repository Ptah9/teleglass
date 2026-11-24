import en from './en.json'
import ru from './ru.json'

/**
 * Dictionary and a minimal ICU MessageFormat.
 *
 * Only the ICU subset the project needs is supported:
 *   {name}                      — argument substitution;
 *   {n, plural, one{…} few{…} many{…} other{…}} — pluralization.
 * Full ICU is deliberately not implemented: the G2 dictionary is fine with
 * this, and the phone WebView will take a ready library once it appears
 * (planned: Thu).
 *
 * en/ru key parity is checked by scripts/check-i18n.mjs, which is wired into
 * `npm run build` — a missing key fails the build.
 */

export type Lang = 'en' | 'ru'
export type Key = keyof typeof en
export type Args = Record<string, string | number>

const dicts: Record<Lang, Record<Key, string>> = {
  en,
  ru: ru as Record<Key, string>,
}

/** Plural categories come from the platform (`Intl.PluralRules`), not from hand-written rules. */
const pluralRules: Record<Lang, Intl.PluralRules> = {
  en: new Intl.PluralRules('en'),
  ru: new Intl.PluralRules('ru'),
}

/** Parse a plural body: `one{…} other{…}` → Map. Nested braces are not supported. */
function parsePlural(body: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /(\w+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) out.set(m[1]!, m[2]!)
  return out
}

export function format(lang: Lang, template: string, args?: Args): string {
  return template.replace(
    /\{(\w+)(?:\s*,\s*plural\s*,([\s\S]*?))?\}/g,
    (_all, name: string, plural?: string) => {
      const raw = args?.[name]
      if (plural === undefined) {
        if (raw === undefined) {
          console.error(`[teleglass] i18n: missing argument {${name}}`)
          return `{${name}}`
        }
        return String(raw)
      }
      const n = Number(raw)
      if (!Number.isFinite(n)) {
        console.error(`[teleglass] i18n: plural needs a numeric {${name}}`)
        return `{${name}}`
      }
      const options = parsePlural(plural)
      const category = pluralRules[lang].select(n)
      return options.get(category) ?? options.get('other') ?? ''
    },
  )
}

export type TFunc = (key: Key, args?: Args) => string

export function makeT(lang: Lang): TFunc {
  const dict = dicts[lang]
  return (key, args) => format(lang, dict[key], args)
}
