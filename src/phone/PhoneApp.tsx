import { useMemo, useState } from 'react'
import { api } from '../api'
import { clearAllLocalData, type Settings } from '../store/settings'
import type { AppState } from '../state/types'
import type { TFunc } from '../i18n'
import { AgentScreen } from './AgentScreen'
import { AuthScreen } from './AuthScreen'
import { ChatsScreen } from './ChatsScreen'
import { SettingsScreen } from './SettingsScreen'
import { TabBar, type Tab } from './TabBar'
import './phone.css'

/**
 * The phone surface. One WebView serves both screens: this UI on the phone and
 * the containers on the glasses. Settings written here are pushed straight into
 * the glasses page (`Page.applySettings`), so the two are never out of sync.
 *
 * Before Telegram is connected there are no tabs at all (ux-webview.md §3.1):
 * an empty `Chats` would leave a first-time user with no idea what to do.
 */
export function PhoneApp({
  t,
  settings,
  onChange,
  appState,
}: {
  t: TFunc
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  appState: AppState
}) {
  const [tab, setTab] = useState<Tab>('chats')

  const unreadIds = useMemo(() => {
    const read = appState.read
    return new Set(
      appState.chats
        .filter((chat) => chat.messages.some((message) => !read[message.id]))
        .map((chat) => chat.id),
    )
  }, [appState.chats, appState.read])

  async function disconnect() {
    await api.logout()
    onChange({ telegram: false })
    setTab('chats')
  }

  async function deleteAll() {
    await api.deleteAll()
    clearAllLocalData()
    // The glasses page and the app-level settings both start from scratch; a
    // reload is the honest way to drop every in-memory mock and timer at once.
    window.location.reload()
  }

  if (!settings.telegram) {
    return (
      <div className="phone">
        <AuthScreen t={t} onConnected={() => onChange({ telegram: true })} />
      </div>
    )
  }

  return (
    <div className="phone">
      {tab === 'chats' ? (
        <ChatsScreen
          t={t}
          settings={settings}
          onChange={onChange}
          unreadIds={unreadIds}
        />
      ) : null}
      {tab === 'agent' ? <AgentScreen t={t} /> : null}
      {tab === 'settings' ? (
        <SettingsScreen
          t={t}
          settings={settings}
          onChange={onChange}
          onDisconnect={disconnect}
          onDelete={deleteAll}
        />
      ) : null}
      <TabBar tab={tab} onChange={setTab} t={t} />
    </div>
  )
}
