/**
 * Demo switches for QA and screenshots: `?demo=chats-empty`, `?demo=a,b`.
 * They never appear in the product UI and change nothing unless the address
 * carries them, so the packaged build behaves as usual.
 */

const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
const flags = new Set(
  params
    .getAll('demo')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean),
)

export function hasDemoFlag(name: string): boolean {
  return flags.has(name)
}
