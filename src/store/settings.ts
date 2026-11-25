import type { Lang } from '../i18n'
import { MOCK_QUICK_REPLY } from '../state/data'
import { DEFAULT_LLM_MODEL, isLlmModel, type LlmModel } from './llm'

/**
 * Settings owned by the phone WebView and consumed by the glasses page.
 *
 * Why `localStorage` and not the bridge storage: the official FAQ says
 * `localStorage` survives suspension, kill and updates, and `ux-webview.md`
 * still requires the language to live there. The glasses page keeps writing the
 * same language through the bridge (`setLocalStorage`) for its own restart path;
 * these two copies are reconciled on every boot in `App`.
 *
 * The whole blob is written on every change: the WebView may be suspended at
 * any moment (Android), so "save on blur" or an explicit Save button would lose
 * the last edit.
 */

export type Tone = 'short' | 'warm' | 'formal'

export interface Settings {
  lang: Lang
  quickReply: string
  tone: Tone
  /** `null` = every chat is shown on the glasses (the default). */
  selectedChats: string[] | null
  telegram: boolean
  /** Model for summaries and reply options; the key itself never lives here. */
  llmModel: LlmModel
}

/** Quick reply budget from ux-webview.md §3 (T3). */
export const QUICK_REPLY_MAX = 120

const KEY = 'teleglass.settings.v1'

export function detectLang(): Lang {
  if (typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('ru')) {
    return 'ru'
  }
  return 'en'
}

export function defaultSettings(): Settings {
  return {
    lang: detectLang(),
    quickReply: MOCK_QUICK_REPLY,
    tone: 'short',
    selectedChats: null,
    telegram: false,
    llmModel: DEFAULT_LLM_MODEL,
  }
}

function toneOf(raw: unknown): Tone {
  return raw === 'warm' || raw === 'formal' ? raw : 'short'
}

/** Never throws: a broken or old blob falls back to defaults field by field. */
export function loadSettings(): Settings {
  const fallback = defaultSettings()
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(KEY)
  } catch {
    return fallback
  }
  if (!raw) return fallback

  try {
    const parsed = JSON.parse(raw) as Partial<Settings>
    const quickReply =
      typeof parsed.quickReply === 'string'
        ? parsed.quickReply.slice(0, QUICK_REPLY_MAX)
        : fallback.quickReply
    const selectedChats = Array.isArray(parsed.selectedChats)
      ? parsed.selectedChats.filter((id): id is string => typeof id === 'string')
      : null
    return {
      lang: parsed.lang === 'ru' || parsed.lang === 'en' ? parsed.lang : fallback.lang,
      quickReply,
      tone: toneOf(parsed.tone),
      selectedChats: selectedChats && selectedChats.length > 0 ? selectedChats : null,
      telegram: parsed.telegram === true,
      llmModel: isLlmModel(parsed.llmModel) ? parsed.llmModel : fallback.llmModel,
    }
  } catch {
    return fallback
  }
}

export function saveSettings(s: Settings): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s))
  } catch (err) {
    // Private mode or a full quota: the field still works for this session,
    // it just will not survive a restart. Say so once, do not break the screen.
    console.warn('[teleglass] settings were not saved:', err)
  }
}

/**
 * "Delete all data": every key this app owns, not just the settings blob —
 * the demo auth step and a backend token live under the same prefix.
 */
export function clearAllLocalData(): void {
  try {
    const doomed: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (key?.startsWith('teleglass.')) doomed.push(key)
    }
    for (const key of doomed) window.localStorage.removeItem(key)
  } catch {
    /* nothing to clear */
  }
}
