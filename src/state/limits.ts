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
 * How long the glasses microphone may stay silent before the recording stops
 * (task v0.7 §6: «тишина 2 с»). The recording is of a spoken reply, and a pause
 * longer than this means the thought is over; the finger may still be down.
 */
export const SILENCE_MS = 2000

/**
 * Level (0…1 on the indicator's dBFS scale) below which a chunk counts as
 * silence for `SILENCE_MS`. 0.12 ≈ −53 dBFS: a quiet room stays below it and
 * normal speech is above; a whisper may not be, so this is tuned on hardware.
 */
export const SILENCE_LEVEL = 0.12

/**
 * Hard cap on a dictated answer. The hold is a pair of events (press, release)
 * and the OS may swallow the release (ux-flow.md § Что может не сойтись);
 * without a cap the microphone would stay open until the next swipe. 45 s keeps
 * the worst case inside the recognition budget (owner's call, 27.11: 12.8 s of
 * speech took 6.3 s under load, 45 s fits in 25 s).
 */
export const MAX_RECORD_MS = 45_000

/**
 * A voice note is sent as recorded, with no recognition, so it follows
 * Telegram's own minute-plus limit instead of the dictation cap (owner's call,
 * 27.11).
 */
export const MAX_VOICE_RECORD_MS = 120_000

/**
 * How long the CHATS footer keeps «not sent». Long enough to be read and to
 * retry by holding, short enough not to become a second screen: without an end
 * the hold-for-retry line stayed on the list forever.
 */
export const NOT_SENT_MS = 15_000

/**
 * Incoming voice notes are transcribed in the background, three at a time: the
 * whisper server keeps one model in memory on one machine, and a burst of
 * notes would otherwise queue for a minute. The text must be on CHAT when the
 * message is opened, not after a tap (owner's call, 27.11).
 */
export const TRANSCRIPTS_AT_ONCE = 3
