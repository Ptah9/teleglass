import { useEffect, useRef, useState } from 'react'
import type { Page } from '../even/page'
import { makeT } from '../i18n'
import type { AppState, Gesture } from '../state/types'
import { buildView } from '../view/build'
import { GlassesPreview } from '../view/preview'

/**
 * Browser debug panel (`?dev=1`). Inside Even App it stays on the phone and
 * doubles as a backup remote: the buttons drive the same logic as the gestures
 * from the temple arm. In a plain browser it is the only way to drive the
 * interface without the simulator's controls.
 *
 * This is a developer surface, not the product: the phone shows `PhoneApp`.
 * Panel strings also go through the dictionary (dev.* keys).
 */

interface LogEntry {
  id: number
  kind: string
}

export function DebugPanel({
  page,
  state,
  native,
}: {
  page: Page
  state: AppState
  native: boolean | null
}) {
  const [screens, setScreens] = useState<LogEntry[]>([])
  const lastKind = useRef(state.screen.kind)
  const logSeq = useRef(0)

  useEffect(() => {
    if (state.screen.kind === lastKind.current) return
    lastKind.current = state.screen.kind
    const id = ++logSeq.current
    setScreens((prev) => [{ id, kind: state.screen.kind }, ...prev].slice(0, 24))
  }, [state.screen.kind])

  const t = makeT(state.lang)
  const view = buildView(state, t)

  const g = (x: Gesture) => () => {
    page.gesture(x)
  }

  // A swipe over the list moves the selection (as the glasses firmware does),
  // over text it is a regular gesture.
  const swipe = (dir: 'up' | 'down') => () => {
    if (view.list) {
      const next = dir === 'up' ? view.list.sel - 1 : view.list.sel + 1
      page.dispatch({ type: 'listSelect', index: next })
    } else {
      page.gesture(dir === 'up' ? 'swipeUp' : 'swipeDown')
    }
  }

  const menu = (item: number) => () => {
    page.dispatch({ type: 'menu', item })
  }

  const row = (index: number) => () => {
    page.dispatch({ type: 'listClick', index })
  }

  const badge =
    native === null ? t('dev.connecting')
      : native ? t('dev.native')
        : t('dev.mock')

  return (
    <div className="app">
      <header>
        <h1>{t('app.name')}</h1>
        <p className={`badge ${native ? 'ok' : 'mock'}`}>{badge}</p>
      </header>

      <div className="grid">
        <section>
          <GlassesPreview view={view} onRow={(i) => row(i)()} />

          <div className="controls">
            <div className="btns">
              <button type="button" onClick={swipe('up')}>{t('dev.up')}</button>
              <button type="button" onClick={g('click')}>{t('dev.tap')}</button>
              <button type="button" onClick={swipe('down')}>{t('dev.down')}</button>
              <button type="button" onClick={g('doubleClick')}>{t('dev.double')}</button>
              <button type="button" onClick={g('longPress')}>{t('dev.hold')}</button>
              <button type="button" onClick={g('longPressRelease')}>{t('dev.release')}</button>
            </div>
            <div className="btns demo">
              <button type="button" onClick={menu(1)}>{t('dev.lang')}</button>
              <button type="button" onClick={menu(2)}>{t('dev.backend')}</button>
              <button type="button" onClick={menu(4)}>{t('dev.telegram')}</button>
              <button type="button" onClick={menu(5)}>{t('dev.read')}</button>
            </div>
          </div>
        </section>

        <aside>
          <h2>{t('dev.log')}</h2>
          <p className="dim small">
            {t('dev.state')}: <code>{state.screen.kind}</code>
          </p>
          <ol className="log">
            {screens.map((e) => (
              <li key={e.id}>{e.kind}</li>
            ))}
          </ol>
        </aside>
      </div>
    </div>
  )
}
