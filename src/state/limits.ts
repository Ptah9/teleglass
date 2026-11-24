/**
 * Screen limits shared by the logic and the view.
 *
 * They live here, not duplicated in each file: the footer hint ("hold — full
 * text") and the gesture that opens the full text must agree on what "long"
 * means, and the indicator window must agree on its own width.
 */

/** Lines that fit the CHAT body: 5 × 27 px = 135 px (geometry, measured). */
export const BODY_LINES = 5

/** Summary is up to 4 lines + the metadata line (i18n-strings.md §5). */
export const SUMMARY_LINES = 4

/** LISTENING indicator columns: 26 × 20 px = 520 px, the 536 px working width. */
export const WAVE_LEN = 26
