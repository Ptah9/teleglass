/**
 * The WebView gives up after 10 seconds, so every Telegram call has a deadline
 * below that. A timeout becomes `{ error: 'network' }`, never a hanging request.
 *
 * The losing promise keeps running. Callers that care about a late side effect
 * (a login code already sent, a token already confirmed) attach their own
 * handlers; this helper only guarantees no unhandled rejection.
 */

export type Timed<T> = { timedOut: false; value: T } | { timedOut: true }

export function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<Timed<T>> {
  return new Promise<Timed<T>>((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve({ timedOut: false, value })
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
