/**
 * Phone-side formatting. Kept out of the screens so the mask and the countdown
 * are testable and there is one copy of each rule.
 */

/**
 * Digits of a typed phone number. The mask follows the spec (`+7 999 123-45-67`);
 * a number without a country code is read as Russian, which is the demo case.
 * International numbers are accepted as typed: digits and a leading `+`.
 */
export function phoneDigits(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 0) return ''
  if (digits.startsWith('8')) return `7${digits.slice(1)}`
  if (digits.startsWith('9') && digits.length === 10) return `7${digits}`
  return digits
}

/** `+7 999 123-45-67` while typing; anything longer stays a plain `+digits`. */
export function formatPhone(digits: string): string {
  if (digits.length === 0) return ''
  if (digits.startsWith('7')) {
    const rest = digits.slice(1)
    const parts = [rest.slice(0, 3), rest.slice(3, 6), rest.slice(6, 8), rest.slice(8, 10)]
    let out = '+7'
    if (parts[0]) out += ` ${parts[0]}`
    if (parts[1]) out += ` ${parts[1]}`
    if (parts[2]) out += `-${parts[2]}`
    if (parts[3]) out += `-${parts[3]}`
    if (rest.length > 10) out += rest.slice(10)
    return out
  }
  return `+${digits}`
}

/** 10 digits (RU without the code) or 11–15 (E.164). Shorter cannot be sent. */
export function isPhoneValid(digits: string): boolean {
  return digits.length >= 10 && digits.length <= 15
}

/** `0:28` — one format for the link timer and the resend timer. */
export function countdown(deadline: number, now = Date.now()): string {
  const left = Math.max(0, Math.ceil((deadline - now) / 1000))
  const m = Math.floor(left / 60)
  const s = String(left % 60).padStart(2, '0')
  return `${m}:${s}`
}

/** Seconds left, clamped at 0. */
export function secondsLeft(deadline: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

/** `19:42` for "last checked". Locale does not matter for a clock. */
export function clockTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}
