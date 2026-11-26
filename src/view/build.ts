import type { TFunc } from '../i18n'
import { chatById, chatLabel, unreadMsgs, visibleChats } from '../state/reducer'
import type { AppState, Screen } from '../state/types'
import { clipLines, cutBytes, cutChars, cutToChars, cutToPx, byteLength, lineCount, textWidth } from '../state/wrap'
import * as LINES from '../state/limits'
import { stamp } from './stamp'
import { BORDER, LIST_ROWS, LIST_ROW, LVL, SLOT } from './geometry'

/**
 * Pure screen assembly: (state, dictionary) → set of containers.
 * No SDK and no events — this module can be called from tests and from the
 * browser preview alike.
 *
 * Redraw saving rule: `shape` describes the SET of containers.
 * Same shape = update text only (textContainerUpgrade),
 * different = full rebuild. The list changes only via rebuild —
 * that is a firmware limitation, not our choice.
 */

export interface ViewText {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly content: string
  readonly level: 1 | 2 | 3 | 4
  readonly border?: { width: number; color: number; radius: number }
  /** Exactly one container per screen captures events. */
  readonly capture?: boolean
}

export interface ViewList {
  readonly id: 'list'
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly items: string[]
  readonly sel: number
}

export interface View {
  /** container ids; identical → texts can be updated without rebuild. */
  readonly shape: string
  readonly texts: ViewText[]
  readonly list?: ViewList
}

/** Shared with the logic so the footer hint and the gesture cannot disagree. */
const BODY_LINES = LINES.BODY_LINES
const SUMMARY_LINES = LINES.SUMMARY_LINES
const FULLTEXT_MAX_CHARS = LINES.FULLTEXT_MAX_CHARS
/** A list row is capped at 64 characters (design-system.md §2, display.md). */
const LIST_ITEM_CHARS = 64
/**
 * The firmware rejects a list item above 63 UTF-8 bytes (simulator 26.11.2026,
 * `RebuildPageContainer validation failed: list item text length 79 exceeds
 * limit of 63 bytes`). Cyrillic is two bytes per letter, so this is the real cap.
 */
const LIST_ITEM_BYTES = 63

/**
 * LISTENING indicator: the official block ramp (design-guidelines § Glyphs).
 * One column per SDK audio chunk, the newest on the right.
 */
const WAVE = '▁▂▃▄▅▆▇█'
/** 26 blocks × 20 px = 520 px — the whole 536 px working width (measured). */
const WAVE_LEN = LINES.WAVE_LEN

/** Microphone levels → the block ramp. Silence pads the left side. */
function waveOf(levels: readonly number[]): string {
  const tail = levels
    .slice(-WAVE_LEN)
    .map((l) => WAVE[Math.min(7, Math.max(0, Math.round(l * 7)))] ?? WAVE[0]!)
    .join('')
  return (WAVE[0] ?? '').repeat(WAVE_LEN - tail.length) + tail
}

/** Text without coordinates: the slot fills them in. */
type TextSpec = Omit<ViewText, 'x' | 'y' | 'w' | 'h'> & { slot?: string }

function at(slot: string, spec: TextSpec): ViewText {
  const r = SLOT[slot] ?? SLOT.body
  return { ...spec, x: r.x, y: r.y, w: r.w, h: r.h }
}

function textsOf(specs: TextSpec[]): ViewText[] {
  return specs.map((spec) => at(spec.slot ?? 'body', spec))
}

/**
 * List window. The firmware centers the row block inside the window (measured:
 * 3 rows in 160 px → 20 px above and below), so "window over all free space"
 * with an incomplete list leaves black bands around the rows. Rule: rows go down
 * from the divider, window height = min(rows, visible rows) × 40.
 */
function listRect(count: number): { x: number; y: number; w: number; h: number } {
  const h = Math.min(count, LIST_ROWS) * LIST_ROW
  return { x: SLOT.body.x, y: SLOT.body.y, w: SLOT.body.w, h }
}

/**
 * Divider — a 1 px container with a border, not a "─" string: on a text line the
 * firmware wraps the 46th char and draws a false scrollbar on the right
 * (measured: 4×10 px at x546). Same container count — the text in it is empty.
 */
function dividerSpec(id: 'divider' | 'divider2'): TextSpec {
  return {
    id,
    slot: id,
    content: '',
    level: LVL.divider,
    border: { width: 1, color: BORDER.divider, radius: 0 },
  }
}

function shapeOf(texts: ViewText[], list?: ViewList): string {
  return texts.map((x) => x.id).join('+') + (list ? '+list' : '')
}

export function buildView(s: AppState, t: TFunc): View {
  switch (s.screen.kind) {
    case 'chats':
      return chatsView(s, t)
    case 'chat':
      return chatView(s, t)
    case 'chatEmpty':
      return chatEmptyView(s, t, s.screen.chatId)
    case 'fulltext':
      return fulltextView(s, t)
    case 'replies':
      return repliesView(s, t)
    case 'repliesLoading':
      return repliesLoadingView(t)
    case 'repliesEmpty':
      return repliesEmptyView(s, t)
    case 'confirm':
      return confirmView(s, t)
    case 'quickConfirm':
      return quickConfirmView(s, t)
    case 'skipConfirm':
      return skipConfirmView(s, t)
    case 'sending':
      return sendingView(s, t)
    case 'sent':
      return sentView(s, t)
    case 'offline':
      return offlineView(s, t)
    case 'listening':
      return listeningView(s, t)
    case 'heard':
      return heardView(s, t)
  }
}

// ---------------------------------------------------------------------------
// CHATS.
// ---------------------------------------------------------------------------

function chatsView(s: AppState, t: TFunc): View {
  // Telegram is not linked: there is no list to show, and the only place that
  // can fix it is the phone (ux-flow.md inventory, «Connect Telegram on your
  // phone.»). The footer stays empty — no gesture on this screen does anything.
  if (!s.telegramConnected) {
    const texts = textsOf([
      { id: 'title', slot: 'title', content: t('idle.title'), level: LVL.main },
      dividerSpec('divider'),
      { id: 'body', slot: 'body', content: t('idle.setup'), level: LVL.body, capture: true },
      { id: 'footer', slot: 'footer', content: '', level: LVL.caption },
    ])
    return { shape: shapeOf(texts), texts }
  }

  // A connected account has two honest states before the list exists; neither
  // falls back to the demo chats.
  if (s.feedStatus === 'loading') {
    const texts = textsOf([
      { id: 'title', slot: 'title', content: t('idle.title'), level: LVL.main },
      dividerSpec('divider'),
      { id: 'body', slot: 'body', content: t('chats.loading'), level: LVL.body, capture: true },
      { id: 'footer', slot: 'footer', content: '', level: LVL.caption },
    ])
    return { shape: shapeOf(texts), texts }
  }

  if (s.feedStatus === 'error') {
    const texts = textsOf([
      { id: 'title', slot: 'title', content: t('idle.title'), level: LVL.main },
      dividerSpec('divider'),
      { id: 'body', slot: 'body', content: t('chats.error'), level: LVL.body, capture: true },
      { id: 'footer', slot: 'footer', content: t('chats.retry'), level: LVL.caption },
    ])
    return { shape: shapeOf(texts), texts }
  }

  const visible = visibleChats(s)

  // The CHATS footer changes with the quick reply state: normal, sent (2 s), not sent.
  const footer = s.flash
    ? s.flash.key === 'sent'
      ? t('chats.sent', { chat: s.flash.person })
      : t('chats.notSent')
    : t('chats.hint')

  if (visible.length === 0) {
    // ux-flow: an empty list has nothing to open, so the footer offers the only
    // action that exists — checking again.
    const texts = textsOf([
      { id: 'title', slot: 'title', content: t('idle.title'), level: LVL.main },
      dividerSpec('divider'),
      { id: 'body', slot: 'body', content: t('idle.empty'), level: LVL.body, capture: true },
      { id: 'sub', slot: 'sub', content: t('idle.stamp', { time: s.lastChecked }), level: LVL.caption },
      { id: 'footer', slot: 'footer', content: t('idle.hint'), level: LVL.caption },
    ])
    return { shape: shapeOf(texts), texts }
  }

  // List window: rows are fixed by the firmware (40 px), the window is a whole
  // number of rows. That way the firmware clips and pages the list neatly on its
  // own; a window that is not a multiple of 40 (e.g. 182 px) lets a partial row
  // spill onto the footer (measured).
  // Chat row: "IVAN · PROJECT · 19:31 (3)" — the counter in (n) format
  // (ux-flow, «Что макет добавил сам» №1), the time of the last message like
  // Telegram shows it; while sending — "· sending…".
  const items = visible.map((c) => {
    const last = c.messages[c.messages.length - 1]
    const time = last ? stamp(last.at, s.lang) : '—'
    const n = unreadMsgs(c, s.read).length
    const suffix = s.sendingRow === c.id ? ` · ${t('chats.sending')}` : ''
    // A native row is one 536 px line: the name gets whatever is left after the
    // time, the counter and the sending suffix, cut by width. The 64-character
    // cap is the platform's own item limit, so it bounds the whole item too.
    const tail = t('chats.row', { chat: '', time, n }) + suffix
    const room = Math.max(1, SLOT.body.w - textWidth(tail))
    // The whole row must stay under the firmware's byte cap: give the name
    // whatever the time, counter and suffix leave.
    const name = cutToPx(
      cutBytes(chatLabel(c).toUpperCase(), Math.max(4, LIST_ITEM_BYTES - byteLength(tail))),
      room,
    )
    return cutBytes(t('chats.row', { chat: name, time, n }) + suffix, LIST_ITEM_BYTES)
  })

  const texts = textsOf([
    { id: 'title', slot: 'title', content: t('idle.title'), level: LVL.main },
    dividerSpec('divider'),
    { id: 'footer', slot: 'footer', content: footer, level: LVL.caption },
  ])
  const list: ViewList = {
    id: 'list',
    ...listRect(items.length),
    items,
    // Selection is an index in the full list: the firmware pages the list and
    // keeps the highlight on a visible row.
    sel: Math.min(Math.max(s.selChat, 0), items.length - 1),
  }
  return { shape: shapeOf(texts, list), texts, list }
}

// ---------------------------------------------------------------------------
// CHAT, empty CHAT, FULL TEXT.
// ---------------------------------------------------------------------------

function chatView(s: AppState, t: TFunc): View {
  const scr = s.screen
  if (scr.kind !== 'chat') return chatsView(s, t)
  const chat = chatById(s, scr.chatId)
  if (!chat) return chatsView(s, t)
  const msgs = unreadMsgs(chat, s.read)
  const msg = msgs[scr.msgIndex]
  if (!msg) return chatEmptyView(s, t, scr.chatId)

  // The counter is in the header, not the footer: the footer is taken by gestures (ux-flow § Жесты).
  const header = `${cutChars(chatLabel(chat).toUpperCase(), 30)} · ${t('page.counter', {
    page: scr.msgIndex + 1,
    total: msgs.length,
  })}`

  // One gesture, two meanings: long message → full text, short one → skip.
  // "Long" is the measured pixel height, not whether a summary happens to exist:
  // a long message without a summary is clipped with "…" on CHAT but the full
  // text must still be reachable.
  const isLong = lineCount(msg.text) > BODY_LINES
  const isSummary = isLong && msg.summary !== undefined

  const body = isSummary
    ? clipLines(msg.summary ?? '', SUMMARY_LINES)
    : clipLines(msg.text, BODY_LINES)

  const specs: TextSpec[] = [
    { id: 'title', slot: 'title', content: header, level: LVL.main },
    dividerSpec('divider'),
    { id: 'body', slot: 'body', content: body, level: LVL.body, capture: true },
  ]
  // When the message arrived, always: a summary also carries its badge here.
  specs.push({
    id: 'sub',
    slot: 'sub',
    content: isSummary
      ? t('chat.metaBadge', { time: stamp(msg.at, s.lang), badge: t('chat.summaryBadge') })
      : t('chat.meta', { time: stamp(msg.at, s.lang) }),
    level: LVL.caption,
  })
  specs.push({
    id: 'footer',
    slot: 'footer',
    content: isLong ? t('chat.hint.long') : t('chat.hint.short'),
    level: LVL.caption,
  })

  const texts = textsOf(specs)
  return { shape: shapeOf(texts), texts }
}

function chatEmptyView(s: AppState, t: TFunc, chatId: string): View {
  const chat = chatById(s, chatId)
  const header = chat ? cutChars(chatLabel(chat).toUpperCase(), 30) : t('idle.title')
  const texts = textsOf([
    { id: 'title', slot: 'title', content: header, level: LVL.main },
    dividerSpec('divider'),
    { id: 'body', slot: 'body', content: t('chat.empty'), level: LVL.body, capture: true },
    { id: 'footer', slot: 'footer', content: t('chat.emptyHint'), level: LVL.caption },
  ])
  return { shape: shapeOf(texts), texts }
}

function fulltextView(s: AppState, t: TFunc): View {
  const scr = s.screen
  if (scr.kind !== 'fulltext') return chatsView(s, t)
  const chat = chatById(s, scr.chatId)
  if (!chat) return chatsView(s, t)
  const msg = unreadMsgs(chat, s.read)[scr.msgIndex]
  if (!msg) return chatsView(s, t)

  // One container takes at most 1000 characters on a rebuild (display.md
  // § Content limits); Telegram messages are up to 4096. The rest stays on the
  // phone, and the sub line says so instead of silently cutting the text.
  const body = cutToChars(msg.text, FULLTEXT_MAX_CHARS)

  const texts = textsOf([
    {
      id: 'title',
      slot: 'title',
      content: t('fulltext.title', {
        chat: cutChars(chatLabel(chat).toUpperCase(), 24),
        time: stamp(msg.at, s.lang),
      }),
      level: LVL.main,
    },
    dividerSpec('divider'),
    { id: 'body', slot: 'body', content: body.text, level: LVL.body, capture: true },
    {
      id: 'sub',
      slot: 'sub',
      content: body.cut ? t('fulltext.long') : '',
      level: LVL.caption,
    },
    { id: 'footer', slot: 'footer', content: t('fulltext.hint'), level: LVL.caption },
  ])
  return { shape: shapeOf(texts), texts }
}

// ---------------------------------------------------------------------------
// REPLIES.
// ---------------------------------------------------------------------------

function repliesView(s: AppState, t: TFunc): View {
  const scr = s.screen
  if (scr.kind !== 'replies') return repliesEmptyView(s, t)
  const chat = chatById(s, scr.chatId)
  const msg = chat ? unreadMsgs(chat, s.read)[scr.msgIndex] : undefined
  if (!msg || msg.replies.length === 0) return repliesEmptyView(s, t)

  // "Say it" is the mandatory second way into voice (design-system.md §5.1):
  // the OS may take the long press for its own menu, the tap always remains.
  const items = [
    ...msg.replies.map((reply) =>
      cutBytes(
        cutToPx(cutChars(reply, LIST_ITEM_CHARS), SLOT.body.w - 24),
        LIST_ITEM_BYTES,
      ),
    ),
    cutBytes(t('options.sayIt'), LIST_ITEM_BYTES),
  ]

  const texts = textsOf([
    { id: 'title', slot: 'title', content: t('options.title'), level: LVL.main },
    dividerSpec('divider'),
    { id: 'footer', slot: 'footer', content: t('options.hint'), level: LVL.caption },
  ])
  const list: ViewList = {
    id: 'list',
    ...listRect(items.length),
    items,
    // The selection is clamped to the visible window: the highlight must not leave the list.
    sel: Math.min(Math.max(scr.sel, 0), Math.min(items.length, LIST_ROWS) - 1),
  }
  return { shape: shapeOf(texts, list), texts, list }
}

/**
 * Waiting for the LLM. Three block lines, no list: an empty REPLIES screen
 * would look like "no options" while the request is still running.
 */
function repliesLoadingView(t: TFunc): View {
  const texts = textsOf([
    { id: 'title', slot: 'title', content: t('options.title'), level: LVL.main },
    dividerSpec('divider'),
    {
      id: 'body',
      slot: 'body',
      content: '▄▄▄▄▄▄▄▄▄▄▄▄▄▄\n▄▄▄▄▄▄▄▄\n▄▄▄▄▄▄▄▄▄▄▄',
      level: LVL.caption,
      capture: true,
    },
    { id: 'footer', slot: 'footer', content: '', level: LVL.caption },
  ])
  return { shape: shapeOf(texts), texts }
}

function repliesEmptyView(s: AppState, t: TFunc): View {
  // Without a key the screen says what is missing instead of offering "retry"
  // on a request that cannot succeed (§6 of the task).
  const body = s.llmConfigured ? ' ' : t('replies.notConfigured')
  const texts = textsOf([
    { id: 'title', slot: 'title', content: t('replies.emptyTitle'), level: LVL.main },
    dividerSpec('divider'),
    { id: 'body', slot: 'body', content: body, level: LVL.body, capture: true },
    {
      id: 'footer',
      slot: 'footer',
      content: s.llmConfigured ? t('replies.emptyHint') : '',
      level: LVL.caption,
    },
  ])
  return { shape: shapeOf(texts), texts }
}

// ---------------------------------------------------------------------------
// Confirmations and the send result: one composition of 5 containers,
// only the text changes — SEND? → SENDING → SENT go without rebuild.
// ---------------------------------------------------------------------------

function confirmView(s: AppState, t: TFunc): View {
  const scr = s.screen
  if (scr.kind !== 'confirm') return chatsView(s, t)
  const chat = chatById(s, scr.chatId)
  const to = chat ? t('confirm.to', { chat: cutChars(chatLabel(chat), 40) }) : ''
  // The reply is quoted in full: long ones overflow and the firmware scrolls them.
  const texts = textsOf([
    { id: 'title', slot: 'title', content: t('confirm.title'), level: LVL.main },
    dividerSpec('divider'),
    { id: 'body', slot: 'body', content: `"${scr.reply}"`, level: LVL.body, capture: true },
    { id: 'sub', slot: 'sub', content: to, level: LVL.caption },
    { id: 'footer', slot: 'footer', content: t('confirm.hint'), level: LVL.caption },
  ])
  return { shape: shapeOf(texts), texts }
}

function quickConfirmView(s: AppState, t: TFunc): View {
  const scr = s.screen
  if (scr.kind !== 'quickConfirm') return chatsView(s, t)
  const chat = chatById(s, scr.chatId)
  const n = chat ? unreadMsgs(chat, s.read).length : 0
  const to = chat ? t('quickReply.to', { chat: cutChars(chatLabel(chat), 30), n }) : ''
  const texts = textsOf([
    { id: 'title', slot: 'title', content: t('quickReply.title'), level: LVL.main },
    dividerSpec('divider'),
    { id: 'body', slot: 'body', content: `"${s.quickReplyText}"`, level: LVL.body, capture: true },
    { id: 'sub', slot: 'sub', content: to, level: LVL.caption },
    { id: 'footer', slot: 'footer', content: t('quickReply.hint'), level: LVL.caption },
  ])
  return { shape: shapeOf(texts), texts }
}

function skipConfirmView(s: AppState, t: TFunc): View {
  const scr = s.screen
  if (scr.kind !== 'skipConfirm') return chatsView(s, t)
  const chat = chatById(s, scr.chatId)
  const msgs = chat ? unreadMsgs(chat, s.read) : []
  const meta = chat
    ? t('skip.meta', {
        chat: cutChars(chatLabel(chat).toUpperCase(), 20),
        page: Math.min(scr.msgIndex + 1, msgs.length),
        total: msgs.length,
      })
    : ''
  const texts = textsOf([
    { id: 'title', slot: 'title', content: t('skip.title'), level: LVL.main },
    dividerSpec('divider'),
    { id: 'body', slot: 'body', content: t('skip.body'), level: LVL.body, capture: true },
    { id: 'sub', slot: 'sub', content: meta, level: LVL.caption },
    { id: 'footer', slot: 'footer', content: t('skip.hint'), level: LVL.caption },
  ])
  return { shape: shapeOf(texts), texts }
}

function sendingView(s: AppState, t: TFunc): View {
  const scr = s.screen
  if (scr.kind !== 'sending') return chatsView(s, t)
  const isQuick = scr.mode === 'quick'
  const texts = textsOf([
    {
      id: 'title',
      slot: 'title',
      content: isQuick ? t('quickReply.title') : t('confirm.title'),
      level: LVL.main,
    },
    dividerSpec('divider'),
    { id: 'body', slot: 'body', content: `"${scr.reply}"`, level: LVL.body, capture: true },
    // Footer without actions — "waiting, no gestures" (ux-flow, SENDING).
    { id: 'sub', slot: 'sub', content: t('chats.sending'), level: LVL.caption },
    { id: 'footer', slot: 'footer', content: '', level: LVL.caption },
  ])
  return { shape: shapeOf(texts), texts }
}

function sentView(s: AppState, t: TFunc): View {
  const scr = s.screen
  if (scr.kind !== 'sent') return chatsView(s, t)
  const chat = chatById(s, scr.chatId)
  const person = scr.person ?? chat?.person ?? ''
  const stamp = person ? `${scr.at} · ${cutChars(person, 30)}` : scr.at
  const texts = textsOf([
    { id: 'title', slot: 'title', content: t('sent.title'), level: LVL.main },
    dividerSpec('divider'),
    { id: 'body', slot: 'body', content: `"${scr.reply}"`, level: LVL.body, capture: true },
    { id: 'sub', slot: 'sub', content: stamp, level: LVL.caption },
    { id: 'footer', slot: 'footer', content: t('sent.hint'), level: LVL.caption },
  ])
  return { shape: shapeOf(texts), texts }
}

function offlineView(_s: AppState, t: TFunc): View {
  const texts = textsOf([
    { id: 'title', slot: 'title', content: t('error.title'), level: LVL.main },
    dividerSpec('divider'),
    { id: 'body', slot: 'body', content: t('error.body'), level: LVL.body, capture: true },
    { id: 'sub', slot: 'sub', content: t('error.sub'), level: LVL.caption },
    { id: 'footer', slot: 'footer', content: t('error.hint'), level: LVL.caption },
  ])
  return { shape: shapeOf(texts), texts }
}

// ---------------------------------------------------------------------------
// Voice.
// ---------------------------------------------------------------------------

/**
 * LISTENING footer. Two things change it: how the recording was started (the
 * hold has no fingers left for a swipe) and which microphone is live. With the
 * phone microphone the caption has to say so (design-system.md §5.1) — and the
 * combined line does not fit 536 px on the hold screen in Russian, so the
 * cancel hint goes: while holding, a swipe is out of reach anyway.
 */
function listeningHint(scr: Extract<Screen, { kind: 'listening' }>, t: TFunc): string {
  if (scr.source === 'phone') {
    return scr.mode === 'hold' ? t('voice.listening.hintPhone') : t('voice.listening.hintTapPhone')
  }
  return scr.mode === 'hold' ? t('voice.listening.hint') : t('voice.listening.hintTap')
}

function listeningView(s: AppState, t: TFunc): View {
  const scr = s.screen
  if (scr.kind !== 'listening') return chatsView(s, t)
  const texts = textsOf([
    { id: 'title', slot: 'title', content: t('voice.listening.title'), level: LVL.main },
    dividerSpec('divider'),
    {
      id: 'indicator',
      slot: 'indicator',
      content: waveOf(scr.levels),
      level: LVL.main,
      capture: true,
    },
    dividerSpec('divider2'),
    {
      id: 'footer',
      slot: 'footer',
      content: listeningHint(scr, t),
      level: LVL.caption,
    },
  ])
  return { shape: shapeOf(texts), texts }
}

function heardView(s: AppState, t: TFunc): View {
  const scr = s.screen
  if (scr.kind !== 'heard') return chatsView(s, t)

  if (scr.variant === 'error') {
    const texts = textsOf([
      { id: 'title', slot: 'title', content: t('voice.heard.title'), level: LVL.main },
      dividerSpec('divider'),
      { id: 'body', slot: 'body', content: t('voice.error.body'), level: LVL.body, capture: true },
      { id: 'sub', slot: 'sub', content: '', level: LVL.caption },
      { id: 'footer', slot: 'footer', content: t('voice.heard.errorHint'), level: LVL.caption },
    ])
    return { shape: shapeOf(texts), texts }
  }

  // The transcript is handed to the firmware as is: the body is event-capturing,
  // so the firmware scrolls overflowing text itself and draws its own scrollbar.
  // Our own rail/slider is not needed (and would duplicate the stock one).
  // The footer says "scroll" only when there is something to scroll: on a text
  // that fits, a scroll hint would promise a gesture that does nothing.
  const scrolls = lineCount(scr.text) > BODY_LINES
  const texts = textsOf([
    { id: 'title', slot: 'title', content: t('voice.heard.title'), level: LVL.main },
    dividerSpec('divider'),
    { id: 'body', slot: 'body', content: scr.text, level: LVL.body, capture: true },
    {
      id: 'sub',
      slot: 'sub',
      content: scr.variant === 'phoneMic' ? t('voice.heard.phoneMic') : '',
      level: LVL.caption,
    },
    {
      id: 'footer',
      slot: 'footer',
      content: scrolls ? t('voice.heard.scrollHint') : t('voice.heard.hint'),
      level: LVL.caption,
    },
  ])
  return { shape: shapeOf(texts), texts }
}
