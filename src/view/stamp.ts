import type { Lang } from '../i18n'

/**
 * Message stamps, the shape `ux-flow.md` asks for: today — `19:31`, another day —
 * `Nov 24 · 18:02` (EN) / `24 ноя · 18:02` (RU). Month is a word, not a number:
 * `24.11` reads two ways in English, and the demo is in English.
 *
 * Formatting goes through `Intl.DateTimeFormat` per locale; no hand-written
 * month tables. Telegram will send a unix timestamp and this formatter stays.
 */

const timeFmt = new Map<Lang, Intl.DateTimeFormat>()
const dayFmt = new Map<Lang, Intl.DateTimeFormat>()

function time(lang: Lang): Intl.DateTimeFormat {
  let f = timeFmt.get(lang)
  if (!f) {
    // h23: 19:31, not 07:31 PM — the G2 line is narrow and the spec is 24-hour.
    f = new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : 'en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    timeFmt.set(lang, f)
  }
  return f
}

function day(lang: Lang): Intl.DateTimeFormat {
  let f = dayFmt.get(lang)
  if (!f) {
    // en-US gives "Nov 24", ru-RU gives "24 нояб."; the trailing dot is Intl's
    // abbreviation marker and is cut for the screen.
    f = new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : 'en-US', {
      day: 'numeric',
      month: 'short',
    })
    dayFmt.set(lang, f)
  }
  return f
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

export function stamp(iso: string, lang: Lang, now: Date = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso

  const clock = time(lang).format(date)
  if (sameDay(date, now)) return clock
  return `${day(lang).format(date).replace(/\.$/, '')} · ${clock}`
}

/** `hh:mm` of the current moment — used by SENT (`19:43 · Ivan`). */
export function clockNow(lang: Lang, now: Date = new Date()): string {
  return time(lang).format(now)
}
