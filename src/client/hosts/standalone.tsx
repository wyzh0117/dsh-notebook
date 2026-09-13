/**
 * tier 3 — the self-drawn right sidebar (no sidebar product installed at all).
 *
 * Visual fidelity is the point of this file: every number below is copied from
 * dsh-better-sidebar 0.12.1 (`src/client/Sidebar.tsx`, `state.ts`,
 * `breakpoints.ts`, `layout.css`, `sidebar.module.css`) rather than invented.
 *
 *   toggleCluster  fixed at the viewport's top-right corner, one 28×28 circle
 *                  button, `IconPanelRightOutline16`, 500 ms tooltip delay
 *   panel          right edge, full height, stays MOUNTED while collapsed and
 *                  slides out (`translateX(102%)`), `visibility: hidden` only
 *                  after the slide settles
 *   width          280 / 640 / 400, left-edge drag strip, `100vw` drawer below
 *                  768 px (no drag strip there)
 *   persistence    localStorage `dsh-notebook:open` / `dsh-notebook:width`
 *
 * Two deliberate deviations from better-sidebar, both required by the spec:
 * - inline style objects instead of CSS modules (spec §2.5 "样式隔离"), plus the
 *   one sanctioned `<style data-dsh-notebook>` carrying only the *layout push*
 *   rules, namespaced to `#root` / the session header / our own nodes and
 *   removed on dispose;
 * - CSS variables and body attributes named `--dsh-notebook-*` /
 *   `data-dsh-notebook-*` so nothing can collide with the other plugin.
 */
import {
  createElement,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { NotebookSettingsPanel } from '../NotebookSettingsPanel'
import { NotebookView } from '../NotebookView'
import { NotebookGlyph, PanelRightOutline16 } from '../icons'
import { t } from '../locales'
import { disposeOf } from './detect'
import type { ClientContext, NotebookHost, NotebookRuntime } from './types'

/** Panel geometry contract (mirrors better-sidebar's `PANEL_MIN/MAX/DEFAULT`). */
export const PANEL_MIN = 280
export const PANEL_MAX = 640
export const PANEL_DEFAULT = 400

/** Viewport widths strictly below this are "narrow" (better-sidebar's `NARROW_MAX_WIDTH`). */
export const NARROW_MAX_WIDTH = 768

/** Theme-driven motion, with literal fallbacks so a missing variable still animates. */
const DURATION = 'var(--ds-transition-duration-slow, 200ms)'
const EASE = 'var(--ds-ease-in-out, ease-in-out)'

const OPEN_KEY = 'dsh-notebook:open'
const WIDTH_KEY = 'dsh-notebook:width'
const STYLE_MARKER = 'data-dsh-notebook-layout'

/** Clamp a panel width into the contract (better-sidebar's `clampWidth`). */
export function clampPanelWidth(width: number): number {
  const rounded = Number.isFinite(width) ? Math.round(width) : PANEL_DEFAULT
  return Math.min(PANEL_MAX, Math.max(PANEL_MIN, rounded))
}

function readBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? fallback : raw === '1'
  } catch {
    return fallback
  }
}

function writeBoolean(key: string, value: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // private mode / quota: persistence is a convenience, never a requirement
  }
}

function readStoredWidth(): number {
  if (typeof window === 'undefined') return PANEL_DEFAULT
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY)
    if (raw === null) return PANEL_DEFAULT
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? clampPanelWidth(parsed) : PANEL_DEFAULT
  } catch {
    return PANEL_DEFAULT
  }
}

function writeStoredWidth(width: number): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(WIDTH_KEY, String(width))
  } catch {
    // see writeBoolean
  }
}

/**
 * The layout-push stylesheet — the ONLY `<style>` tag this plugin is allowed to
 * add (spec/brief §tier 3). It speaks exclusively about `#root`, the DSH session
 * header (through its `data-slot` host, like better-sidebar's `layout.css`), and
 * our own `[data-dsh-notebook]` subtree.
 */
const LAYOUT_CSS = `
#root {
  margin-right: var(--dsh-notebook-width, 0px);
  transition: margin-right ${DURATION} ${EASE};
}
body[data-dsh-notebook-collapsed] [data-slot="conversation.session.header"] > header {
  padding-right: 78px;
}
body[data-dsh-notebook-dragging] #root {
  transition: none;
}
[data-dsh-notebook] button:focus-visible {
  outline: 2px solid var(--dsw-alias-border-focus, currentColor);
  outline-offset: 1px;
}
@media (prefers-reduced-motion: reduce) {
  #root {
    transition: none;
  }
}
`

/** Inject the layout-push stylesheet; the returned disposer removes it again. */
export function injectLayoutStyle(): () => void {
  if (typeof document === 'undefined' || document.head === null) return () => {}
  const style = document.createElement('style')
  style.setAttribute(STYLE_MARKER, '')
  style.textContent = LAYOUT_CSS
  document.head.appendChild(style)
  let removed = false
  return () => {
    if (removed) return
    removed = true
    try {
      style.remove()
    } catch {
      // already detached
    }
  }
}

/** Publish the layout push (CSS variable + body attributes) that the stylesheet consumes. */
function syncLayoutVars(open: boolean, width: number, narrow: boolean, dragging: boolean): void {
  if (typeof document === 'undefined') return
  const pushes = open && !narrow
  try {
    document.documentElement.style.setProperty('--dsh-notebook-width', pushes ? `${width}px` : '0px')
  } catch {
    // detached document
  }
  const body = document.body
  if (body === null || body === undefined) return
  if (open) body.removeAttribute('data-dsh-notebook-collapsed')
  else body.setAttribute('data-dsh-notebook-collapsed', '')
  if (dragging) body.setAttribute('data-dsh-notebook-dragging', '')
  else body.removeAttribute('data-dsh-notebook-dragging')
}

/** Undo every layout side effect (plugin unload / HMR). */
function resetLayoutVars(): void {
  if (typeof document === 'undefined') return
  try {
    document.documentElement.style.setProperty('--dsh-notebook-width', '0px')
  } catch {
    // detached document
  }
  const body = document.body
  if (body === null || body === undefined) return
  body.removeAttribute('data-dsh-notebook-collapsed')
  body.removeAttribute('data-dsh-notebook-dragging')
}

/**
 * The shell's open/closed state lives OUTSIDE React so `NotebookHost.reveal()`
 * can reach it (the user-activation path), while React reads it through
 * `useSyncExternalStore`.
 */
interface PanelControl {
  isOpen(): boolean
  setOpen(next: boolean): void
  subscribe(listener: () => void): () => void
}

function createPanelControl(initialOpen: boolean): PanelControl {
  let open = initialOpen
  const listeners = new Set<() => void>()
  return {
    isOpen: () => open,
    setOpen(next: boolean) {
      if (open === next) return
      open = next
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** Live narrow-viewport flag (better-sidebar's `useNarrowViewport`). */
function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < NARROW_MAX_WIDTH,
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const measure = (): void => setNarrow(window.innerWidth < NARROW_MAX_WIDTH)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  return narrow
}

/** Honour `prefers-reduced-motion` (matchMedia is optional — jsdom omits it). */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    let query: MediaQueryList
    try {
      query = window.matchMedia('(prefers-reduced-motion: reduce)')
    } catch {
      return
    }
    setReduced(query.matches)
    const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches)
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange)
      return () => query.removeEventListener('change', onChange)
    }
    const legacy = query as unknown as {
      addListener?: (cb: (event: MediaQueryListEvent) => void) => void
      removeListener?: (cb: (event: MediaQueryListEvent) => void) => void
    }
    legacy.addListener?.(onChange)
    return () => legacy.removeListener?.(onChange)
  }, [])
  return reduced
}

const ICON_BUTTON_BASE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  padding: 0,
  border: 'none',
  borderRadius: '50%',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, #6b7280)',
  cursor: 'pointer',
  flex: '0 0 auto',
}

const ICON_BUTTON_HOVER: CSSProperties = {
  background: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))',
  color: 'var(--dsw-alias-label-primary, #1f2328)',
}

/** A 28 px icon button with a ~500 ms delayed tooltip (better-sidebar's Tooltip delay). */
function ToggleButton(props: {
  label: string
  onToggle: () => void
  /** Passed as `createElement`'s third argument, hence optional here. */
  children?: ReactNode
}): ReactNode {
  const [hovered, setHovered] = useState(false)
  const [tipVisible, setTipVisible] = useState(false)

  useEffect(() => {
    if (!hovered) {
      setTipVisible(false)
      return
    }
    const handle = window.setTimeout(() => setTipVisible(true), 500)
    return () => window.clearTimeout(handle)
  }, [hovered])

  return createElement(
    'div',
    { style: { position: 'relative', display: 'flex' } },
    createElement(
      'button',
      {
        type: 'button',
        'aria-label': props.label,
        'data-dsh-notebook': 'toggle-button',
        onClick: props.onToggle,
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
        onFocus: () => setHovered(true),
        onBlur: () => setHovered(false),
        style: hovered ? { ...ICON_BUTTON_BASE, ...ICON_BUTTON_HOVER } : ICON_BUTTON_BASE,
      },
      props.children,
    ),
    tipVisible
      ? createElement(
          'div',
          {
            role: 'tooltip',
            'data-dsh-notebook': 'tooltip',
            style: {
              position: 'absolute',
              top: '100%',
              right: 0,
              marginTop: 6,
              padding: '4px 8px',
              borderRadius: 6,
              fontSize: 12,
              lineHeight: '16px',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              background: 'var(--dsw-alias-bg-layer-2, #1d1e23)',
              color: 'var(--dsw-alias-label-primary, #e6e6e6)',
              boxShadow: 'var(--dsw-shadow-lv2, 0 4px 12px rgba(0, 0, 0, 0.25))',
            },
          },
          props.label,
        )
      : null,
  )
}

/**
 * The tier-3 shell: the fixed toggle cluster plus the sliding panel. Registered
 * into `shell.overlay` (a click-through, root-scoped list slot), so the wrapper
 * is `pointer-events: none` and only real controls opt back in.
 */
function createShellComponent(runtime: NotebookRuntime, control: PanelControl): () => ReactNode {
  return function NotebookShell(): ReactNode {
    const open = useSyncExternalStore(control.subscribe, control.isOpen)
    const [width, setWidth] = useState<number>(() => readStoredWidth())
    const [dragging, setDragging] = useState(false)
    const narrow = useNarrowViewport()
    const reducedMotion = usePrefersReducedMotion()
    const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
    const prefs = useSyncExternalStore(runtime.subscribe, runtime.getPrefs)

    // Layout push: the shell occupies space instead of floating over the app.
    useEffect(() => {
      syncLayoutVars(open, width, narrow, dragging)
    }, [open, width, narrow, dragging])

    useEffect(() => {
      writeBoolean(OPEN_KEY, open)
    }, [open])

    useEffect(() => {
      if (!dragging) writeStoredWidth(width)
    }, [dragging, width])

    // Plugin unload must give the layout back.
    useEffect(
      () => () => {
        resetLayoutVars()
      },
      [],
    )

    const toggleOpen = (): void => control.setOpen(!open)

    const beginDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
      event.preventDefault()
      dragRef.current = { startX: event.clientX, startWidth: width }
      setDragging(true)
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // jsdom / unsupported pointer capture: the drag still tracks.
      }
    }

    const moveDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
      const drag = dragRef.current
      if (drag === null) return
      try {
        if (
          typeof event.currentTarget.hasPointerCapture === 'function' &&
          !event.currentTarget.hasPointerCapture(event.pointerId)
        ) {
          return
        }
      } catch {
        // see beginDrag
      }
      setWidth(clampPanelWidth(drag.startWidth + (drag.startX - event.clientX)))
    }

    const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (dragRef.current === null) return
      dragRef.current = null
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        // see beginDrag
      }
      setDragging(false)
    }

    const transition = dragging || reducedMotion
      ? 'none'
      : open
        ? `transform ${DURATION} ${EASE}, width ${DURATION} ${EASE}`
        : `transform ${DURATION} ${EASE}, width ${DURATION} ${EASE}, visibility 0s linear ${DURATION}`

    const panelStyle: CSSProperties = {
      position: 'fixed',
      top: 0,
      right: 0,
      bottom: 0,
      zIndex: 1,
      display: 'flex',
      flexDirection: 'column',
      width: narrow ? '100vw' : width,
      background: 'var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-1, #ffffff))',
      borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2))',
      pointerEvents: open ? 'auto' : 'none',
      transform: open ? 'translateX(0)' : 'translateX(102%)',
      visibility: open ? 'visible' : 'hidden',
      transition,
    }

    const headerStyle: CSSProperties = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      height: 40,
      flex: '0 0 auto',
      padding: '0 6px 0 12px',
      borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2))',
    }

    return createElement(
      'div',
      {
        'data-dsh-notebook': 'shell',
        style: {
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          zIndex: 40,
          // shell.overlay is a click-through layer: nothing here may eat a click
          // except the controls that re-enable pointer events themselves.
          pointerEvents: 'none',
        },
      },

      // The toggle cluster: pinned to the viewport's top-right corner, so it sits
      // inside the panel's own corner while the panel is open (better-sidebar
      // `Sidebar.tsx:713-737`).
      createElement(
        'div',
        {
          'data-dsh-notebook': 'toggle-cluster',
          style: {
            position: 'fixed',
            top: 10,
            right: 10,
            zIndex: 2,
            display: 'flex',
            flexDirection: 'row',
            gap: 4,
            pointerEvents: 'auto',
          },
        },
        createElement(
          ToggleButton,
          { label: open ? t('collapse') : t('expand'), onToggle: toggleOpen },
          createElement(PanelRightOutline16, {}),
        ),
      ),

      // The panel stays mounted while collapsed so the slide can animate.
      createElement(
        'div',
        {
          'data-dsh-notebook': 'panel',
          'data-dragging': dragging ? '' : undefined,
          'aria-hidden': open ? undefined : true,
          style: panelStyle,
        },

        // Left-edge width drag strip (absent on narrow viewports — a full-width
        // sheet has nothing to drag).
        !narrow &&
          createElement('div', {
            'data-dsh-notebook': 'resize',
            role: 'separator',
            'aria-orientation': 'vertical',
            'aria-label': t('resize'),
            onPointerDown: beginDrag,
            onPointerMove: moveDrag,
            onPointerUp: endDrag,
            onPointerCancel: endDrag,
            style: {
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: 6,
              zIndex: 2,
              cursor: 'col-resize',
              touchAction: 'none',
              pointerEvents: 'auto',
              background: dragging
                ? 'var(--dsw-alias-interactive-bg-hover-accent, rgba(64, 128, 255, 0.35))'
                : 'transparent',
            },
          }),

        createElement(
          'header',
          { 'data-dsh-notebook': 'header', style: headerStyle },
          createElement(
            'span',
            {
              'data-dsh-notebook': 'glyph',
              style: {
                display: 'flex',
                alignItems: 'center',
                color: 'var(--dsw-alias-label-primary, #1f2328)',
              },
            },
            createElement(NotebookGlyph, { size: 16 }),
          ),
          createElement(
            'span',
            {
              'data-dsh-notebook': 'title',
              style: {
                flex: '1 1 auto',
                minWidth: 0,
                fontSize: 13,
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: 'var(--dsw-alias-label-primary, #1f2328)',
              },
            },
            t('title'),
          ),
          createElement(
            ToggleButton,
            { label: t('collapse'), onToggle: () => control.setOpen(false) },
            createElement(PanelRightOutline16, {}),
          ),
        ),

        createElement(
          'div',
          {
            'data-dsh-notebook': 'body',
            style: {
              flex: '1 1 auto',
              minHeight: 0,
              display: 'flex',
              position: 'relative',
            },
          },
          createElement(NotebookView, {
            api: runtime.api,
            prefs,
            onPrefsChange: (patch) => runtime.setPrefs(patch),
            visible: open,
            onRequestClose: () => control.setOpen(false),
          }),
        ),
      ),
    )
  }
}

/** The tier-3 settings seat: DSH 0.1.1-rc.2's only usable plugin settings slot. */
function createSettingsSection(runtime: NotebookRuntime): () => ReactNode {
  return function NotebookSettingsSection(): ReactNode {
    const prefs = useSyncExternalStore(runtime.subscribe, runtime.getPrefs)
    return createElement(
      'div',
      {
        'data-dsh-notebook': 'settings',
        style: { display: 'flex', flexDirection: 'column', padding: '4px 0 12px' },
      },
      createElement(NotebookSettingsPanel, {
        prefs,
        onChange: (patch) => runtime.setPrefs(patch),
      }),
    )
  }
}

export function createStandaloneHost(ctx: ClientContext): NotebookHost {
  const control = createPanelControl(readBoolean(OPEN_KEY, false))

  return {
    tier: 'standalone',

    register(runtime: NotebookRuntime): () => void {
      const disposers: Array<() => void> = [injectLayoutStyle()]

      // The shell is a React component registered into `shell.overlay` — DSH
      // renders it, so no separate createRoot/portal is created here.
      disposers.push(
        disposeOf(
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              { name: 'shell.overlay', id: 'dsh-notebook-shell', order: 5 },
              createShellComponent(runtime, control),
            ),
          ),
        ),
      )

      // An undeclared `settings.section` slot means this callback never runs —
      // a safe no-op, never an error (DSH 0.1.1-rc.2 declares it; see
      // dsh-screenshot's bundle for the same call).
      disposers.push(
        disposeOf(
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'dsh-notebook',
                order: 100,
                label: () => t('settingsSection'),
              },
              createSettingsSection(runtime),
            ),
          ),
        ),
      )

      let released = false
      return () => {
        if (released) return
        released = true
        resetLayoutVars()
        for (const off of disposers.reverse()) {
          try {
            off()
          } catch (error) {
            console.warn('[dsh-notebook] standalone dispose failed:', error)
          }
        }
      }
    },

    reveal(): void {
      control.setOpen(true)
    },
  }
}
