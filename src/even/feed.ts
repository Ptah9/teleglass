import { api } from '../api'
import type { ChatSummary, MessageSummary } from '../api/types'
import type { FeedStatus, MockChat, MockMessage } from '../state/types'

/**
 * The bridge from the real account to the glasses list.
 *
 * The glasses show unread messages only (ux-flow.md), so the feed is exactly the
 * chats Telegram reports unread plus their last messages. The page keeps its own
 * `read` map for the current window; since v0.6 every mark is also sent to the
 * backend (`readHistory`), so a listed chat is read on the phone too.
 *
 * The status is carried next to the chats: `demo` is the mock set, `ready` is
 * the real list (possibly empty), `error` means the list could not be built.
 * The page never falls back to mocks for a connected account.
 */
export interface FeedSnapshot {
  status: FeedStatus
  chats: MockChat[] | null
  /** false — some unread chats did not load; the list is not the whole truth. */
  complete: boolean
}

/** A row is a name and a time; 30 pages of unread is already a wall on G2. */
const MAX_UNREAD = 30

/**
 * Message requests per batch. Thirty at once is a burst Telegram would rather
 * not see from a young session, and each cold peer would resolve dialogs twice.
 */
const MAX_PARALLEL = 4

/**
 * The whole feed must be ready while the screen still says "checking". The
 * WebView request timeout is 10 s, the backend's per-request budget is 8.5 s,
 * so the snapshot gives up a little before that and reports what it has.
 */
const FEED_BUDGET_MS = 9_000

export async function loadFeed(selectedChats: string[] | null = null): Promise<FeedSnapshot> {
  // The whole snapshot shares one deadline: `/chats` is a request too.
  const deadline = Date.now() + FEED_BUDGET_MS
  const rows = await api.chats()
  // The demo API has no unread counts; its set is the labelled demo one.
  if (api.demo) return { status: 'demo', chats: null, complete: true }

  const selected = selectedChats === null ? null : new Set(selectedChats)
  const unread = rows
    .filter((row) => (row.unread ?? 0) > 0)
    .filter((row) => selected === null || selected.has(row.id))
  // No cap here: the page cuts the list to 20 AFTER filtering locally read
  // messages. Cutting in the feed would hide the chats that move up once the
  // first ones are read on the glasses.

  if (unread.length === 0) return { status: 'ready', chats: [], complete: true }

  const chats: MockChat[] = []
  let failed = 0
  let missing = 0
  let settled = 0

  for (let i = 0; i < unread.length; i += MAX_PARALLEL) {
    const chunk = unread.slice(i, i + MAX_PARALLEL)
    let results: PromiseSettledResult<MockChat | null>[]
    try {
      results = await within(
        chunk.map((row) => chatOf(row)),
        deadline - Date.now(),
      )
    } catch {
      // No time left for the rest: count it as not loaded instead of keeping
      // the glasses on "checking" past the request timeout.
      failed += unread.length - settled
      break
    }

    settled += chunk.length
    for (const result of results) {
      if (result.status === 'rejected') {
        failed += 1
        console.warn('[teleglass] messages were not loaded:', result.reason)
        continue
      }
      if (result.value) chats.push(result.value)
      // A chat with nothing readable is not a request failure: it cannot be
      // drawn, but it must not turn the whole snapshot into an error.
      else missing += 1
    }
  }

  // An empty result over failed requests is an unknown list, not an empty one:
  // the screen says so and offers a retry instead of "No new messages" over
  // chats Telegram reports unread. An empty list with no failures stays `ready`:
  // those windows were empty because the phone had read them.
  if (failed === unread.length || (chats.length === 0 && failed > 0)) {
    return { status: 'error', chats: null, complete: false }
  }
  return { status: 'ready', chats, complete: failed === 0 && missing === 0 }
}

async function chatOf(row: ChatSummary): Promise<MockChat | null> {
  const limit = Math.min(row.unread ?? 0, MAX_UNREAD)
  const messages = await api.messages(row.id)
  // Telegram counts unread incoming messages. The backend returns the window
  // after `readInboxMaxId`, so these are exactly the unread ones; the last
  // `limit` are the newest of them, which is what the CHAT screen pages through.
  const shown = messages.filter((message) => !message.out && message.text.trim()).slice(-limit)
  if (shown.length === 0) {
    if (messages.length > 0) {
      // The window came back, but it holds only our own messages: the unread
      // ones were not reached (the forward request failed, or the budget ran
      // out). That is a chat we lost, not an empty one — count it as failed so
      // the screen shows "could not load" instead of "No new messages".
      throw new Error('unread window holds no incoming messages')
    }
    // An empty window means the phone read the chat between `/chats` and here:
    // there is nothing to draw, and that is not a failure.
    console.warn('[teleglass] no readable unread messages for a chat:', row.id)
    return null
  }

  return {
    id: row.id,
    person: row.title,
    messages: shown.map((message) => toMessage(row.id, message)),
  }
}

function toMessage(chatId: string, message: MessageSummary): MockMessage {
  return {
    // Telegram ids are unique inside a chat, not across chats; the read map is
    // global to the page, so the chat id stays in the key.
    id: `${chatId}#${message.id}`,
    at: message.at,
    text: message.text,
    // The LLM is asked by Telegram's own id, not by our composite key.
    remoteId: message.id,
    // Reply options are the LLM's job (v0.5): an empty list means "not asked
    // yet"; the page opens REPLIES with a skeleton and a real request.
    replies: [],
  }
}

/** `allSettled` with a deadline; the losing requests keep running and are dropped. */
async function within<T>(promises: Promise<T>[], ms: number): Promise<PromiseSettledResult<T>[]> {
  if (ms <= 0) throw new Error('feed budget is over')
  let timer = 0
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = window.setTimeout(() => resolve('timeout'), ms)
  })
  try {
    const raced = await Promise.race([Promise.allSettled(promises), timeout])
    if (raced === 'timeout') throw new Error('feed budget is over')
    return raced
  } finally {
    window.clearTimeout(timer)
  }
}
