import type { View } from './build'

/**
 * Browser preview of the glasses screen: the same coordinates that go to the SDK.
 * The font here is a system one and wider than the Even grotesque — the preview
 * is for logic debugging, not for visual comparison. Visual comparison is the
 * simulator and hardware.
 */

const LEVEL_COLOR: Record<number, string> = {
  1: '#2f6326',
  2: '#4b9a3d',
  3: '#71d15c',
  4: '#9dff8a',
}

function borderColor(level: number): string {
  return `rgba(157, 255, 138, ${0.1 + level * 0.045})`
}

export function GlassesPreview({
  view,
  onRow,
}: {
  view: View
  onRow?: (index: number) => void
}) {
  const list = view.list
  return (
    <div className="g2">
      {view.texts.map((t) => (
        <div
          key={t.id}
          className="slot"
          style={{
            left: t.x,
            top: t.y,
            width: t.w,
            height: t.h,
            color: LEVEL_COLOR[t.level],
            borderWidth: t.border ? t.border.width : 0,
            borderColor: t.border ? borderColor(t.border.color) : 'transparent',
            borderRadius: t.border ? t.border.radius : 0,
          }}
        >
          {t.content}
        </div>
      ))}
      {list && (
        <div
          className="g2-list"
          style={{ left: list.x, top: list.y, width: list.w }}
        >
          {list.items.map((item, i) => (
            <button
              type="button"
              key={item}
              className={i === list.sel ? 'row sel' : 'row'}
              onClick={() => onRow?.(i)}
            >
              {item}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
