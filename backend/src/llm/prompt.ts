/**
 * The whole prompt is built here, and it carries no identity: message text and
 * an in/out mark, nothing else. No chat title, no account name, no phone, no
 * user id — the model never learns who is talking.
 *
 * The language is declared, not requested (see `lang.ts`): "write in the
 * language of the conversation" makes the model follow the instruction's own
 * language, so the line is `Пиши по-русски.` / `Write in English.` and the
 * prompt itself stays Russian.
 */

import type { ChatMessage } from './provider.js'
import type { PromptLang } from './lang.js'

export type Tone = 'short' | 'warm' | 'formal'

/** One message per 500 characters, ten messages per request (task §4). */
export const CONTEXT_MESSAGES = 10
export const MESSAGE_CHARS = 500

/**
 * §4 p.7: ten messages, or `unread + 5` when that is smaller. An unknown
 * counter (0) keeps the full ten rather than starving the prompt.
 */
export function contextWindow(unread: number): number {
  if (!Number.isFinite(unread) || unread <= 0) return CONTEXT_MESSAGES
  return Math.min(CONTEXT_MESSAGES, Math.floor(unread) + 5)
}

export function toneOf(raw: string | null | undefined): Tone {
  return raw === 'warm' || raw === 'formal' ? raw : 'short'
}

export function langOfSettings(raw: string | null | undefined): PromptLang {
  return raw === 'ru' ? 'ru' : 'en'
}

const TONE_LINE: Record<Tone, string> = {
  short: 'Тон — short: 5–10 слов, коротко и по делу, без приветствия и лишних слов.',
  warm: 'Тон — warm: тепло и дружелюбно, с обращением к собеседнику; можно один эмодзи.',
  formal:
    'Тон — formal: вежливо, на «вы», без смайлов, без сокращений и сленга, полными фразами.',
}

export function buildSystem(lang: PromptLang, tone: Tone, long: boolean): string {
  const language = lang === 'ru' ? 'Пиши по-русски.' : 'Write in English.'
  const summary = long
    ? 'summary — краткое содержание сообщения, не более 90 знаков.'
    : 'summary — пустая строка "" (сообщение короткое).'
  return [
    'Ты помогаешь быстро ответить в мессенджере. Верни json по схеме.',
    'Схема: {"summary": "...", "replies": ["...", "...", "..."]}',
    language,
    TONE_LINE[tone],
    summary,
    'replies — ровно три разных варианта ответа, каждый не более 120 знаков, без нумерации и без кавычек.',
    'Не выдумывай факты: если в переписке нет ответа, варианты — уточняющий вопрос.',
    'Никаких ссылок, e-mail и телефонов, которых нет в переписке.',
  ].join('\n')
}

export interface TranscriptItem {
  text: string
  out: boolean
}

/**
 * The last messages up to (and including) the one being answered, each on one
 * line, media already a word. Cutting is by word so a sentence does not end
 * mid-word for no reason.
 */
export function buildUser(messages: readonly TranscriptItem[]): string {
  const window = messages.slice(-CONTEXT_MESSAGES)
  const lines = window.map((message) => {
    const who = message.out ? 'Исходящее' : 'Входящее'
    return `${who}: ${cutWords(flatten(message.text), MESSAGE_CHARS)}`
  })
  return [
    'Переписка, старые сообщения сверху:',
    ...lines,
    'Ответь на последнее входящее сообщение. Верни только json.',
  ].join('\n')
}

export function promptMessages(
  lang: PromptLang,
  tone: Tone,
  long: boolean,
  transcript: readonly TranscriptItem[],
): ChatMessage[] {
  return [
    { role: 'system', content: buildSystem(lang, tone, long) },
    { role: 'user', content: buildUser(transcript) },
  ]
}

function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function cutWords(text: string, max: number): string {
  const chars = [...text]
  if (chars.length <= max) return text
  let end = max - 1
  for (let i = end; i > Math.max(0, end - 40); i--) {
    if (/\s/.test(chars[i] ?? '')) {
      end = i
      break
    }
  }
  const kept = chars.slice(0, end).join('').trimEnd()
  return kept.length > 0 ? `${kept}…` : chars.slice(0, max).join('')
}
