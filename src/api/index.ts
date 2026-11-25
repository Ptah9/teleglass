import { createDemoApi } from './demo'
import { createRealApi } from './client'
import { hasDemoFlag } from './demo-flags'
import type { Api } from './types'

/**
 * One API for the whole WebView: the real backend when it answers, the labelled
 * demo otherwise. The probe is made once, on the first call, so the UI can be
 * drawn immediately and no screen hangs on "connecting".
 *
 * The demo is a deliberate fallback for the hackathon build (backend may be
 * down during a demo), not a silent fake: the settings screen says `Demo`, and
 * the code screen prints the demo code.
 */

const base = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '') ?? '/api'
const PROBE_MS = 1_500

let impl: Promise<Api> | null = null
let isDemo = false

function remember(next: Api): Api {
  isDemo = next.demo
  return next
}

async function probe(): Promise<Api> {
  if (hasDemoFlag('demo') || import.meta.env.VITE_DEMO === '1') {
    console.log('[teleglass] API: demo (forced)')
    return remember(createDemoApi())
  }

  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), PROBE_MS)
  try {
    const response = await fetch(`${base}/health`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      credentials: 'omit',
    })
    const type = response.headers.get('content-type') ?? ''
    if (response.ok && type.includes('json')) {
      console.log('[teleglass] API: backend at', base)
      return remember(createRealApi(base))
    }
  } catch {
    /* no backend — the demo is the honest fallback, and it is labelled */
  } finally {
    window.clearTimeout(timer)
  }

  console.warn('[teleglass] API: backend did not answer at', base, '— demo mode')
  return remember(createDemoApi())
}

function ready(): Promise<Api> {
  impl ??= probe()
  return impl
}

export const api: Api = {
  get demo() {
    return isDemo
  },
  health: async () => (await ready()).health(),
  auth: async () => (await ready()).auth(),
  sendCode: async (phone) => (await ready()).sendCode(phone),
  verifyCode: async (phone, code) => (await ready()).verifyCode(phone, code),
  verifyPassword: async (password) => (await ready()).verifyPassword(password),
  startLink: async () => (await ready()).startLink(),
  linkState: async () => (await ready()).linkState(),
  logout: async () => (await ready()).logout(),
  deleteAll: async () => (await ready()).deleteAll(),
  chats: async () => (await ready()).chats(),
  putSettings: async (payload) => (await ready()).putSettings(payload),
  setLlmKey: async (apiKey) => (await ready()).setLlmKey(apiKey),
}

/** Demo flags are read synchronously; the screens use this before the probe. */
export { hasDemoFlag }
