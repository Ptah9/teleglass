import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { AuthError, type AuthErrorCode, type AuthState } from '../api/types'
import type { TFunc } from '../i18n'
import { Button, Field } from './components'
import { CheckIcon, PrivacyIcon } from './icons'
import { countdown, formatPhone, isPhoneValid, phoneDigits, secondsLeft } from './format'

/**
 * A1 — Telegram sign-in (ux-webview.md §3). Number + code is the main road,
 * the link is the reserved one at the bottom. No QR: the link and the QR are
 * the same token, and there is nothing to scan with on the same phone.
 *
 * Steps are owned by the API, not by this component: after the WebView is
 * killed while the user is in Telegram, `api.auth()` says which step to show
 * again. The screen never starts the flow from the number when it can restore.
 */

type View = 'boot' | 'landing' | 'phone' | 'code' | 'password' | 'link' | 'expired' | 'success'

const ERROR_KEY: Record<AuthErrorCode, Parameters<TFunc>[0]> = {
  wrongCode: 'phone.auth.error.wrongCode',
  expiredCode: 'phone.auth.error.expiredCode',
  tooMany: 'phone.auth.error.tooMany',
  wrongPassword: 'phone.auth.error.wrongPassword',
  network: 'phone.auth.error.network',
  linkExpired: 'phone.auth.link.expired',
  // `llm` never comes from an auth route; if it somehow does, it is not a
  // wrong code and the generic network line is the honest one.
  llm: 'phone.auth.error.network',
  // Same for `send`: the glasses show OFFLINE, an auth form has no better line.
  send: 'phone.auth.error.network',
  stt: 'phone.auth.error.network',
  unknown: 'phone.auth.error.network',
}

function errorOf(err: unknown): AuthErrorCode {
  return err instanceof AuthError ? err.code : 'unknown'
}

/** iPadOS 13+ reports itself as a Mac, so the touch check matters. */
function isIOS(): boolean {
  const ua = navigator.userAgent
  if (/iPad|iPhone|iPod/.test(ua)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

export function AuthScreen({
  t,
  onConnected,
}: {
  t: TFunc
  onConnected: () => void
}) {
  const [view, setView] = useState<View>('boot')
  const [phone, setPhone] = useState('')
  const [digits, setDigits] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [resendAt, setResendAt] = useState(0)
  const [link, setLink] = useState<{ url: string; expiresAt: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [sentBusy, setSentBusy] = useState(false)
  const [error, setError] = useState<AuthErrorCode | null>(null)
  const [isDemo, setIsDemo] = useState(api.demo)
  const [now, setNow] = useState(Date.now())
  const [cannotOpen, setCannotOpen] = useState(false)
  const alive = useRef(true)

  // Restore the step the backend (or the demo) remembers.
  useEffect(() => {
    alive.current = true
    let stop = false
    api
      .auth()
      .then((state) => {
        if (stop) return
        setIsDemo(api.demo)
        applyState(state)
      })
      .catch(() => {
        if (!stop) setView('landing')
      })
    return () => {
      stop = true
      alive.current = false
    }
    // applyState is stable in behaviour and only runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function applyState(state: AuthState) {
    switch (state.step) {
      case 'code':
        setPhone(state.phone)
        setResendAt(state.resendAt)
        setView('code')
        return
      case 'password':
        setPhone(state.phone)
        setView('password')
        return
      case 'link':
        setLink({ url: state.url, expiresAt: state.expiresAt })
        setView('link')
        return
      case 'connected':
        setView('success')
        return
      default:
        setView('landing')
    }
  }

  // One clock for every countdown on this screen.
  useEffect(() => {
    if (view !== 'code' && view !== 'link') return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [view])

  // The link is short-lived: poll the step and swap to "expired" honestly.
  useEffect(() => {
    if (view !== 'link' || !link) return
    let stop = false
    const tick = async () => {
      try {
        const status = await api.linkState()
        if (stop) return
        if (status === 'connected') setView('success')
        else if (status === 'expired') setView('expired')
      } catch {
        /* one failed poll is not an expired link */
      }
    }
    const timer = window.setInterval(() => void tick(), 2_000)
    void tick()
    return () => {
      stop = true
      window.clearInterval(timer)
    }
  }, [view, link])

  // Coming back from Telegram means the warning "Telegram didn't open" is stale:
  // the user saw it, went there, and returned. The link poll decides the rest.
  useEffect(() => {
    if (!cannotOpen) return
    const onVisible = () => {
      if (document.visibilityState === 'visible') setCannotOpen(false)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [cannotOpen])

  // Success is a checkmark for a moment, then the tabs appear.
  useEffect(() => {
    if (view !== 'success') return
    const timer = window.setTimeout(() => onConnected(), 700)
    return () => window.clearTimeout(timer)
  }, [view, onConnected])

  async function sendCode(phoneValue: string) {
    setBusy(true)
    setError(null)
    try {
      const state = await api.sendCode(phoneValue)
      setPhone(phoneValue)
      if (state.step !== 'code') {
        applyState(state)
        return
      }
      setResendAt(state.resendAt)
      setCode('')
      setView('code')
    } catch (err) {
      setError(errorOf(err))
    } finally {
      setBusy(false)
    }
  }

  async function submitCode() {
    // Telegram login codes are usually five digits (the test DC uses the DC
    // digit five times); the demo uses six. Accept the whole range.
    if (code.length < 4 || code.length > 6) return
    setBusy(true)
    setError(null)
    try {
      const state = await api.verifyCode(phone, code)
      applyState(state)
    } catch (err) {
      setError(errorOf(err))
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  async function submitPassword() {
    if (password.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const state = await api.verifyPassword(password)
      applyState(state)
    } catch (err) {
      setError(errorOf(err))
    } finally {
      setBusy(false)
    }
  }

  async function openLink() {
    setBusy(true)
    setError(null)
    setCannotOpen(false)
    try {
      const state = await api.startLink()
      setLink({ url: state.url, expiresAt: state.expiresAt })
      setNow(Date.now())
      setView('link')
    } catch (err) {
      setError(errorOf(err))
    } finally {
      setBusy(false)
    }
  }

  async function resend() {
    if (sentBusy) return
    setSentBusy(true)
    setError(null)
    try {
      const state = await api.sendCode(phone)
      if (state.step !== 'code') {
        applyState(state)
        return
      }
      setResendAt(state.resendAt)
    } catch (err) {
      setError(errorOf(err))
    } finally {
      setSentBusy(false)
    }
  }

  /**
   * Opening Telegram is platform-specific, and this is not a guess:
   *
   * - iOS (WKWebView): a tapped external scheme goes to the host's
   *   `decidePolicyForNavigationAction`; the Even app then hands `tg://` to iOS,
   *   which opens Telegram. A hidden iframe carries no top-level activation and
   *   is ignored here, so the attempt must be a top-level navigation.
   * - Android (Chromium): a top-level unknown scheme without a host override
   *   replaces our page with `ERR_UNKNOWN_URL_SCHEME` — that would destroy the
   *   login screen. The attempt stays in an iframe, and the 30 s countdown gives
   *   the honest answer if the host does not open it.
   *
   * In both cases, if the page is still visible after 1.2 s, Telegram did not
   * open and the screen says so instead of waiting silently.
   */
  function tryOpenTelegram() {
    if (!link) return
    setCannotOpen(false)

    if (isIOS()) {
      window.location.href = link.url
    } else {
      const frame = document.createElement('iframe')
      frame.style.display = 'none'
      frame.src = link.url
      document.body.appendChild(frame)
      window.setTimeout(() => frame.remove(), 1_500)
    }

    window.setTimeout(() => {
      if (alive.current && document.visibilityState === 'visible') setCannotOpen(true)
    }, 1_200)
  }

  const errorText = error ? t(ERROR_KEY[error]) : null
  const left = secondsLeft(resendAt, now)

  if (view === 'boot') {
    return <div className="auth" aria-busy="true" />
  }

  if (view === 'success') {
    return (
      <div className="auth">
        <div className="auth__success" role="status" aria-live="polite">
          <CheckIcon size={40} />
          <span className="detail dim">{t('phone.auth.connected')}</span>
        </div>
      </div>
    )
  }

  if (view === 'link' && link) {
    return (
      <div className="auth">
        <div className="auth__top">
          <Brand t={t} />
          <p className="h-medium">{t('phone.auth.link.waiting')}</p>
          <div className="auth__form">
            <Button onClick={tryOpenTelegram}>{t('phone.auth.link.open')}</Button>
            <p className="detail dim">
              {t('phone.auth.link.expires', { time: countdown(link.expiresAt, now) })}
            </p>
            {cannotOpen ? <p className="error-text">{t('phone.auth.link.cannotOpen')}</p> : null}
          </div>
        </div>
        <div className="auth__bottom">
          <button type="button" className="linkbtn" onClick={() => setView('phone')}>
            {t('phone.auth.link.usePhone')}
          </button>
        </div>
      </div>
    )
  }

  if (view === 'expired') {
    return (
      <div className="auth">
        <div className="auth__top auth__top--start">
          <Brand t={t} />
          <p className="h-medium">{t('phone.auth.link.expired')}</p>
          <div className="auth__form">
            <Button busy={busy} onClick={() => void openLink()}>
              {busy ? t('phone.auth.connecting') : t('phone.auth.link.new')}
            </Button>
            {errorText ? <p className="error-text">{errorText}</p> : null}
          </div>
        </div>
      </div>
    )
  }

  if (view === 'password') {
    return (
      <div className="auth">
        <div className="auth__top auth__top--start">
          <Brand t={t} />
          <div>
            <p className="h-medium">{t('phone.auth.password.title')}</p>
            <p className="body dim">{t('phone.auth.password.sub')}</p>
          </div>
          <div className="auth__form">
            <Field
              type="password"
              autoComplete="current-password"
              placeholder={t('phone.auth.password.placeholder')}
              value={password}
              disabled={busy}
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitPassword()
              }}
            />
            {isDemo ? <p className="detail dim">{t('phone.auth.password.demo')}</p> : null}
            {errorText ? <p className="error-text">{errorText}</p> : null}
            <Button busy={busy} disabled={password.length === 0} onClick={() => void submitPassword()}>
              {busy ? t('phone.auth.connecting') : t('phone.auth.password.action')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (view === 'code') {
    return (
      <div className="auth">
        <div className="auth__top auth__top--start">
          <Brand t={t} />
          <div>
            <p className="h-medium">{t('phone.auth.code.title')}</p>
            <p className="body dim">{t('phone.auth.code.sent', { phone })}</p>
          </div>
          <div className="auth__form">
            <Field
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder={t('phone.auth.code.placeholder')}
              value={code}
              disabled={busy}
              autoFocus
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitCode()
              }}
            />
            {isDemo ? <p className="detail dim">{t('phone.auth.code.demo')}</p> : null}
            {errorText ? <p className="error-text">{errorText}</p> : null}
            <Button
              busy={busy}
              disabled={code.length < 4 || code.length > 6}
              onClick={() => void submitCode()}
            >
              {busy ? t('phone.auth.connecting') : t('phone.common.continue')}
            </Button>
            <div style={{ textAlign: 'center' }}>
              {left > 0 ? (
                <span className="detail dim">{t('phone.auth.code.resendIn', { s: left })}</span>
              ) : (
                <button
                  type="button"
                  className="linkbtn"
                  disabled={sentBusy}
                  onClick={() => void resend()}
                >
                  {t('phone.auth.code.resend')}
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="auth__bottom">
          <button type="button" className="linkbtn" disabled={busy} onClick={() => void openLink()}>
            {t('phone.auth.link.hint')}
          </button>
        </div>
      </div>
    )
  }

  if (view === 'phone') {
    const valid = isPhoneValid(digits)
    return (
      <div className="auth">
        <div className="auth__top auth__top--start">
          <Brand t={t} />
          <div className="auth__form">
            <Field
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder={t('phone.auth.phone.placeholder')}
              value={formatPhone(digits)}
              disabled={busy}
              autoFocus
              onChange={(e) => setDigits(phoneDigits(e.target.value).slice(0, 15))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && valid) void sendCode(formatPhone(digits))
              }}
            />
            {isDemo ? <p className="detail dim">{t('phone.auth.phone.hint')}</p> : null}
            {errorText ? <p className="error-text">{errorText}</p> : null}
            <Button busy={busy} disabled={!valid} onClick={() => void sendCode(formatPhone(digits))}>
              {busy ? t('phone.auth.connecting') : t('phone.auth.sendCode')}
            </Button>
          </div>
        </div>
        <div className="auth__bottom">
          <button type="button" className="linkbtn" disabled={busy} onClick={() => void openLink()}>
            {t('phone.auth.link.hint')}
          </button>
        </div>
      </div>
    )
  }

  // Landing: what the app is, then the one button. No number field yet.
  // One centred block instead of a button pinned to the top and half a screen
  // of emptiness below it (POLISH.md #6).
  return (
    <div className="auth">
      <div className="auth__top">
        <Brand t={t} tagline />
        <div className="auth__form" style={{ marginTop: 24 }}>
          <Button onClick={() => setView('phone')}>{t('phone.auth.connect')}</Button>
          <p className="auth__privacy">
            <PrivacyIcon size={16} />
            <span>{t('phone.auth.privacy')}</span>
          </p>
          {isDemo ? <p className="detail dim">{t('phone.common.demo')}</p> : null}
        </div>
      </div>
    </div>
  )
}

function Brand({ t, tagline = false }: { t: TFunc; tagline?: boolean }) {
  return (
    <div>
      <h1 className={tagline ? 'auth__name' : 'h-large'}>{t('app.name')}</h1>
      {tagline ? <p className="auth__tagline">{t('phone.auth.landing.title')}</p> : null}
    </div>
  )
}
