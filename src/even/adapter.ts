import {
  AudioInputSource,
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  formatEvenHubPageContainerValidationError,
  isMenuNameWithinLimit,
  isValidMenuItemID,
  validateEvenHubPageContainer,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
  type LaunchSource,
} from '@evenrealities/even_hub_sdk'
import type { AppEvent, AudioSource, Gesture, Lang } from '../state/types'
import type { View, ViewList, ViewText } from '../view/build'

/**
 * Bridge between the pure logic and the glasses screen.
 *
 * SDK rules honoured here:
 * - exactly one container with isEventCapture: 1 per page;
 * - textContainerUpgrade to change text, rebuildPageContainer to change the
 *   layout or the list (the list is not updated in place — firmware limitation);
 * - menuObject is passed on EVERY rebuild, otherwise the menu disappears;
 * - containerID and containerName match between create/upgrade;
 * - every page goes through the SDK's own validateEvenHubPageContainer before
 *   it is sent: the SDK rejects an invalid page locally, and its formatted
 *   error is the only readable diagnostic we get;
 * - menu items are filtered with isValidMenuItemID / isMenuNameWithinLimit so
 *   one over-long label cannot reject the whole page;
 * - language lives in the host storage (setLocalStorage/getLocalStorage), so it
 *   survives a WebView restart on Android (background-lifecycle.md);
 * - the microphone is the SDK's audioControl/audioEvent, not a drawn mock.
 */

export interface MenuItem {
  readonly id: number
  readonly name: string
}

export interface GlassesTarget {
  /** true — runs inside Even App, false — browser stub. */
  readonly native: boolean
  render(view: View, menu: MenuItem[]): Promise<void>
  onEvent(cb: (e: AppEvent) => void): () => void
  /** Root page: system exit dialog. */
  exit(): void
  /** Language persisted by the host; null when nothing is stored yet. */
  loadLang(): Promise<Lang | null>
  saveLang(lang: Lang): Promise<void>
  /** Microphone on/off through the SDK; the level arrives as an AppEvent. */
  audio(on: boolean, source: AudioSource): Promise<void>
}

/**
 * How many containers must change in one render before it is cheaper to redraw
 * the whole page: sequential upgrades leave a mixed screen for a few frames.
 */
const ATOMIC_REDRAW_MIN = 3

/** Stable container ids: identical across create, rebuild and upgrade. */const CONTAINER_ID: Record<string, number> = {
  title: 1,
  divider: 2,
  body: 3,
  sub: 4,
  footer: 5,
  indicator: 6,
  list: 9,
  divider2: 10,
}

function textProp(v: ViewText): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: v.x,
    yPosition: v.y,
    width: v.w,
    height: v.h,
    borderWidth: v.border?.width ?? 0,
    borderColor: v.border?.color ?? 0,
    borderRadius: v.border?.radius ?? 0,
    paddingLength: 0,
    containerID: CONTAINER_ID[v.id],
    containerName: v.id,
    content: v.content,
    textColor: v.level,
    isEventCapture: v.capture ? 1 : 0,
  })
}

function listProp(v: ViewList): ListContainerProperty {
  return new ListContainerProperty({
    xPosition: v.x,
    yPosition: v.y,
    width: v.w,
    height: v.h,
    borderWidth: 0,
    paddingLength: 0,
    containerID: CONTAINER_ID[v.id],
    containerName: v.id,
    // Selection highlight is native: the firmware moves the frame and scrolls itself.
    isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: v.items.length,
      itemWidth: v.w,
      isItemSelectBorderEn: 1,
      itemName: [...v.items],
    }),
  })
}

function menuProp(menu: MenuItem[]): MenuContainerProperty {
  return new MenuContainerProperty({
    menuItems: menu.map((m) => new MenuItemProperty({ itemID: m.id, itemName: m.name })),
  })
}

/**
 * Firmware event → logic gesture map.
 *
 * Community-notes quirk: CLICK_EVENT = 0 is normalized to undefined —
 * undefined in textEvent/sysEvent is also a tap, not "no event".
 */
function gestureOf(et: OsEventTypeList | undefined): Gesture | null {
  switch (et) {
    case OsEventTypeList.CLICK_EVENT:
    case undefined:
      return 'click'
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      return 'doubleClick'
    case OsEventTypeList.SCROLL_TOP_EVENT:
      return 'swipeUp'
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      return 'swipeDown'
    case OsEventTypeList.LONG_PRESS_EVENT:
      return 'longPress'
    case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
      return 'longPressRelease'
    default:
      console.log('[teleglass] unhandled system event:', et)
      return null
  }
}

function nativeTarget(bridge: EvenAppBridge): GlassesTarget {
  const listeners = new Set<(e: AppEvent) => void>()
  let prevSig: string | null = null
  let prevTexts: Record<string, { content: string; level: number }> = {}
  let audioOn = false

  const emit = (e: AppEvent) => {
    for (const l of [...listeners]) l(e)
  }

  bridge.onEvenHubEvent((ev: EvenHubEvent) => {
    // Microphone: PCM 16 kHz, signed 16-bit little-endian, mono. The level is
    // the RMS of the chunk; the transcript stays a mock until STT arrives.
    if (ev.audioEvent) {
      if (!audioOn) return
      emit({ type: 'audio', level: levelOf(ev.audioEvent.audioPcm) })
      return
    }

    // Context menu demo levers.
    const menu = ev.menuItemClickEvent
    if (menu) {
      emit({ type: 'menu', item: menu.itemID ?? 0 })
      return
    }

    // List: a tap carries the item index, a swipe may carry nothing
    // (the firmware moves the highlight silently, SCROLL_* comes at the edges).
    const le = ev.listEvent
    if (le) {
      const idx = le.currentSelectItemIndex
      switch (le.eventType) {
        case OsEventTypeList.CLICK_EVENT:
        case undefined:
          emit({ type: 'listClick', index: idx ?? -1 })
          return
        case OsEventTypeList.DOUBLE_CLICK_EVENT:
          emit({ type: 'gesture', gesture: 'doubleClick' })
          return
        case OsEventTypeList.SCROLL_TOP_EVENT:
          if (idx !== undefined) emit({ type: 'listSelect', index: idx })
          else emit({ type: 'gesture', gesture: 'swipeUp' })
          return
        case OsEventTypeList.SCROLL_BOTTOM_EVENT:
          if (idx !== undefined) emit({ type: 'listSelect', index: idx })
          else emit({ type: 'gesture', gesture: 'swipeDown' })
          return
        case OsEventTypeList.LONG_PRESS_EVENT:
          emit({ type: 'gesture', gesture: 'longPress' })
          return
        case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
          emit({ type: 'gesture', gesture: 'longPressRelease' })
          return
        default:
          console.log('[teleglass] unhandled list event:', le.eventType)
          return
      }
    }

    // Text or system: gesture by eventType.
    const src = ev.textEvent ?? ev.sysEvent
    if (!src) return
    const g = gestureOf(src.eventType)
    if (g) emit({ type: 'gesture', gesture: g })
  })

  /**
   * Drop menu items the SDK would reject (id 0/duplicate, label over
   * 32 UTF-8 bytes) instead of losing the whole page to one long label.
   */
  function safeMenu(menu: MenuItem[]): MenuItem[] {
    const seen = new Set<number>()
    const out: MenuItem[] = []
    for (const m of menu) {
      if (!isValidMenuItemID(m.id) || seen.has(m.id) || !isMenuNameWithinLimit(m.name)) {
        console.error('[teleglass] menu item rejected by SDK rules:', m)
        continue
      }
      seen.add(m.id)
      out.push(m)
    }
    return out
  }

  function buildPage(view: View, menu: MenuItem[]) {
    return {
      containerTotalNum: view.texts.length + (view.list ? 1 : 0),
      textObject: view.texts.map(textProp),
      listObject: view.list ? [listProp(view.list)] : undefined,
      menuObject: menuProp(safeMenu(menu)),
    }
  }

  /**
   * Create/rebuild the page. Every payload goes through the SDK's own
   * validator first: the SDK would reject it locally anyway, and its formatted
   * error is the only readable diagnostic.
   */
  async function sendPage(view: View, menu: MenuItem[], first: boolean): Promise<boolean> {
    const page = buildPage(view, menu)
    const check = validateEvenHubPageContainer(page)
    if (!check.valid) {
      console.error(formatEvenHubPageContainerValidationError(check))
      return false
    }
    try {
      if (first) {
        const r = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page))
        if (r === StartUpPageCreateResult.success) return true
        // A page from a previous WebView session may still be on the host
        // (dev reload / app resume): create refuses a second startup page, and
        // rebuilding over it is the documented way to replace the layout.
        // Warning, not error: the fallback below restores the screen, and the
        // store QA gate scans the boot console for errors.
        console.warn(
          '[teleglass] createStartUpPageContainer →',
          r,
          '— rebuilding over the existing page',
        )
        const ok = await bridge.rebuildPageContainer(new RebuildPageContainer(page))
        if (ok) return true
        console.error('[teleglass] rebuildPageContainer → false')
        return false
      }
      const ok = await bridge.rebuildPageContainer(new RebuildPageContainer(page))
      if (ok) return true
      console.error('[teleglass] rebuildPageContainer → false')
      return false
    } catch (err) {
      console.error('[teleglass] page was not sent:', err)
      return false
    }
  }

  async function upgradeText(v: ViewText): Promise<boolean> {
    try {
      return await bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: CONTAINER_ID[v.id],
          containerName: v.id,
          content: v.content,
          textColor: v.level,
        }),
      )
    } catch (err) {
      console.error('[teleglass] textContainerUpgrade failed:', v.id, err)
      return false
    }
  }

  /** Remember what the host now shows; a failed call is retried on the next render. */
  function syncTexts(view: View, only?: Iterable<ViewText>): void {
    if (!only) {
      prevTexts = {}
      for (const v of view.texts) prevTexts[v.id] = { content: v.content, level: v.level }
      return
    }
    for (const v of only) prevTexts[v.id] = { content: v.content, level: v.level }
  }

  async function render(view: View, menu: MenuItem[]): Promise<void> {
    // Geometry is part of the layout signature: a container move is a rebuild,
    // not a text update.
    const layout = view.texts
      .map((v) => `${v.id}:${v.x},${v.y},${v.w},${v.h}`)
      .join('+')
    const sig = [
      layout,
      view.list ? view.list.items.join('\u0001') : '-',
      menu.map((m) => m.name).join('\u0001'),
    ].join('#')

    if (sig === prevSig && prevSig !== null) {
      const changed = view.texts.filter((v) => {
        const p = prevTexts[v.id]
        return !p || p.content !== v.content || p.level !== v.level
      })
      if (changed.length === 0) return

      // A whole-message swap (CHAT: header, body, time line, footer) is one
      // atomic redraw. Four sequential upgrades leave the screen in mixed
      // states for a few frames — that reads as the text jumping.
      if (changed.length >= ATOMIC_REDRAW_MIN) {
        const ok = await sendPage(view, menu, false)
        if (ok) syncTexts(view)
        else console.error('[teleglass] rebuild for a full redraw failed')
        return
      }

      for (const v of changed) {
        const ok = await upgradeText(v)
        if (ok) syncTexts(view, [v])
        else console.error('[teleglass] textContainerUpgrade →', v.id)
      }
      return
    }

    const first = prevSig === null
    const ok = await sendPage(view, menu, first)
    if (!ok) {
      // Nothing was drawn. Forget the signature: the next render must send the
      // page again instead of upgrading containers of a page the host does not
      // have (that left the old screen on the glasses forever).
      prevSig = null
      prevTexts = {}
      return
    }

    if (first) console.log('[teleglass] ready')
    prevSig = sig
    syncTexts(view)
  }

  // The host tells us which menu launched the app; useful in the log and later
  // for routing (docs: device-apis § Launch Source).
  bridge.onLaunchSource((source: LaunchSource) => {
    console.log('[teleglass] launch source:', source)
  })

  return {
    native: true,
    render,
    onEvent(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    exit() {
      // 1 = system exit confirmation dialog (Even Hub QA requirement).
      void bridge.shutDownPageContainer(1)
    },
    async loadLang() {
      try {
        const raw = await bridge.getLocalStorage(LANG_KEY)
        return raw === 'en' || raw === 'ru' ? raw : null
      } catch (err) {
        console.warn('[teleglass] getLocalStorage failed:', err)
        return null
      }
    },
    async saveLang(lang) {
      try {
        await bridge.setLocalStorage(LANG_KEY, lang)
      } catch (err) {
        console.warn('[teleglass] setLocalStorage failed:', err)
      }
    },
    async audio(on, source) {
      audioOn = on
      try {
        await bridge.audioControl(
          on,
          source === 'phone' ? AudioInputSource.Phone : AudioInputSource.Glasses,
        )
      } catch (err) {
        // No permission or no capture on this host: the indicator stays flat.
        console.warn('[teleglass] audioControl failed:', err)
      }
    },
  }
}

/** Storage key shared by both targets: the UI language survives a restart. */
const LANG_KEY = 'teleglass.lang'

/**
 * Level of one PCM chunk (16 kHz, signed 16-bit little-endian, mono — the SDK
 * format for both sources) as 0…1 on a −60…0 dBFS scale. The raw RMS of speech
 * sits far below full scale, so a linear scale would leave the indicator flat;
 * decibels are how loudness is actually perceived.
 */
function levelOf(raw: Uint8Array | number[]): number {
  // The host may pass the buffer as a plain number[] after JSON; the SDK normally
  // hands it over as Uint8Array.
  const pcm = raw instanceof Uint8Array ? raw : Uint8Array.from(raw)
  const samples = Math.floor(pcm.byteLength / 2)
  if (samples === 0) return 0
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2)
  let sum = 0
  for (let i = 0; i < samples; i++) {
    const s = view.getInt16(i * 2, true) / 32768
    sum += s * s
  }
  const rms = Math.sqrt(sum / samples)
  if (rms <= 0) return 0
  const db = 20 * Math.log10(rms)
  return Math.min(1, Math.max(0, (db + 60) / 60))
}

function browserTarget(): GlassesTarget {
  const listeners = new Set<(e: AppEvent) => void>()
  return {
    native: false,
    async render() {
      /* the React preview draws the screen; there are no glasses in a browser */
    },
    onEvent(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    exit() {
      console.log('[teleglass] exit requested: no system Even dialog in the browser')
    },
    async loadLang() {
      const raw = window.localStorage.getItem(LANG_KEY)
      return raw === 'en' || raw === 'ru' ? raw : null
    },
    async saveLang(lang) {
      window.localStorage.setItem(LANG_KEY, lang)
    },
    async audio() {
      /* no glasses microphone outside Even App: the indicator stays flat */
    },
  }
}

/**
 * Official boot path: `waitForEvenAppBridge()` resolves inside the Even App
 * WebView once the host is ready (it waits for the `evenAppBridgeReady` event).
 *
 * The waiting policy differs by host. Inside the Even App the bridge is
 * guaranteed to appear, so we wait for it instead of giving up after a timeout —
 * a cold WebView used to fall into the browser stub, leaving the glasses blank.
 * In a plain browser the bridge never appears, so a short probe is enough.
 */
export async function createTarget(): Promise<GlassesTarget> {
  if (typeof window !== 'undefined') {
    const inEvenApp = 'flutter_inappwebview' in window
    const probe = inEvenApp
      ? waitForEvenAppBridge().catch(() => null)
      : Promise.race([
          waitForEvenAppBridge().catch(() => null),
          new Promise<null>((resolve) => {
            window.setTimeout(() => resolve(null), 800)
          }),
        ])
    const bridge = await probe
    if (bridge) return nativeTarget(bridge)
    if (inEvenApp) console.error('[teleglass] Even App WebView without a bridge')
  }
  return browserTarget()
}
