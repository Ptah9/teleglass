import { TEXT_PX } from '../state/wrap'

/**
 * 576×288 screen geometry — design-system.md §3, refined by measurements.
 *
 * One font, 20 px, 20 px margins. All coordinates come from the ux-flow.md map.
 *
 * MEASURED in the 0.9.5 simulator via framebuffer (it used to be computed from
 * the guideline and did not match — that is what produced bugs 1–6):
 * - the text line step is 27 px, not 24. A container below 27 px is overfull,
 *   and the firmware draws its own scrollbar on its right edge (4×10 px);
 * - the 144 px body fits 5 lines, the sixth starts at +141 and is clipped;
 * - a native list row is 40 px, the firmware sets the height (not us),
 *   the container only sets the visible window.
 */

/** Height of one text line in the firmware (measured). */export const TEXT_LINE = 27
/** Native list row height (measured, not configurable). */
export const LIST_ROW = 40
/** Content margins. */
export const MARGIN = 20
/** Working width: 576 − 2×20, the same number the text measurement uses. */
export const CONTENT_W = TEXT_PX

export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** Screen slots. Every screen assembles containers from these rectangles. */
export const SLOT: Record<string, Rect> = {
  title: { x: MARGIN, y: 12, w: CONTENT_W, h: TEXT_LINE },
  /**
   * Divider — a 1 px high container with a 1 px border (design-system §2.3).
   * The firmware wraps a 46-char "─" string and draws a false scrollbar on the
   * right (measured: 4×10 px at x546), so the line is a border, not text.
   * y = 52 — where the text line had its ink row.
   */
  divider: { x: MARGIN, y: 52, w: CONTENT_W, h: 1 },
  body: { x: MARGIN, y: 62, w: CONTENT_W, h: TEXT_LINE * 5 },
  sub: { x: MARGIN, y: 206, w: CONTENT_W, h: TEXT_LINE },
  footer: { x: MARGIN, y: 244, w: CONTENT_W, h: TEXT_LINE },
  /** LISTENING: level indicator in the middle of the body. */
  indicator: { x: MARGIN, y: 110, w: CONTENT_W, h: TEXT_LINE },
  /** Second LISTENING line — same trick; y = 172 (container row 158). */
  divider2: { x: MARGIN, y: 172, w: CONTENT_W, h: 1 },
}

/** Free room for the list — from body to footer (182 px). */
export const LIST_SPACE = SLOT.footer.y - SLOT.body.y

/**
 * How many list rows are visible above the footer: 4 × 40 = 160 px.
 * The list window height must be a multiple of 40: the firmware fills the window
 * with whole rows and gives the leftover height to a partial row — which then
 * spills onto the footer (measured: 182 px window, 6 chats → the fifth row
 * landed on the hint line; 160 px window → four rows, then native scroll,
 * footer clean).
 */
export const LIST_ROWS = Math.floor(LIST_SPACE / LIST_ROW)

/** Text brightness: 4 primary, 2 caption, 1 structure (design-system.md §4). */
export const LVL = {
  main: 4,
  body: 4,
  caption: 2,
  divider: 1,
} as const

/** Border colour: 0–15 scale (text uses another scale, 0–4). Practical values from the community notes: 5 — noticeable, 13 — bright. */
export const BORDER = {
  /** Divider border: 3 ≈ brightness of the former text line (157/255). */
  divider: 3,
} as const
