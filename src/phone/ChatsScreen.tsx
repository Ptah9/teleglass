import { useEffect, useState } from 'react'
import { api } from '../api'
import type { ChatSummary } from '../api/types'
import type { TFunc } from '../i18n'
import type { Settings } from '../store/settings'
import {
  Avatar,
  Button,
  Checkbox,
  EmptyState,
  Field,
  ScreenHeader,
  SkeletonRows,
  Toast,
} from './components'
import { useToast } from './useToast'
import { ChatsIcon, CloseIcon, SearchIcon } from './icons'

/**
 * T1 вЂ” which chats the glasses show (ux-webview.md В§3). Every state from the
 * spec is here: loading skeleton, empty, error + Retry, nothing selected,
 * N selected. The row is one control (`role="checkbox"`), the box is only its
 * picture вЂ” no nested buttons, so a tap never lands on the wrong target.
 */

type Load = 'loading' | 'ready' | 'error'

export function ChatsScreen({
  t,
  settings,
  onChange,
  unreadIds,
}: {
  t: TFunc
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  unreadIds: ReadonlySet<string>
}) {
  const [load, setLoad] = useState<Load>('loading')
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [attempt, setAttempt] = useState(0)
  const toast = useToast()

  useEffect(() => {
    let stop = false
    setLoad('loading')
    api
      .chats()
      .then((rows) => {
        if (stop) return
        setChats(rows)
        const ids = new Set(rows.map((c) => c.id))
        setSelected(
          new Set(
            settings.selectedChats ? settings.selectedChats.filter((id) => ids.has(id)) : [...ids],
          ),
        )
        setLoad('ready')
      })
      .catch(() => {
        if (!stop) setLoad('error')
      })
    return () => {
      stop = true
    }
    // `settings.selectedChats` is read once per load on purpose: later edits are
    // local until Save, otherwise the checkboxes would jump while tapping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  const visible = chats.filter((chat) => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return chat.title.toLowerCase().includes(q) || chat.preview.toLowerCase().includes(q)
  })

  // Real chats carry their own unread count; the demo/mock inbox is what the
  // glasses page knows about, so it is the fallback for chats without one.
  const isUnread = (chat: ChatSummary) =>
    chat.unread !== undefined ? chat.unread > 0 : unreadIds.has(chat.id)
  const unread = chats.filter(isUnread)
  const allUnreadSelected = unread.length > 0 && unread.every((chat) => selected.has(chat.id))

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleUnread() {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allUnreadSelected) for (const chat of unread) next.delete(chat.id)
      else for (const chat of unread) next.add(chat.id)
      return next
    })
  }

  function save() {
    if (selected.size === 0) return
    onChange({
      selectedChats: selected.size === chats.length ? null : [...selected],
    })
    toast.show(t('phone.chats.saved'))
  }

  return (
    <div className="phone__main">
      <ScreenHeader title={t('phone.chats.title')} />
      <div className="phone__scroll">
        {load === 'ready' ? (
          <>
            <div className="search-row">
              <div className="field-wrap">
                <span className="field-wrap__icon">
                  <SearchIcon size={20} />
                </span>
                <Field
                  type="search"
                  placeholder={t('phone.chats.search')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label={t('phone.chats.search')}
                />
                {query.length > 0 ? (
                  <button
                    type="button"
                    className="field-wrap__clear"
                    aria-label={t('phone.chats.clearSearch')}
                    // Keep the caret in the field: the tap clears, it does not move focus.
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => setQuery('')}
                  >
                    <CloseIcon size={16} />
                  </button>
                ) : null}
              </div>
            </div>

            {chats.length > 0 && unread.length > 0 ? (
              <button
                type="button"
                className="select-all"
                role="checkbox"
                aria-checked={allUnreadSelected}
                onClick={toggleUnread}
              >
                <Checkbox checked={allUnreadSelected} />
                <span>{t('phone.chats.selectUnread')}</span>
              </button>
            ) : null}
          </>
        ) : null}

        {load === 'loading' ? <SkeletonRows count={5} /> : null}

        {load === 'error' ? (
          <div className="empty">
            <p className="h-medium">{t('phone.chats.error')}</p>
            <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
              {t('phone.common.retry')}
            </Button>
          </div>
        ) : null}

        {load === 'ready' && chats.length === 0 ? (
          <EmptyState
            icon={<ChatsIcon size={32} />}
            title={t('phone.chats.emptyTitle')}
            body={t('phone.chats.emptyBody')}
          />
        ) : null}

        {load === 'ready' && chats.length > 0 ? (
          <div className="chat-list">
            {visible.map((chat) => {
              const checked = selected.has(chat.id)
              return (
                <button
                  key={chat.id}
                  type="button"
                  className="chat-row"
                  role="checkbox"
                  aria-checked={checked}
                  data-selected={checked}
                  onClick={() => toggle(chat.id)}
                >
                  <Avatar title={chat.title} />
                  <span className="chat-row__body">
                    <span className="chat-row__name">{chat.title}</span>
                    <span className="chat-row__preview">{chat.preview}</span>
                  </span>
                  <span className="check check--box" data-checked={checked}>
                    <Checkbox checked={checked} />
                  </span>
                </button>
              )
            })}
          </div>
        ) : null}
      </div>

      {load === 'ready' && chats.length > 0 ? (
        <div className="save-bar">
          <p className="save-bar__count">
            {selected.size === 0
              ? t('phone.chats.selectAtLeastOne')
              : t('phone.chats.selectedCount', { count: selected.size })}
          </p>
          <Button disabled={selected.size === 0} onClick={save}>
            {t('phone.chats.save')}
          </Button>
        </div>
      ) : null}

      <Toast message={toast.message} />
    </div>
  )
}
