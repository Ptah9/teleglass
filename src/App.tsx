import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { HEALTH_EVENT, UNAUTHORIZED_EVENT } from './api/client'
import { hasDemoFlag } from './api/demo-flags'
import { AuthError } from './api/types'
import { DebugPanel } from './dev/DebugPanel'
import { loadFeed } from './even/feed'
import { getPage, type Page } from './even/page'
import { setLang, useT } from './i18n'
import { PhoneApp } from './phone/PhoneApp'
import { MOCK_QUICK_REPLY } from './state/data'
import type { AppState } from './state/types'
import { loadSettings, saveSettings, type Settings } from './store/settings'

/**
 * One WebView, two surfaces. The phone shows `PhoneApp` (auth, chats, settings);
 * the glasses are a render target driven by `Page` (Even Hub containers). State
 * lives here, in the WebView — the glasses hold none (official FAQ).
 *
 * `?dev=1` swaps the phone surface for the glasses debug panel used during
 * development and by the simulator scripts.
 */
const toGlasses = (s: Settings, llmConfigured: boolean) => ({
  lang: s.lang,
  quickReply: s.quickReply.trim().length > 0 ? s.quickReply : MOCK_QUICK_REPLY,
  telegramConnected: s.telegram,
  selectedChats: s.selectedChats,
  llmConfigured,
})

export default function App() {
  const dev = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    return params.has('dev') || params.has('panel')
  }, [])

  const [page, setPage] = useState<Page | null>(null)
  const [appState, setAppState] = useState<AppState | null>(null)
  // QA only: `?demo=connected` opens the tabs without the fake sign-in.
  // The flag lives in the address, so the packaged build is unaffected. It is
  // read once: the first glasses frame must already agree with it.
  const bootSettings = useMemo(() => {
    const loaded = loadSettings()
    return hasDemoFlag('connected') ? { ...loaded, telegram: true } : loaded
  }, [])
  const [settings, setSettings] = useState<Settings>(bootSettings)
  // Optimistic before the first /health: `false` would show "LLM not
  // configured" for a second after boot and turn a tap into a dead end. If the
  // key is really missing, the request answers 502 in milliseconds and the
  // honest NO REPLIES screen appears.
  const [llmConfigured, setLlmConfigured] = useState(!api.demo)
  const [native, setNative] = useState<boolean | null>(null)
  const [bootFailed, setBootFailed] = useState(false)
  /** One feed request at a time: the empty-CHATS tap and foreground can race. */
  const feedBusy = useRef(false)
  /** A refresh that arrived during a request is replayed once, not dropped. */
  const feedAgain = useRef(false)
  /** The in-flight request must not apply a snapshot after a disconnect. */
  const telegramNow = useRef(settings.telegram)

  // Boot the glasses page once (StrictMode mounts twice; getPage is a singleton).
  useEffect(() => {
    let alive = true
    let stop: (() => void) | undefined
    getPage(toGlasses(bootSettings, !api.demo))
      .then((p) => {
        if (!alive) return
        setPage(p)
        setNative(p.native)
        setAppState(p.state())
        stop = p.subscribe((s) => {
          setAppState(s)
          // The glasses demo lever can change the language from the temple arm;
          // adopt it into the phone setting instead of letting the screens disagree.
          setSettings((prev) => (prev.lang === s.lang ? prev : { ...prev, lang: s.lang }))
        })
      })
      .catch((err: unknown) => {
        // Never leave the screen on "connecting…" — a failed boot is a message.
        console.error('[teleglass] page failed to start:', err)
        if (alive) setBootFailed(true)
      })
    return () => {
      alive = false
      stop?.()
    }
  }, [bootSettings])

  // Settings are the single source for both surfaces: persist and push.
  useEffect(() => {
    telegramNow.current = settings.telegram
    if (!page) return
    saveSettings(settings)
    page.applySettings(toGlasses(settings, llmConfigured))
  }, [page, settings, llmConfigured])

  /**
   * Real chats for the glasses. The page cannot fetch, so the WebView does it
   * and hands over a full snapshot. A connected account never falls back to the
   * mock chats: with no list yet the screen says "checking", and a failed load
   * is an explicit error with a retry, not silence.
   */
  const reloadFeed = useCallback(async () => {
    if (!page) return
    if (!settings.telegram) {
      page.applyChats('demo', null)
      return
    }
    if (feedBusy.current) {
      // Foreground came back, or the empty list was tapped, while a request is
      // in flight: repeat it once it finishes instead of losing the signal.
      feedAgain.current = true
      return
    }
    feedBusy.current = true
    try {
      do {
        feedAgain.current = false
        // A background refresh keeps the list the user already sees; "checking"
        // is only honest when there is nothing to show yet. The demo set is a
        // list too: going through "loading" would drop the read map and bring
        // back the chat that was just answered.
        const feed = page.state().feedStatus
        const known = feed === 'ready' || feed === 'demo'
        if (!known) page.applyChats('loading', null)
        try {
          const snapshot = await loadFeed(settings.selectedChats)
          if (!telegramNow.current) continue
          if (snapshot.status === 'error') {
            // A failed refresh keeps the list the user already sees; only the
            // first load has nothing to keep and says "could not load".
            if (!known) page.applyChats('error', null)
            else console.warn('[teleglass] feed refresh failed; keeping the current list')
          } else {
            // An incomplete snapshot still updates the chats it got; `merge`
            // keeps the ones that failed this round instead of dropping them.
            page.applyChats(snapshot.status, snapshot.chats, known && !snapshot.complete)
          }
        } catch (err) {
          console.warn('[teleglass] the glasses feed was not loaded:', err)
          if (!known && telegramNow.current) page.applyChats('error', null)
        }
      } while (feedAgain.current && telegramNow.current)
    } finally {
      feedBusy.current = false
    }
  }, [page, settings.telegram, settings.selectedChats])

  useEffect(() => {
    void reloadFeed()
  }, [reloadFeed])

  // The glasses ask for a refresh themselves: a tap on an empty CHATS, or coming
  // back to the foreground. They hold no network client — this is the hook.
  useEffect(() => {
    if (!page) return
    page.onRefresh(() => void reloadFeed())
    return () => page.onRefresh(null)
  }, [page, reloadFeed])

  /**
   * REPLIES asks for options; the WebView owns the request. A failure (timeout,
   * 502, no key) is passed as `null`, and the page shows NO REPLIES — the same
   * screen as a real empty answer, never invented text.
   */
  useEffect(() => {
    if (!page) return
    page.onReplies((chatId, messageId) => {
      void api
        .replies(chatId, messageId)
        .then((result) => page.applyReplies(chatId, messageId, result))
        .catch((err: unknown) => {
          console.warn('[teleglass] replies were not generated:', err)
          page.applyReplies(chatId, messageId, null)
        })
    })
    return () => page.onReplies(null)
  }, [page])

  /**
   * SENDING asks the WebView to send: the demo answers from its own data, the
   * backend from Telegram. Either way the page only shows the result — a
   * rejection is OFFLINE with a retry, never a fake SENT.
   */
  useEffect(() => {
    if (!page) return
    page.onSend((chatId, messageId, text, mode) => {
      void api
        .sendReply(chatId, messageId, text)
        .then((sent) => {
          page.applySend({ chatId, messageId, ok: true, at: sent.at })
          // SENT does not wait for the mark (ux-flow § Подтверждения), but the
          // refreshed feed must see it: reload after the mark has settled.
          const marked =
            mode === 'quick' ? api.markChatRead(chatId) : api.markRead(chatId, messageId)
          marked
            .then(undefined, (err: unknown) => {
              // Telegram still counts it unread, so the glasses must stop
              // hiding it instead of showing a counter that is not true.
              console.warn('[teleglass] the read mark was not saved:', err)
              page.applyUnread(chatId, mode === 'quick' ? undefined : messageId)
            })
            .finally(() => void reloadFeed())
        })
        .catch((err: unknown) => {
          // No text in the log: the reply is the user's, not diagnostics.
          console.warn('[teleglass] the reply was not sent:', err)
          // 400/404 will not change on a retry: leave SENDING for CHATS instead
          // of OFFLINE, whose only action is a retry that cannot work.
          const gone = err instanceof AuthError && (err.status === 400 || err.status === 404)
          page.applySend({ chatId, messageId, ok: false, gone })
          if (gone) void reloadFeed()
        })
    })
    return () => page.onSend(null)
  }, [page, reloadFeed])

  /**
   * SKIP? marks one message read, and only that one. Opening a chat or leaving
   * it with a double tap marks nothing (Антон, 24.11: viewing ≠ reading).
   */
  useEffect(() => {
    if (!page) return
    page.onMark((chatId, messageId) => {
      void api.markRead(chatId, messageId).catch((err: unknown) => {
        // The phone still shows it unread: put it back on the glasses and take
        // the server's list as the truth.
        console.warn('[teleglass] the read mark was not saved:', err)
        page.applyUnread(chatId, messageId)
        void reloadFeed()
      })
    })
    return () => page.onMark(null)
  }, [page, reloadFeed])

  /**
   * Does the backend have an LLM? `off` means no key: REPLIES must say "LLM not
   * configured" and make no request. T3 announces a saved key through
   * HEALTH_EVENT, so the glasses do not need a WebView restart to notice it.
   */
  useEffect(() => {
    let stop = false
    const load = () => {
      api
        .health()
        .then((h) => {
          if (stop) return
          setLlmConfigured(!api.demo && h.llm !== 'off')
        })
        .catch(() => undefined)
    }
    void load()
    const onHealth = () => void load()
    window.addEventListener(HEALTH_EVENT, onHealth)
    return () => {
      stop = true
      window.removeEventListener(HEALTH_EVENT, onHealth)
    }
  }, [])

  // The saved "Telegram connected" flag can outlive the backend session — that
  // is exactly how the tabs once covered a 401. One check on boot drops the
  // flag, but only on a definite answer from the backend: a failed probe (no
  // network, 500, wrong route) is not "not connected" and keeps the link.
  // The demo keeps its own stored step and is left alone.
  useEffect(() => {
    if (api.demo || hasDemoFlag('connected')) return
    let stop = false
    api
      .auth()
      .then((state) => {
        if (stop || state.step === 'connected') return
        setSettings((prev) => (prev.telegram ? { ...prev, telegram: false } : prev))
      })
      .catch(() => undefined)
    return () => {
      stop = true
    }
  }, [])

  // A 401 in the middle of a session (the Telegram link died or the token was
  // revoked) drops the flag too, so the tabs stop claiming a connection. The QA
  // flag is exempt: it exists precisely to open the tabs without a token.
  useEffect(() => {
    if (api.demo || hasDemoFlag('connected')) return
    const onLost = () => {
      setSettings((prev) => (prev.telegram ? { ...prev, telegram: false } : prev))
    }
    window.addEventListener(UNAUTHORIZED_EVENT, onLost)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onLost)
  }, [])

  // Mirror to the backend for the LLM (tone) and the server-side flow. Debounced:
  // typing a quick reply must not send a request per keystroke.
  useEffect(() => {
    if (!page) return
    const timer = window.setTimeout(() => {
      void api
        .putSettings({
          lang: settings.lang,
          quickReply: settings.quickReply,
          tone: settings.tone,
          selectedChats: settings.selectedChats,
          llmModel: settings.llmModel,
        })
        .catch((err: unknown) => console.warn('[teleglass] settings were not mirrored:', err))
    }, 600)
    return () => window.clearTimeout(timer)
  }, [page, settings])

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...patch }))
  }, [])

  // Settings stay the source of truth for both surfaces; i18next follows them.
  useEffect(() => {
    setLang(settings.lang)
  }, [settings.lang])

  const t = useT()

  if (bootFailed) {
    return (
      <div className="phone">
        <div className="auth">
          <div className="auth__success">
            <span className="h-large">{t('app.name')}</span>
            <span className="detail dim">{t('dev.bootError')}</span>
          </div>
        </div>
      </div>
    )
  }

  if (!page || !appState) {
    return (
      <div className="phone">
        <div className="auth">
          <div className="auth__success">
            <span className="h-large">{t('app.name')}</span>
            <span className="detail dim">{t('dev.connecting')}</span>
          </div>
        </div>
      </div>
    )
  }

  if (dev) {
    return <DebugPanel page={page} state={appState} native={native} />
  }

  return (
    <PhoneApp
      t={t}
      settings={settings}
      onChange={updateSettings}
      appState={appState}
    />
  )
}
