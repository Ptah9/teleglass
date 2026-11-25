import { useEffect, useRef, useState } from 'react'
import { getPage, type Page } from './even/page'
import { makeT } from './i18n'
import type { AppState, Gesture } from './state/types'
import { buildView } from './view/build'
import { GlassesPreview } from './view/preview'

/**
 * Browser debug panel. Inside Even App it stays on the phone and doubles as a
 * backup remote: the buttons drive the same logic as the gestures from the
 * temple arm. In a plain browser it is the only way to drive the interface.
 *
 * Panel strings also go through the dictionary (dev.* keys): no literals in markup.
 */

interface LogEntry {
  id: number
  kind: string
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [native, setNative] = useState<boolean | null>(null)
  const [bootFailed, setBootFailed] = useState(false)
  const [screens, setScreens] = useState<LogEntry[]>([])
  const pageRef = useRef<Page | null>(null)
  const lastKind = useRef('')
  const logSeq = useRef(0)

  useEffect(() => {
    let alive = true
    let stop: (() => void) | undefined
    getPage()
      .then((page) => {
        if (!alive) return
        pageRef.current = page
        setState(page.state())
        setNative(page.native)
        stop = page.subscribe((s) => {
          setState(s)
          if (s.screen.kind !== lastKind.current) {
            lastKind.current = s.screen.kind
            const id = ++logSeq.current
            setScreens((prev) => [{ id, kind: s.screen.kind }, ...prev].slice(0, 24))
          }
        })
      })
      .catch((err: unknown) => {
        // Never leave the panel on "connecting…": a failed boot is a message,
        // not a spinner (app-submission.md: no infinite spinner).
        console.error('[teleglass] page failed to start:', err)
        if (alive) setBootFailed(true)
      })
    return () => {
      alive = false
      stop?.()
    }
  }, [])

  const t = makeT(state?.lang ?? 'en')
  const view = state ? buildView(state, t) : null

  if (!state || !view) {
    return (
      <div className="app">
        <p className="dim">{bootFailed ? t('dev.bootError') : t('dev.connecting')}</p>
      </div>
    )
  }

  // The ref is read only in handlers, never in the render body.
  const g = (x: Gesture) => () => {
    pageRef.current?.gesture(x)
  }

  // A swipe over the list moves the selection (as the glasses firmware does),
  // over text it is a regular gesture.
  const swipe = (dir: 'up' | 'down') => () => {
    const page = pageRef.current
    if (!page) return
    if (view.list) {
      const next = dir === 'up' ? view.list.sel - 1 : view.list.sel + 1
      page.dispatch({ type: 'listSelect', index: next })
    } else {
      page.gesture(dir === 'up' ? 'swipeUp' : 'swipeDown')
    }
  }

  const menu = (item: number) => () => {
    pageRef.current?.dispatch({ type: 'menu', item })
  }

  const row = (index: number) => () => {
    pageRef.current?.dispatch({ type: 'listClick', index })
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
              <button type="button" onClick={menu(3)}>{t('dev.mic')}</button>
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
