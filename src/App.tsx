import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './api'
import { hasDemoFlag } from './api/demo-flags'
import { DebugPanel } from './dev/DebugPanel'
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
  const [settings, setSettings] = useState<Settings>(() => {
    const loaded = loadSettings()
    // QA only: `?demo=connected` opens the tabs without the fake sign-in.
    // The flag lives in the address, so the packaged build is unaffected.
    return hasDemoFlag('connected') ? { ...loaded, telegram: true } : loaded
  })
  const [native, setNative] = useState<boolean | null>(null)
  const [bootFailed, setBootFailed] = useState(false)

  // Boot the glasses page once (StrictMode mounts twice; getPage is a singleton).
  useEffect(() => {
    let alive = true
    let stop: (() => void) | undefined
    getPage(toGlasses(loadSettings()))
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
  }, [])

  // Settings are the single source for both surfaces: persist and push.
  useEffect(() => {
    if (!page) return
    saveSettings(settings)
    page.applySettings(toGlasses(settings))
  }, [page, settings])

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
