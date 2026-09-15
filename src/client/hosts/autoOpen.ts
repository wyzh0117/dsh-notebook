/**
 * "Open the notebook for a new session" (native right sidebar only).
 *
 * The right sidebar keeps one surface **per session**: a session starts
 * collapsed and empty, so a freshly created one shows no Notebook tab until the
 * user expands the panel and picks it. This watcher closes that gap without
 * ever fighting the user:
 *
 * - it reacts to a session BECOMING current (a new session, or a switch to
 *   another one), never to page load — the session that is already current when
 *   the plugin activates is recorded as seen and left alone;
 * - it opens once per change (a re-published snapshot of the same session is
 *   not a new session), and only while `prefs.autoOpenOnNewSession` is on (off
 *   by default, so the panel never appears uninvited);
 * - every carrier can use it: the native right sidebar and a compatible sidebar
 *   service open their Notebook tab, while the standalone tier opens its own
 *   panel — the gesture is a callback ({@link attachSessionAutoOpen});
 * - `openTab` both opens the tab and expands the panel, but it throws while the
 *   session's sidebar surface is not mounted yet (the navigation controller
 *   refuses to write into a surface nobody draws), so the open is retried with
 *   a short backoff and abandoned the moment the session changes again.
 *
 * Everything is resolved through duck-typed services, so a composition without
 * `ctx.sessions` (or without the sidebar controller) is a silent no-op.
 *
 * Purity: no `node:*`, no `@deepseek-ai/*` value imports.
 */
import { disposeOf, lookupService } from './detect'
import type { ClientContext, NotebookRuntime, SidebarRightLike } from './types'

/** Delay before the first retry; the surface mounts a tick after the switch. */
export const AUTO_OPEN_RETRY_MS: readonly number[] = [0, 200, 500, 1200, 2500]

/** `ctx.sessions` — the list face the watcher subscribes to. */
export interface SessionsLike {
  list?: {
    getSnapshot?(): { current?: unknown }
    subscribe?(listener: () => void): unknown
  }
}

export interface AutoOpenOptions {
  ctx: ClientContext
  runtime: NotebookRuntime
  /** Open the Notebook tab (returns false when the surface is not mounted yet). */
  open: () => boolean
  /** Retry schedule; overridable for tests. */
  retryDelaysMs?: readonly number[]
}

export interface AutoOpenWatcher {
  /** The session id the watcher currently considers current (null before the first read). */
  readonly currentSessionId: string | null
  dispose(): void
}

function currentOf(sessions: SessionsLike | undefined): string | null {
  try {
    const snapshot = sessions?.list?.getSnapshot?.()
    const current = snapshot?.current
    return typeof current === 'string' && current.length > 0 ? current : null
  } catch {
    return null
  }
}

/**
 * Start watching session changes.
 *
 * @returns the watcher (dispose unsubscribes and cancels a pending retry).
 */
export function createAutoOpenWatcher(options: AutoOpenOptions): AutoOpenWatcher {
  const { ctx, runtime, open } = options
  const retryDelays = options.retryDelaysMs ?? AUTO_OPEN_RETRY_MS
  // Mutable on purpose: a late-arriving service must become the source BOTH the
  // subscription and every later snapshot read go through, or the watcher would
  // subscribe to one list and compare against another.
  let sessions = lookupService<SessionsLike>(ctx, 'sessions')

  let disposed = false
  let current = currentOf(sessions)
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null
  let attempt = 0
  let unsubscribe: (() => void) | null = null

  const cancelTimer = (): void => {
    if (timer === null) return
    globalThis.clearTimeout(timer)
    timer = null
  }

  /** Try to open, retrying while the session stays the one we opened for. */
  const attemptOpen = (sessionId: string): void => {
    if (disposed) return
    if (runtime.getPrefs()?.autoOpenOnNewSession !== true) return
    if (current !== sessionId) return
    if (attempt >= retryDelays.length) return

    const delay = retryDelays[attempt] ?? 0
    attempt += 1
    cancelTimer()
    timer = globalThis.setTimeout(() => {
      timer = null
      if (disposed || current !== sessionId) return
      let opened = false
      try {
        opened = open()
      } catch (error) {
        console.warn('[dsh-notebook] auto-open failed:', error)
      }
      if (!opened) attemptOpen(sessionId)
    }, delay)
  }

  /** The session list changed: a session that was not current before is new. */
  const onListChange = (): void => {
    if (disposed) return
    const next = currentOf(sessions)
    if (next === current) return
    current = next
    cancelTimer()
    attempt = 0
    // `next === null` (no session selected: the hero screen) opens nothing.
    if (next !== null) attemptOpen(next)
  }

  /** Subscribe to whatever list is resolved right now (idempotent). */
  const subscribeList = (): void => {
    if (disposed || unsubscribe !== null) return
    try {
      const handle = sessions?.list?.subscribe?.(onListChange)
      if (typeof handle === 'function') unsubscribe = handle as () => void
    } catch (error) {
      console.warn('[dsh-notebook] watching session changes failed:', error)
    }
  }

  subscribeList()

  // The service may arrive after the host registered (boot order is free).
  let injected: unknown
  if (sessions === undefined || unsubscribe === null) {
    try {
      injected = ctx.inject(['sessions'], () => {
        if (disposed) return
        const late = lookupService<SessionsLike>(ctx, 'sessions')
        if (late !== undefined) sessions = late
        // The session that is already current when the service appears is a
        // starting point, not a "new" one.
        const seen = currentOf(sessions)
        if (seen !== null && current === null) current = seen
        subscribeList()
      })
    } catch {
      // No injection channel: the watcher simply stays inert.
    }
  }

  return {
    get currentSessionId() {
      return current
    },
    dispose() {
      if (disposed) return
      disposed = true
      cancelTimer()
      const off = unsubscribe
      unsubscribe = null
      if (off !== null) {
        try {
          off()
        } catch {
          // an already-released subscription is fine
        }
      }
      const dispose = disposeOf(injected)
      try {
        dispose()
      } catch {
        // see above
      }
    },
  }
}

/**
 * Wire the watcher to the native right sidebar: `openTab` is the whole gesture
 * (it also expands the panel — content the user cannot see is not opened), with
 * a belt-and-braces `toggleExpanded` for a version whose `openTab` does not.
 *
 * @returns the disposer registered with the host.
 */
export function attachAutoOpen(
  ctx: ClientContext,
  runtime: NotebookRuntime,
  right: SidebarRightLike | undefined,
  kind: string,
  options?: { retryDelaysMs?: readonly number[] },
): () => void {
  if (right === undefined || typeof right.openTab !== 'function') return () => {}

  return attachSessionAutoOpen(
    ctx,
    runtime,
    () => {
      // Throws while the session's surface is not mounted: that IS the retry signal.
      right.openTab(kind)
      if (typeof right.isExpanded === 'function' && right.isExpanded() === false) {
        try {
          right.toggleExpanded()
        } catch {
          // an unexpandable panel is still an opened tab
        }
      }
      return true
    },
    options,
  )
}

/**
 * The host-agnostic form: any carrier that can show the notebook can be opened
 * for a new session, so every tier wires the same watcher to its own gesture
 * (the native `openTab`, the sidebar product's `openTab`, or the standalone
 * panel's local open state). The preference gate lives here, once.
 *
 * @param open - perform the gesture; `false` asks the watcher to retry shortly.
 * @returns the disposer registered with the host.
 */
export function attachSessionAutoOpen(
  ctx: ClientContext,
  runtime: NotebookRuntime,
  open: () => boolean,
  options?: { retryDelaysMs?: readonly number[] },
): () => void {
  const watcher = createAutoOpenWatcher({
    ctx,
    runtime,
    retryDelaysMs: options?.retryDelaysMs,
    open: () => {
      if (runtime.getPrefs()?.autoOpenOnNewSession !== true) return false
      return open()
    },
  })
  return () => watcher.dispose()
}
