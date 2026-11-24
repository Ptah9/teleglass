import en from './en.json'
import ru from './ru.json'
import { formatMessage, type Args } from './format'

/**
 * Dictionary and the ICU subset used by the screens (see `./format.ts`):
 *   {name}                        — argument substitution;
 *   {n, plural, one{…} other{…}}  — pluralization via `Intl.PluralRules`.
 * Full ICU is deliberately not implemented.
 *
 * en/ru key parity is checked by `scripts/check-i18n.mjs`; the message format
 * itself is checked by `scripts/check-format.mjs`. Both run in `npm run build`,
 * so a missing key or a broken plural fails the build, not the glasses screen.
 */

export type Lang = 'en' | 'ru'
export type Key = keyof typeof en
export type { Args }

const dicts: Record<Lang, Record<Key, string>> = {
  en,
  ru: ru as Record<Key, string>,
}

export function format(lang: Lang, template: string, args?: Args): string {
  return formatMessage(lang, template, args)
}

export type TFunc = (key: Key, args?: Args) => string

export function makeT(lang: Lang): TFunc {
  const dict = dicts[lang]
  return (key, args) => formatMessage(lang, dict[key], args)
}
