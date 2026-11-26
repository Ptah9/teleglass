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

/**
 * One text container accepts 1000 characters on `createStartUpPageContainer`
 * and on `rebuildPageContainer` (docs/md/02-build/03-display.md § Content limits).
 * FULL TEXT enters by rebuilding the page, so its body is cut at this budget;
 * Telegram itself allows messages up to 4096 characters.
 */
export const FULLTEXT_MAX_CHARS = 1000

/**
 * Native list pages hold at most 20 items (design-system.md §2, display.md
 * § Lists: "Up to 20 items per list"). A real account can have more unread
 * chats than that, and the SDK does not validate the count, so the list is cut
 * here: the 20 most recent unread, the rest stay unread on the phone.
 */
export const CHATS_MAX = 20

/** LISTENING indicator columns: 26 × 20 px = 520 px, the 536 px working width. */
export const WAVE_LEN = 26

/**
 * How long the glasses microphone may stay silent before the page switches to
 * the phone one (design-system.md §5.1: «если за 2 секунды данных нет»).
 */
export const MIC_FALLBACK_MS = 2000

/**
 * Hard cap on one recording. The hold is a pair of events (press, release) and
 * the OS may swallow the release (ux-flow.md § Что может не сойтись); without a
 * cap the microphone would stay open until the next swipe. One minute is longer
 * than any reply dictated on the glasses.
 */
export const MAX_RECORD_MS = 60_000

/**
 * How long the CHATS footer keeps «not sent». Long enough to be read and to
 * retry by holding, short enough not to become a second screen: without an end
 * the hold-for-retry line stayed on the list forever.
 */
export const NOT_SENT_MS = 15_000
