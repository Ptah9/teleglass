/**
 * The reply language is the language of the message being answered — not of the
 * whole conversation (rule from 26.11.2026). A model told "write in the
 * language of the conversation" writes in the language of the instruction, so
 * the backend decides here and puts one hard line into the prompt.
 *
 * Letters decide, not scripts as a guess: Cyrillic against Latin. A tie or a
 * mixed message falls back to the phone's `lang`; a message without letters
 * (sticker, photo, emoji, voice) inherits the nearest earlier incoming text.
 */

export type PromptLang = 'ru' | 'en'

/** Both scripts present with close counts — no single answer. */
const BALANCE = 0.75

export type ScriptVerdict = PromptLang | 'mixed' | 'none'

/**
 * `media` is the backend's own marker that `text` is a word (`Photo`), not the
 * author's letters. It is not a language, so it counts as "no letters".
 */
export function scriptOf(text: string, media = false): ScriptVerdict {
  if (media) return 'none'
  const cyrillic = (text.match(/\p{Script=Cyrillic}/gu) ?? []).length
  const latin = (text.match(/\p{Script=Latin}/gu) ?? []).length
  if (cyrillic === 0 && latin === 0) return 'none'
  if (cyrillic === 0) return 'en'
  if (latin === 0) return 'ru'
  const min = Math.min(cyrillic, latin)
  const max = Math.max(cyrillic, latin)
  if (min / max >= BALANCE) return 'mixed'
  return cyrillic > latin ? 'ru' : 'en'
}

export interface LangSource {
  text: string
  out: boolean
  media?: boolean
}

/**
 * The message at `index` decides; the phone's `lang` is the last resort.
 */
export function langOf(
  messages: readonly LangSource[],
  index: number,
  fallback: PromptLang,
): PromptLang {
  const target = messages[index]
  if (!target) return fallback
  const own = scriptOf(target.text, target.media === true)
  if (own === 'ru' || own === 'en') return own
  if (own === 'mixed') return fallback

  // No letters: the last textual incoming message above decides, one decision.
  for (let i = index - 1; i >= 0; i--) {
    const previous = messages[i]
    if (!previous || previous.out) continue
    const verdict = scriptOf(previous.text, previous.media === true)
    if (verdict === 'none') continue
    return verdict === 'mixed' ? fallback : verdict
  }
  return fallback
}
