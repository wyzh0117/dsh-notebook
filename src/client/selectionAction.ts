/**
 * Select-to-notebook (v0.2.0): the DOM half of the feature, with no React and
 * no DSH services in it.
 *
 * The contract is deliberately narrow — "is there a selection worth saving, and
 * where is it on screen?" — because everything else (the note write, the title
 * numbering, the toast) already lives in `capture.ts` and is shared with the
 * answer action.
 *
 * Selection policy, in the order the checks run:
 *
 * 1. a selection must be non-collapsed and hold something besides whitespace;
 * 2. a selection inside an editable control (the composer's `textarea`, an
 *    `input`, a `contenteditable`) is NOT ours — that text is on its way into a
 *    prompt, not into the notebook;
 * 3. a selection inside our own UI (`[data-dsh-notebook]`) is NOT ours;
 * 4. a selection outside the conversation scope is NOT ours — but only when the
 *    scope element actually exists in the document. DSH's DOM is not a public
 *    contract, so a shell that renames its slots must degrade to "any selection
 *    outside the composer" rather than to a feature that silently never fires
 *    (see {@link resolveScopeElement}).
 *
 * Purity: no `node:*`, no `@deepseek-ai/*` value imports.
 */

/**
 * Conversation containers this feature treats as "the session", most specific
 * first.
 *
 * These are the shell's own semantic DOM hooks, verified against DSH
 * 0.1.5-rc.2: `[data-chat-flow]` is the transcript message column
 * (`dsh-client-ui-chat`), `[data-conversation-scroll]` the scroll body that
 * wraps session + composer (`dsh-client-ui-conversation`), and `[data-slot=…]`
 * is stamped on **every** slot outlet by the renderer. The per-package CSS
 * module class names are content-hashed and deliberately NOT used.
 */
export const CONVERSATION_SCOPE_SELECTORS: readonly string[] = [
  '[data-chat-flow]',
  '[data-conversation-scroll]',
  '[data-slot="conversation.view"]',
  '[data-slot="conversation"]',
]

/** Marker attribute of every node this plugin draws itself. */
export const OWN_SUBTREE_SELECTOR = '[data-dsh-notebook]'

/**
 * Editable hosts / regions whose selections are never captured: the composer's
 * own DOM hooks, plus the generic editable controls. Selecting a prompt draft
 * is not a request to file it in the notebook.
 */
const EDITABLE_SELECTOR = [
  'input',
  'textarea',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[data-composer-card]',
  '[data-composer-input]',
  '[data-lexical-editor="true"]',
].join(', ')

/** Smallest selection (in characters, after trimming) worth offering to save. */
export const MIN_SELECTION_CHARS = 1

/** Where the floating action sits relative to the selection. */
export interface SelectionRect {
  top: number
  left: number
  right: number
  bottom: number
  width: number
  height: number
}

/** One capturable selection: its text plus its viewport-space geometry. */
export interface SelectionCandidate {
  text: string
  rect: SelectionRect
}

/** Read/write face of the tracker (the React overlay consumes it). */
export interface SelectionTracker {
  /** Stable-identity snapshot for `useSyncExternalStore` (null = nothing to offer). */
  getSnapshot(): SelectionCandidate | null
  subscribe(listener: () => void): () => void
  /** Re-read the selection now (the listeners do this on every event). */
  refresh(): void
  /** Drop the current candidate (after a save, or when the user dismisses it). */
  clear(): void
  /** Remove every listener. */
  dispose(): void
}

/** The `window`/`document` pair the watcher uses (injectable for tests). */
export interface SelectionEnvironment {
  win: Window
  doc: Document
}

/** Options for {@link createSelectionTracker}. */
export interface SelectionTrackerOptions {
  /** Override the environment (tests pass `window` / `document` explicitly). */
  env?: SelectionEnvironment
  /** Scope selectors, most specific first; defaults to {@link CONVERSATION_SCOPE_SELECTORS}. */
  scopeSelectors?: readonly string[]
  /** Extra predicate: return false to refuse a candidate outright. */
  accept?: (candidate: SelectionCandidate) => boolean
  /** Geometry source; defaults to the range's own client rects. */
  measure?: (range: Range) => SelectionRect | null
}

function isElement(node: unknown): node is Element {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as { nodeType?: unknown }).nodeType === 1 &&
    typeof (node as { closest?: unknown }).closest === 'function'
  )
}

/** The element a selection endpoint lives in (text nodes climb to their parent). */
function elementOf(node: Node | null | undefined): Element | null {
  if (node === null || node === undefined) return null
  if (isElement(node)) return node
  const parent = (node as { parentElement?: Element | null }).parentElement ?? null
  return isElement(parent) ? parent : null
}

/** True when `node` sits inside an editable control. */
export function isInsideEditable(node: Node | null | undefined): boolean {
  const element = elementOf(node)
  if (element === null) return false
  try {
    return element.closest(EDITABLE_SELECTOR) !== null
  } catch {
    return false
  }
}

/** True when `node` sits inside a subtree this plugin drew. */
export function isInsideOwnUi(node: Node | null | undefined): boolean {
  const element = elementOf(node)
  if (element === null) return false
  try {
    return element.closest(OWN_SUBTREE_SELECTOR) !== null
  } catch {
    return false
  }
}

/**
 * The element that bounds "the session", or `null` when this document has none
 * of the known containers.
 *
 * Returning `null` is the version-skew signal: the caller then accepts a
 * selection anywhere outside the composer and our own UI, which keeps the
 * feature working on a shell whose slot names we do not know.
 */
export function resolveScopeElement(
  doc: Document,
  selectors: readonly string[] = CONVERSATION_SCOPE_SELECTORS,
): Element | null {
  for (const selector of selectors) {
    try {
      const found = doc.querySelector(selector)
      if (found !== null) return found
    } catch {
      // An invalid selector in a caller-supplied list is skipped, not fatal.
    }
  }
  return null
}

/**
 * Last client rect of a range (multi-line selections: the tail is what matters).
 *
 * This is the ONE browser-only measurement in the module, and it is also the
 * one jsdom cannot answer at all (`Range.getBoundingClientRect` does not exist
 * there), so {@link SelectionTrackerOptions.measure} can replace it.
 */
function rectOfRange(range: Range): SelectionRect | null {
  let raw: { top: number; left: number; right: number; bottom: number; width: number; height: number } | null = null
  try {
    const rects = typeof range.getClientRects === 'function' ? range.getClientRects() : null
    if (rects !== null && rects.length > 0) raw = rects[rects.length - 1] ?? null
  } catch {
    raw = null
  }
  if (raw === null) {
    try {
      if (typeof range.getBoundingClientRect !== 'function') return null
      const single = range.getBoundingClientRect()
      if (single.width === 0 && single.height === 0) return null
      raw = single
    } catch {
      return null
    }
  }
  if (raw === null) return null
  return { top: raw.top, left: raw.left, right: raw.right, bottom: raw.bottom, width: raw.width, height: raw.height }
}

/** Options accepted by {@link readSelection}. */
export interface ReadSelectionOptions {
  /** The session container, or `null` to accept any non-excluded selection. */
  scope?: Element | null
  /** Extra predicate: return false to refuse a candidate outright. */
  accept?: (candidate: SelectionCandidate) => boolean
  /** Geometry source; defaults to the range's own client rects. */
  measure?: (range: Range) => SelectionRect | null
}

/**
 * Read the current selection as a capture candidate, or `null` when there is
 * nothing this feature should offer to save.
 */
export function readSelection(
  env: SelectionEnvironment,
  options?: ReadSelectionOptions,
): SelectionCandidate | null {
  const selection = env.win.getSelection?.()
  if (selection === null || selection === undefined) return null
  if (selection.isCollapsed === true || selection.rangeCount === 0) return null

  const text = typeof selection.toString === 'function' ? selection.toString() : ''
  if (text.trim().length < MIN_SELECTION_CHARS) return null

  if (isInsideEditable(selection.anchorNode) || isInsideEditable(selection.focusNode)) return null
  if (isInsideOwnUi(selection.anchorNode) || isInsideOwnUi(selection.focusNode)) return null

  const range = selection.getRangeAt(selection.rangeCount - 1)
  const scope = options?.scope ?? null
  if (scope !== null) {
    const container = elementOf(range.commonAncestorContainer) ?? elementOf(selection.anchorNode)
    if (container === null || !scope.contains(container)) return null
  }

  const rect = (options?.measure ?? rectOfRange)(range)
  if (rect === null) return null

  const candidate: SelectionCandidate = { text, rect }
  if (options?.accept !== undefined && !options.accept(candidate)) return null
  return candidate
}

/** Two candidates are the same offer (text + geometry) — the snapshot guard. */
function sameCandidate(a: SelectionCandidate | null, b: SelectionCandidate | null): boolean {
  if (a === null || b === null) return a === b
  if (a.text !== b.text) return false
  const x = a.rect
  const y = b.rect
  return x.top === y.top && x.left === y.left && x.right === y.right && x.bottom === y.bottom
}

/**
 * The DOM environment to watch, or `null` when this runtime has none.
 *
 * A null result is a normal state, not an error: the client half also loads in
 * DOM-less harnesses (the plugin's own non-browser test project applies it with
 * a fake context), and `apply()` may never throw. The tracker returned in that
 * case is inert — see {@link inertTracker}.
 *
 * An INJECTED environment is validated too. The seam exists for tests and for
 * exotic embedders, and a half-built environment must produce an inert tracker
 * rather than a throw from deep inside the listener wiring.
 */
function resolveEnvironment(explicit?: SelectionEnvironment): SelectionEnvironment | null {
  const candidate =
    explicit ??
    ({
      win: (globalThis as { window?: Window }).window,
      doc: (globalThis as { document?: Document }).document,
    } as SelectionEnvironment)
  const win = candidate.win as Window | undefined
  const doc = candidate.doc as Document | undefined
  if (win === undefined || win === null || doc === undefined || doc === null) return null
  if (typeof doc.addEventListener !== 'function' || typeof doc.removeEventListener !== 'function') return null
  if (typeof win.getSelection !== 'function' || typeof win.addEventListener !== 'function') return null
  return { win, doc }
}

/** A tracker that watches nothing (no DOM in this runtime). */
function inertTracker(): SelectionTracker {
  return {
    getSnapshot: () => null,
    subscribe: () => () => {},
    refresh: () => {},
    clear: () => {},
    dispose: () => {},
  }
}

/**
 * Watch the document and publish the current capturable selection.
 *
 * Events: `selectionchange` (the primary signal, fires while dragging too),
 * `mouseup` / `keyup` (a re-read after the gesture settles — some engines
 * coalesce `selectionchange`), `scroll` (capture phase, so the panel's own
 * scrollers count) and `resize`, both of which only re-measure the existing
 * candidate so the action follows the text instead of drifting.
 */
export function createSelectionTracker(options: SelectionTrackerOptions = {}): SelectionTracker {
  const env = resolveEnvironment(options.env)
  if (env === null) return inertTracker()
  const scopeSelectors = options.scopeSelectors ?? CONVERSATION_SCOPE_SELECTORS

  const listeners = new Set<() => void>()
  let snapshot: SelectionCandidate | null = null
  let disposed = false
  /** Set by {@link clear}: suppress the candidate until the selection changes. */
  let suppressedText: string | null = null
  /**
   * Cached scope element. `undefined` = not resolved yet.
   *
   * `selectionchange` fires continuously while the user drags, so the scope is
   * looked up once and then only re-resolved when the cached element is gone
   * (the conversation remounted, the session changed) or when there was none —
   * a page that later mounts a conversation must stop being "unscoped".
   */
  let cachedScope: Element | null | undefined

  const publish = (next: SelectionCandidate | null): void => {
    if (sameCandidate(snapshot, next)) return
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  const scopeElement = (): Element | null => {
    if (cachedScope !== undefined && cachedScope !== null && cachedScope.isConnected) return cachedScope
    cachedScope = resolveScopeElement(env.doc, scopeSelectors)
    return cachedScope
  }

  const read = (): SelectionCandidate | null => {
    const candidate = readSelection(env, {
      scope: scopeElement(),
      ...(options.accept === undefined ? {} : { accept: options.accept }),
      ...(options.measure === undefined ? {} : { measure: options.measure }),
    })
    // `clear()` hides the offer for the selection it was dismissed on; a new
    // selection (different text) offers again.
    if (candidate !== null && suppressedText !== null && candidate.text === suppressedText) return null
    return candidate
  }

  const refresh = (): void => {
    if (disposed) return
    try {
      publish(read())
    } catch (error) {
      // A DOM that refuses the read (detached document, exotic selection) is
      // simply "nothing to offer"; the feature must never break the page.
      console.warn('[dsh-notebook] reading the text selection failed:', error)
      publish(null)
    }
  }

  /** The raw selection object, or `null` when the DOM will not give us one. */
  const rawSelection = (): Selection | null => {
    try {
      return env.win.getSelection?.() ?? null
    } catch {
      return null
    }
  }

  const onSelectionChange = (): void => {
    // The suppression is dropped ONLY when the gesture actually cleared the
    // selection. Dropping it on every `selectionchange` would re-offer the text
    // that was just filed: the transcript re-emits the event while it streams
    // (and on any DOM mutation inside the selected region), so the button would
    // pop straight back over the note the user just saved, and a second click
    // would file a duplicate.
    if (suppressedText !== null) {
      const selection = rawSelection()
      if (selection === null || selection.isCollapsed === true || selection.rangeCount === 0) {
        suppressedText = null
      }
    }
    refresh()
  }

  env.doc.addEventListener('selectionchange', onSelectionChange)
  env.doc.addEventListener('mouseup', refresh)
  env.doc.addEventListener('keyup', refresh)
  env.win.addEventListener('resize', refresh)
  // Capture phase: the conversation scrolls inside its own container, so a
  // bubbling listener on the document would never see it.
  env.doc.addEventListener('scroll', refresh, true)

  refresh()

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh,
    clear(): void {
      suppressedText = snapshot?.text ?? null
      publish(null)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      env.doc.removeEventListener('selectionchange', onSelectionChange)
      env.doc.removeEventListener('mouseup', refresh)
      env.doc.removeEventListener('keyup', refresh)
      env.win.removeEventListener('resize', refresh)
      env.doc.removeEventListener('scroll', refresh, true)
      listeners.clear()
      // Release the offer without notifying: dispose runs while the surface is
      // being torn down, and a stale snapshot read afterwards must not report a
      // selection nobody is watching any more.
      snapshot = null
      suppressedText = null
    },
  }
}

/**
 * Where to place the floating action for `rect` inside a `viewport`-sized box.
 *
 * Vertical: above the selection when it starts far enough down the screen,
 * below it otherwise — so the action never covers the text it belongs to and
 * never leaves the viewport. Horizontal: the selection's centre, which the
 * button centres itself on with `translateX(-50%)` (so its real width — which
 * depends on the locale — never has to be measured); the clamp uses
 * {@link ACTION_HALF_WIDTH} as a conservative half-width for narrow selections
 * near an edge.
 */
export const ACTION_HALF_WIDTH = 60

/** Height of the floating action, in px (fixed: it is a single-line pill). */
export const ACTION_HEIGHT = 28

export function placeAction(
  rect: SelectionRect,
  viewport: { width: number; height: number },
): { top: number; centerX: number } {
  const gap = 8
  const maxTop = viewport.height - ACTION_HEIGHT - 4
  // Both branches are clamped to the viewport: the tracker re-measures while
  // the user scrolls, so a selection can sit entirely BELOW the bottom edge
  // (scrolling up with a live selection), and "above" would then place the
  // action off-screen where it can never be clicked.
  const above = Math.min(maxTop, rect.top - gap - ACTION_HEIGHT)
  const below = Math.min(maxTop, rect.bottom + gap)
  const top = above >= 4 ? above : below
  const centre = rect.left + (rect.right - rect.left) / 2
  const min = ACTION_HALF_WIDTH + 4
  const max = viewport.width - ACTION_HALF_WIDTH - 4
  return { top: Math.max(4, top), centerX: max < min ? min : Math.max(min, Math.min(max, centre)) }
}
