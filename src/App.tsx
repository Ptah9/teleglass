import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { UNAUTHORIZED_EVENT } from './api/client'
import { hasDemoFlag } from './api/demo-flags'
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
const toGlasses = (s: Settings) => ({
  lang: s.lang,
  quickReply: s.quickReply.trim().length > 0 ? s.quickReply : MOCK_QUICK_REPLY,
  telegramConnected: s.telegram,
  selectedChats: s.selectedChats,
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
    getPage(toGlasses(bootSettings))
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
    page.applySettings(toGlasses(settings))
  }, [page, settings])

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
        // is only honest when there is nothing to show yet.
        const known = page.state().feedStatus === 'ready'
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
