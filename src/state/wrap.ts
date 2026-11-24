/**
 * Text layout for the glasses body, measured with the official Even package.
 *
 * `@evenrealities/pretext` (MIT, Even Realities) mirrors the firmware's LVGL
 * line breaking: per-glyph advances from the evenroster font chain
 * (latin → cyrillic/greek → cn → emoji), kerning, rounding to whole pixels.
 * There is no character counting here: a character budget lies as soon as the
 * text carries wide glyphs (50 × "W" is 800 px, not 536) or Cyrillic.
 *
 * Line *count* is the official `measureTextWrap`. The break points for clipping
 * are computed here with the same pixel widths, but only at spaces (plus a hard
 * split of an over-long word): LVGL also breaks at hyphens and between CJK
 * glyphs, so a clipped body is verified against `measureTextWrap` and shortened
 * until the firmware really sees `maxLines` or fewer.
 *
 * We only clip where the body has a fixed height (CHAT: 5 lines, summary: 4).
 * Screens that scroll (HEARD, FULL TEXT, SEND?) get the raw text and the
 * firmware wraps and scrolls it itself.
 */

import { getTextWidth, measureTextWrap, pxTruncate } from '@evenrealities/pretext'

/** Inner width of a full-width text container: 576 − 2×20 (design-system §2). */
export const TEXT_PX = 536

/** Split a single word that is wider than the line, without losing characters. */
function splitWord(word: string, maxPx: number): string[] {
  const out: string[] = []
  let rest = word
  while (rest !== '' && getTextWidth(rest) > maxPx) {
    let lo = 1
    let hi = rest.length
    let best = 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (getTextWidth(rest.slice(0, mid)) <= maxPx) {
        best = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    out.push(rest.slice(0, best))
    rest = rest.slice(best)
  }
  if (rest !== '') out.push(rest)
  return out
}

/** Greedy word wrap at a pixel width, the same breakpoints the firmware uses. */
export function layoutLines(text: string, maxPx: number = TEXT_PX): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(' ')) {
      if (word === '') continue
      const parts = getTextWidth(word) > maxPx ? splitWord(word, maxPx) : [word]
      for (const part of parts) {
        if (line === '') {
          line = part
        } else if (getTextWidth(`${line} ${part}`) <= maxPx) {
          line += ` ${part}`
        } else {
          out.push(line)
          line = part
        }
      }
    }
    out.push(line)
  }
  return out
}

/** How many lines the text takes at this width — the official measurement. */
export function lineCount(text: string, maxPx: number = TEXT_PX): number {
  return measureTextWrap(text, maxPx).lineCount
}

/**
 * Clip text to `maxLines` and mark the cut with the ellipsis the official
 * package appends. The body of a capturing container must never overflow:
 * the firmware scrolls overflowing capture containers, and CHAT is not a
 * scrolling screen.
 *
 * Text that fits is returned untouched (its own newlines and double spaces are
 * the message's formatting, not ours to normalise).
 */
export function clipLines(text: string, maxLines: number, maxPx: number = TEXT_PX): string {
  const lines = layoutLines(text, maxPx)
  if (lines.length <= maxLines && lineCount(text, maxPx) <= maxLines) return text

  let keep = Math.min(lines.length, maxLines)
  const kept = lines.slice(0, keep)
  const nextWord = (lines[keep] ?? '').split(' ')[0] ?? ''
  if (keep > 0) {
    kept[keep - 1] = pxTruncate(`${kept[keep - 1] ?? ''} ${nextWord}`.trim(), maxPx)
  }

  // Our break points are greedy at spaces; the firmware also breaks at hyphens
  // and CJK boundaries. Shorten until the official count fits, so the capturing
  // body can never start its own scroll.
  while (keep > 1 && lineCount(kept.join('\n'), maxPx) > maxLines) {
    keep -= 1
    kept.length = keep
  }
  return kept.join('\n')
}
