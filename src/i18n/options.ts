import type { InitOptions } from 'i18next'

/**
 * i18next options shared by the app (`./index.ts`) and the build check
 * (`scripts/check-i18n.mjs`), so the check cannot pass against a configuration
 * the screens do not use.
 *
 * No resources here: the app adds the bundled JSON, the check adds the same
 * JSON read from disk.
 */
export const initOptions = {
  lng: 'en',
  fallbackLng: 'en',
  supportedLngs: ['en', 'ru'],
  // Inline resources: initialise before the first render, not in a timeout.
  initAsync: false,
  // Flat dotted keys, no nesting and no namespace prefix.
  keySeparator: false,
  nsSeparator: false,
  returnNull: false,
  interpolation: {
    // The project writes `{name}`, not i18next's default `{{name}}`.
    prefix: '{',
    suffix: '}',
    // Values go to plain text containers (glasses) and to React (which escapes
    // by itself), so HTML escaping here would only put `&amp;` on the screen.
    escapeValue: false,
  },
} satisfies InitOptions
