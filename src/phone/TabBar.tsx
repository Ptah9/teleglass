import type { TFunc } from '../i18n'
import { AgentIcon, ChatsIcon, SettingsIcon } from './icons'

export type Tab = 'chats' | 'agent' | 'settings'

/**
 * Bottom tabs, visible only after Telegram is connected (ux-webview.md §3.1).
 * `Agent` keeps its place so adding the feature later does not move the layout.
 */
export function TabBar({
  tab,
  onChange,
  t,
}: {
  tab: Tab
  onChange: (next: Tab) => void
  t: TFunc
}) {
  const items = [
    { id: 'chats' as const, label: t('phone.tabs.chats'), Icon: ChatsIcon },
    { id: 'agent' as const, label: t('phone.tabs.agent'), Icon: AgentIcon },
    { id: 'settings' as const, label: t('phone.tabs.settings'), Icon: SettingsIcon },
  ]

  return (
    <nav className="tabs" role="tablist" aria-label={t('app.name')}>
      {items.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          className="tabs__btn"
          aria-selected={tab === id}
          onClick={() => {
            if (tab !== id) onChange(id)
          }}
        >
          <Icon size={24} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  )
}
