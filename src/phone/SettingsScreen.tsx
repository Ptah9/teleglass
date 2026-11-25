import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Health, StatusLevel } from '../api/types'
import type { Lang, TFunc } from '../i18n'
import { LLM_MODELS, modelLabel } from '../store/llm'
import { QUICK_REPLY_MAX, type Settings, type Tone } from '../store/settings'
import {
  Button,
  Field,
  ScreenHeader,
  Segmented,
  Sheet,
  TextArea,
} from './components'
import { clockTime } from './format'
import { CheckIcon } from './icons'

/**
 * T3 — everything the glasses cannot show (ux-webview.md §3).
 * One long screen, no Save button: the WebView can be suspended at any moment,
 * so every field is written on change. Status dots always carry a word next to
 * them — a red dot alone says nothing (POLISH.md #17).
 */

type Dialog = 'disconnect' | 'delete' | null

const STATUS_KEY: Record<StatusLevel, Parameters<TFunc>[0]> = {
  ok: 'phone.settings.statusOk',
  off: 'phone.settings.statusOff',
  error: 'phone.settings.statusError',
  demo: 'phone.settings.statusDemo',
}

export function SettingsScreen({
  t,
  settings,
  onChange,
  onDisconnect,
  onDelete,
}: {
  t: TFunc
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onDisconnect: () => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [health, setHealth] = useState<Health | null>(null)
  const [checking, setChecking] = useState(true)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState(false)

  // The key is never part of `Settings`: it would land in localStorage.
  const [llmKey, setLlmKey] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyStatus, setKeyStatus] = useState<'saved' | 'demo' | null>(null)
  const [keyError, setKeyError] = useState(false)
  const [modelSheet, setModelSheet] = useState(false)

  async function check() {
    setChecking(true)
    try {
      setHealth(await api.health())
    } catch {
      setHealth({ backend: 'error', llm: 'off', checkedAt: new Date().toISOString() })
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    // First check runs outside the effect body so the effect does not set state
    // synchronously (React 19 lint rule); `checking` already starts as true.
    let stop = false
    api
      .health()
      .then((h) => {
        if (stop) return
        setHealth(h)
        setChecking(false)
      })
      .catch(() => {
        if (stop) return
        setHealth({ backend: 'error', llm: 'off', checkedAt: new Date().toISOString() })
        setChecking(false)
      })
    return () => {
      stop = true
    }
  }, [])

  const toneOptions: { value: Tone; label: string }[] = [
    { value: 'short', label: t('phone.settings.tone.short') },
    { value: 'warm', label: t('phone.settings.tone.warm') },
    { value: 'formal', label: t('phone.settings.tone.formal') },
  ]
  const langOptions: { value: Lang; label: string }[] = [
    { value: 'en', label: t('phone.settings.language.en') },
    { value: 'ru', label: t('phone.settings.language.ru') },
  ]

  async function confirm() {
    if (actionBusy) return
    setActionBusy(true)
    setActionError(false)
    try {
      if (dialog === 'disconnect') {
        await onDisconnect()
        setDialog(null)
        void check()
      } else if (dialog === 'delete') {
        await onDelete()
        setDialog(null)
      }
    } catch {
      setActionError(true)
    } finally {
      setActionBusy(false)
    }
  }

  async function saveKey() {
    const value = llmKey.trim()
    if (value.length === 0 || keyBusy) return
    setKeyBusy(true)
    setKeyError(false)
    setKeyStatus(null)
    try {
      await api.setLlmKey(value)
      // One-way by design: the field does not keep the secret after sending.
      setLlmKey('')
      setKeyStatus(api.demo ? 'demo' : 'saved')
    } catch {
      setKeyError(true)
    } finally {
      setKeyBusy(false)
    }
  }

  const quickReply = settings.quickReply
  const quickReplyEmpty = quickReply.trim().length === 0
  const telegramLevel: StatusLevel = settings.telegram ? 'ok' : 'off'

  return (
    <div className="phone__main">
      <ScreenHeader title={t('phone.settings.title')} />
      <div className="phone__scroll">
        <section className="section">
          <h2 className="section__label">{t('phone.settings.quickReply')}</h2>
          <div className="card">
            <TextArea
              value={quickReply}
              maxLength={QUICK_REPLY_MAX}
              placeholder={t('phone.settings.quickReply.placeholder')}
              onChange={(e) => onChange({ quickReply: e.target.value.slice(0, QUICK_REPLY_MAX) })}
              aria-label={t('phone.settings.quickReply')}
            />
            <div className="field-foot">
              <span className="detail dim">{t('phone.settings.quickReply.hint')}</span>
              <span className="detail dim" aria-hidden="true">
                {quickReply.length}/{QUICK_REPLY_MAX}
              </span>
            </div>
            {quickReplyEmpty ? (
              <p className="error-text">{t('phone.settings.quickReply.empty')}</p>
            ) : null}
          </div>
        </section>

        <section className="section">
          <h2 className="section__label">{t('phone.settings.tone')}</h2>
          <Segmented
            name="tone"
            label={t('phone.settings.tone')}
            options={toneOptions}
            value={settings.tone}
            onChange={(tone) => onChange({ tone })}
          />
        </section>

        <section className="section">
          <h2 className="section__label">{t('phone.settings.language')}</h2>
          <Segmented
            name="language"
            label={t('phone.settings.language')}
            options={langOptions}
            value={settings.lang}
            onChange={(lang) => onChange({ lang })}
          />
        </section>

        <section className="section">
          <h2 className="section__label">{t('phone.llm.title')}</h2>
          <div className="card">
            <label className="llm-label" htmlFor="llm-key">
              {t('phone.llm.key')}
            </label>
            <Field
              id="llm-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={t('phone.llm.keyPlaceholder')}
              value={llmKey}
              disabled={keyBusy}
              onChange={(e) => {
                setLlmKey(e.target.value)
                setKeyStatus(null)
                setKeyError(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveKey()
              }}
            />
            <p className="detail dim">{t('phone.llm.keyHint')}</p>
            {api.demo ? <p className="detail dim">{t('phone.llm.demoNote')}</p> : null}
            {keyStatus ? (
              <p className="detail" role="status">
                {t(keyStatus === 'demo' ? 'phone.llm.demoSaved' : 'phone.llm.saved')}
              </p>
            ) : null}
            {keyError ? <p className="error-text">{t('phone.common.actionFailed')}</p> : null}
            <div className="llm-actions">
              <Button busy={keyBusy} disabled={llmKey.trim().length === 0} onClick={() => void saveKey()}>
                {t('phone.llm.save')}
              </Button>
            </div>
          </div>

          <div className="card">
            <button
              type="button"
              className="picker-trigger"
              aria-haspopup="dialog"
              onClick={() => setModelSheet(true)}
            >
              <span>{t('phone.llm.model')}</span>
              <span className="picker-trigger__value">{modelLabel(settings.llmModel)}</span>
            </button>
          </div>
        </section>

        <section className="section">
          <h2 className="section__label">{t('phone.settings.status')}</h2>
          <button
            type="button"
            className="card"
            style={{
              display: 'block',
              width: '100%',
              border: 0,
              textAlign: 'left',
              cursor: 'pointer',
            }}
            aria-busy={checking || undefined}
            onClick={() => void check()}
          >
            <StatusRow name={t('phone.settings.telegram')} level={telegramLevel} t={t} />
            <StatusRow name={t('phone.settings.backend')} level={health?.backend ?? 'off'} t={t} />
            <StatusRow name={t('phone.settings.llm')} level={health?.llm ?? 'off'} t={t} />
          </button>
          <div className="field-foot">
            <span className="detail dim">
              {health
                ? t('phone.settings.lastChecked', { time: clockTime(health.checkedAt) })
                : t('phone.common.loading')}
            </span>
            <button
              type="button"
              className="linkbtn"
              disabled={checking}
              onClick={() => void check()}
            >
              {t('phone.settings.checkNow')}
            </button>
          </div>
        </section>

        <section className="section">
          <h2 className="section__label">{t('phone.settings.danger')}</h2>
          <div className="card card--flush">
            <button
              type="button"
              className="danger-row"
              onClick={() => {
                setActionError(false)
                setDialog('disconnect')
              }}
            >
              {t('phone.danger.disconnect.action')}
            </button>
            <button
              type="button"
              className="danger-row"
              onClick={() => {
                setActionError(false)
                setDialog('delete')
              }}
            >
              {t('phone.danger.delete.action')}
            </button>
          </div>
        </section>
      </div>

      {dialog === 'disconnect' ? (
        <Sheet
          title={t('phone.danger.disconnect.title')}
          body={t('phone.danger.disconnect.body')}
          onClose={() => {
            if (!actionBusy) setDialog(null)
          }}
        >
          {actionError ? <p className="error-text">{t('phone.common.actionFailed')}</p> : null}
          <Button variant="danger" busy={actionBusy} onClick={() => void confirm()}>
            {t('phone.danger.disconnect.action')}
          </Button>
          <Button variant="secondary" disabled={actionBusy} onClick={() => setDialog(null)}>
            {t('phone.common.cancel')}
          </Button>
        </Sheet>
      ) : null}

      {dialog === 'delete' ? (
        <Sheet
          title={t('phone.danger.delete.title')}
          body={t('phone.danger.delete.body')}
          onClose={() => {
            if (!actionBusy) setDialog(null)
          }}
        >
          {actionError ? <p className="error-text">{t('phone.common.actionFailed')}</p> : null}
          <Button variant="danger" busy={actionBusy} onClick={() => void confirm()}>
            {t('phone.danger.delete.action')}
          </Button>
          <Button variant="secondary" disabled={actionBusy} onClick={() => setDialog(null)}>
            {t('phone.common.cancel')}
          </Button>
        </Sheet>
      ) : null}
      {modelSheet ? (
        <Sheet title={t('phone.llm.model')} onClose={() => setModelSheet(false)}>
          {LLM_MODELS.map((model) => (
            <button
              key={model.id}
              type="button"
              className="picker-row"
              aria-pressed={settings.llmModel === model.id}
              onClick={() => {
                onChange({ llmModel: model.id })
                setModelSheet(false)
              }}
            >
              <span>{model.label}</span>
              {settings.llmModel === model.id ? <CheckIcon size={20} /> : null}
            </button>
          ))}
        </Sheet>
      ) : null}
    </div>
  )
}

function StatusRow({
  name,
  level,
  t,
}: {
  name: string
  level: StatusLevel
  t: TFunc
}) {
  return (
    <span className="status-row">
      <span className="status-row__dot" data-level={level} aria-hidden="true" />
      <span className="status-row__name">{name}</span>
      <span className="status-row__value">{t(STATUS_KEY[level])}</span>
    </span>
  )
}
