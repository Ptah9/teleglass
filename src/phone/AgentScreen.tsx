import type { TFunc } from '../i18n'
import { EmptyState, ScreenHeader } from './components'
import { AgentIcon } from './icons'

/**
 * T2 — a reserved place, not a broken screen (ux-webview.md §3).
 * No input, no buttons, no promise of a date.
 */
export function AgentScreen({ t }: { t: TFunc }) {
  return (
    <div className="phone__main">
      <ScreenHeader title={t('phone.agent.title')} />
      <div className="phone__scroll" style={{ display: 'flex', flexDirection: 'column' }}>
        <EmptyState
          icon={<AgentIcon size={32} />}
          title={t('phone.agent.emptyTitle')}
          body={t('phone.agent.emptyBody')}
        />
      </div>
    </div>
  )
}
