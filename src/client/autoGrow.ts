/**
 * Content-driven height for the editor's body box (v0.2.1).
 *
 * The body `<textarea>` used to be a fixed six-row box with a manual drag
 * handle: a short note left a mostly empty field on screen, a long one pushed
 * its own last lines out of sight. Since v0.2.1 the box is measured against its
 * content and resized on every edit — it grows line by line while you type or
 * paste, and shrinks back the moment text is deleted — until it reaches the cap,
 * where it stops growing and scrolls internally instead of swallowing the whole
 * panel.
 *
 * Everything here is deliberately DOM-thin and React-free: the functions take a
 * structurally-typed target ({@link GrowTarget}) so the node test project can
 * exercise the clamping arithmetic with a plain object, and the jsdom component
 * test can drive the real `<textarea>`.
 *
 * Two rules are load-bearing:
 *
 * 1. **Reset to `auto` before reading `scrollHeight`.** While a fixed height is
 *    in place a textarea never reports less than its own client height, so a box
 *    that once grew could never shrink again. `height: auto` makes
 *    `scrollHeight` report the content's real height, cap included.
 * 2. **Never collapse below {@link BODY_MIN_HEIGHT}.** Measurement returns `0`
 *    in environments that do not lay the element out (jsdom, or an editor
 *    mounted while its panel is `display: none`); the floor keeps a usable field
 *    instead of a 0px sliver, and the next re-sync corrects it. In a real
 *    browser the floor is also what an empty note renders at, because the
 *    editor sets `rows={1}` — a textarea's `height: auto` is rows-intrinsic, so
 *    a retained `rows={6}` would have silently out-voted this floor and pinned
 *    the empty box at ~134 px.
 *
 * Purity: no `node:*`, no `@deepseek-ai/*` value imports.
 */

/**
 * Smallest body height in px — the empty box. Mirrored by the editor's CSS
 * `min-height`, which is what holds the box open before the first measurement.
 */
export const BODY_MIN_HEIGHT = 120

/** Largest body height, as a share of the viewport height. */
export const BODY_MAX_VIEWPORT_RATIO = 0.6

/** Cap used when the viewport cannot be measured (no `window`, 0 height). */
export const BODY_MAX_FALLBACK = 480

/**
 * The slice of a `<textarea>` this module touches. A real
 * `HTMLTextAreaElement` satisfies it structurally; tests pass plain objects.
 */
export interface GrowTarget {
  style: { height: string; maxHeight: string; overflowY: string }
  scrollHeight: number
  offsetHeight?: number
  clientHeight?: number
}

/** Viewport height in px, or `0` when there is nothing to measure. */
export function viewportHeight(): number {
  if (typeof window === 'undefined') return 0
  const inner = window.innerHeight
  if (typeof inner === 'number' && Number.isFinite(inner) && inner > 0) return inner
  const root = typeof document !== 'undefined' ? document.documentElement : null
  const client = root ? root.clientHeight : 0
  return typeof client === 'number' && Number.isFinite(client) && client > 0 ? client : 0
}

/**
 * The growth ceiling for a viewport of `viewport` px. Relative to the viewport
 * on purpose: the panel is full-height in every tier, so a fixed pixel cap would
 * either crowd a short window or waste a tall one. Never below the floor, so even
 * an absurd viewport still leaves a usable box.
 */
export function bodyMaxHeight(viewport: number): number {
  const scaled = Math.round((Number.isFinite(viewport) ? viewport : 0) * BODY_MAX_VIEWPORT_RATIO)
  if (!Number.isFinite(scaled) || scaled <= 0) return BODY_MAX_FALLBACK
  return Math.max(BODY_MIN_HEIGHT, scaled)
}

/**
 * The vertical border the box adds around its content. `scrollHeight` covers the
 * padding but not the border, while the inline `height` is `border-box`, so
 * without this the last line would sit 2px under the edge and flicker a
 * scrollbar. Derived from the element itself (no `getComputedStyle` call, which
 * would also force a style recalc on every keystroke).
 */
function verticalBorder(target: GrowTarget): number {
  const offset = target.offsetHeight ?? 0
  const client = target.clientHeight ?? 0
  const diff = offset - client
  return Number.isFinite(diff) && diff > 0 ? diff : 0
}

/**
 * Size `target` to its content and report the height that was applied (px), or
 * `null` when there is no element to size.
 *
 * Idempotent: calling it twice with unchanged content applies the same height,
 * which is what lets the `ResizeObserver` path re-sync without looping. `max`
 * defaults to {@link bodyMaxHeight} of the current viewport, falling back to the
 * fixed cap when there is no viewport to measure.
 */
export function applyBodyHeight(
  target: GrowTarget | null | undefined,
  max: number = bodyMaxHeight(viewportHeight()),
): number | null {
  if (!target || !target.style) return null
  const ceiling = Math.max(
    BODY_MIN_HEIGHT,
    Math.round(Number.isFinite(max) ? max : BODY_MAX_FALLBACK),
  )

  // Rule 1: measure against `auto`, never against the height we last applied.
  target.style.height = 'auto'
  const raw = Number.isFinite(target.scrollHeight) ? target.scrollHeight : 0
  const wanted = raw > 0 ? Math.ceil(raw + verticalBorder(target)) : BODY_MIN_HEIGHT
  const next = Math.min(ceiling, Math.max(BODY_MIN_HEIGHT, wanted))

  target.style.maxHeight = `${ceiling}px`
  // Past the cap the box stops growing and scrolls its own content instead.
  target.style.overflowY = wanted > ceiling ? 'auto' : 'hidden'
  target.style.height = `${next}px`
  return next
}
