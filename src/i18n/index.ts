import { useMemo } from 'react'
import i18n from 'i18next'
import { initReactI18next, useTranslation } from 'react-i18next'
import en from './en.json'
import ru from './ru.json'
import { initOptions } from './options'

/**
 * One dictionary for both surfaces, served by i18next (see `i18n-strings.md` §7
 * and `ux-webview.md` §5). React screens read it through `useT()`, the glasses
 * page through `makeT(lang)` — `getFixedT`, so a redraw cannot pick up a
 * language that the phone has not applied yet.
 *
 * The strings keep the project notation: `{name}` for a value and `{count}` for
 * the number behind a plural form. Plural forms live in the JSON as `key_one`,
 * `key_few`, `key_many`, `key_other` — i18next's own layout — and code calls the
 * base key with `{ count }`.
 *
 * en/ru key parity, plural forms and length budgets are checked by
 * `scripts/check-i18n.mjs` in `npm run build`, so a missing key or a missing
 * plural form fails the build, not the glasses screen.
 */

export type Lang = 'en' | 'ru'
export type Args = Record<string, string | number>

type PluralSuffix = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'
type PluralBaseOf<K> = K extends `${infer Base}_${PluralSuffix}` ? Base : never

/**
 * Keys that code may pass to `t`. Plural forms are folded back into their base
 * key: nobody should call `selectedCount_few` by hand — `{ count }` picks it.
 */
export type Key =
  | Exclude<keyof typeof en, `${string}_${PluralSuffix}`>
  | PluralBaseOf<keyof typeof en>

export type TFunc = (key: Key, args?: Args) => string

/** i18next's own signature is generic and may return objects; this app uses `returnObjects: false`. */
type RawT = (key: string, options?: Record<string, unknown>) => string

void i18n.use(initReactI18next).init({
  ...initOptions,
  resources: {
    en: { translation: en },
    ru: { translation: ru },
  },
})

function bind(raw: unknown): TFunc {
  const t = raw as RawT
  return (key, args) => t(key, args)
}

/** Translator fixed to `lang`, for the non-React glasses renderer. */
export function makeT(lang: Lang): TFunc {
  return bind(i18n.getFixedT(lang))
}

/** Translator for React screens; re-renders them when the language changes. */
export function useT(): TFunc {
  const { t } = useTranslation()
  return useMemo(() => bind(t), [t])
}

/** The single place where the app language is switched. */
export function setLang(lang: Lang): void {
  if (i18n.resolvedLanguage !== lang) void i18n.changeLanguage(lang)
  if (typeof document !== 'undefined' && document.documentElement.lang !== lang) {
    document.documentElement.lang = lang
  }
}

export { i18n }
