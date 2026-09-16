// @vitest-environment node
/**
 * New-session auto-open (native tier).
 *
 * The watcher is the only thing standing between "a session starts collapsed and
 * empty" and the user's preference to see the notebook in every new session, so
 * the tests below pin its restraint as much as its action: the session that is
 * current at activation is never opened, the preference gates everything, a seat
 * that holds no binding yet is retried instead of given up on, and — v0.2.3 —
 * the gesture never touches the panel state, because the open IS the reveal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachAutoOpen, attachSessionAutoOpen, createAutoOpenWatcher } from '../src/client/hosts/autoOpen'
import type { SessionsLike } from '../src/client/hosts/autoOpen'
import type { ClientContext, NotebookRuntime, SidebarRightLike } from '../src/client/hosts/types'
import { DEFAULT_PREFS } from '../src/shared/types'
import type { NotebookPrefs } from '../src/shared/types'

/** A session list double: `set()` publishes a change to every subscriber. */
function createFakeSessions(initial: string | null = null) {
  let current: string | null = initial
  const listeners = new Set<() => void>()
  const sessions: SessionsLike = {
    list: {
      getSnapshot: () => ({ current }),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
  return {
    sessions,
    listeners,
    set(next: string | null) {
      current = next
      for (const listener of [...listeners]) listener()
    },
    get current() {
      return current
    },
  }
}

function createFakeContext(services: Record<string, unknown> = {}) {
  const observers: Array<{ deps: readonly string[]; fire: () => void }> = []
  const ctx = {
    slots: { register: () => () => {}, inject: () => () => {} },
    locale: { register: () => () => {}, get: () => 'zh' },
    effect: (callback: () => (() => void) | void) => callback(),
    get: (name: string) => services[name],
    inject(deps: readonly string[], callback: (inner: ClientContext) => unknown) {
      observers.push({ deps: [...deps], fire: () => callback(ctx as unknown as ClientContext) })
      return { dispose: () => {} }
    },
  } as unknown as ClientContext
  return { ctx, observers }
}

function createRuntime(prefs: Partial<NotebookPrefs> = {}): NotebookRuntime {
  const stable: NotebookPrefs = { ...DEFAULT_PREFS, ...prefs }
  return {
    api: {} as never,
    composer: {
      available: () => false,
      sessionId: () => null,
      attachImages: async () => ({ ok: false, inserted: 0, skipped: 0, failed: 0, reason: 'no-target' }),
      appendText: () => false,
      reference: () => false,
    },
    getPrefs: () => stable,
    setPrefs: () => {},
    subscribe: () => () => {},
  }
}

/**
 * A runtime whose prefs are still being read from the host: `getPrefs()` answers
 * the defaults and `prefsReady()` says `false` until {@link hydrate} is called.
 */
function createHydratingRuntime(initial: Partial<NotebookPrefs> = {}) {
  const base = createRuntime()
  let prefs: NotebookPrefs = { ...DEFAULT_PREFS, ...initial }
  let ready = false
  const runtime: NotebookRuntime = {
    ...base,
    getPrefs: () => prefs,
    prefsReady: () => ready,
  }
  return {
    runtime,
    /** The host answered: the switches now hold the document's values. */
    hydrate(next: Partial<NotebookPrefs> = {}): void {
      prefs = { ...prefs, ...next }
      ready = true
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('createAutoOpenWatcher', () => {
  it('records the session that is already current and opens nothing for it', () => {
    const sessions = createFakeSessions('session-1')
    const { ctx } = createFakeContext({ sessions: sessions.sessions })
    const open = vi.fn(() => true)
    const watcher = createAutoOpenWatcher({ ctx, runtime: createRuntime({ autoOpenOnNewSession: true }), open })

    vi.advanceTimersByTime(5000)
    expect(watcher.currentSessionId).toBe('session-1')
    expect(open).not.toHaveBeenCalled()
    watcher.dispose()
  })

  it('opens for the session a page load restores (the list arrives after activation)', () => {
    // The v0.2.3 behaviour both READMEs document: the watcher is built while the
    // list is still empty, so the first session it ever sees is a session
    // BECOMING current — the same gesture as a switch. A late-arriving *service*
    // is the one case that is recorded as a starting point instead (the test
    // above), which is why this one starts with an empty list, not a missing one.
    const sessions = createFakeSessions(null)
    const { ctx } = createFakeContext({ sessions: sessions.sessions })
    const open = vi.fn(() => true)
    const watcher = createAutoOpenWatcher({
      ctx,
      runtime: createRuntime({ autoOpenOnNewSession: true }),
      open,
      retryDelaysMs: [0],
    })

    expect(watcher.currentSessionId).toBeNull()
    sessions.set('restored-by-page-load')
    vi.advanceTimersByTime(0)

    expect(open).toHaveBeenCalledTimes(1)
    expect(watcher.currentSessionId).toBe('restored-by-page-load')
    watcher.dispose()
  })

  it('opens once per change of the current session, not once per snapshot', () => {
    const sessions = createFakeSessions('old')
    const { ctx } = createFakeContext({ sessions: sessions.sessions })
    const open = vi.fn(() => true)
    const watcher = createAutoOpenWatcher({ ctx, runtime: createRuntime({ autoOpenOnNewSession: true }), open })

    sessions.set('fresh')
    vi.advanceTimersByTime(0)
    expect(open).toHaveBeenCalledTimes(1)
    expect(watcher.currentSessionId).toBe('fresh')

    // the same session re-published is not a new session
    sessions.set('fresh')
    vi.advanceTimersByTime(5000)
    expect(open).toHaveBeenCalledTimes(1)
    watcher.dispose()
  })

  it('never opens while the preference is off — the default', () => {
    const sessions = createFakeSessions('old')
    const { ctx } = createFakeContext({ sessions: sessions.sessions })
    const open = vi.fn(() => true)
    const watcher = createAutoOpenWatcher({ ctx, runtime: createRuntime(), open })

    sessions.set('fresh')
    vi.advanceTimersByTime(5000)
    expect(open).not.toHaveBeenCalled()
    watcher.dispose()
  })

  it('retries while the seat holds no binding yet, then stops', () => {
    const sessions = createFakeSessions('old')
    const { ctx } = createFakeContext({ sessions: sessions.sessions })
    let attempts = 0
    const open = vi.fn(() => {
      attempts += 1
      return attempts >= 3
    })
    const watcher = createAutoOpenWatcher({
      ctx,
      runtime: createRuntime({ autoOpenOnNewSession: true }),
      open,
      retryDelaysMs: [0, 10, 20, 1000],
    })

    sessions.set('fresh')
    vi.advanceTimersByTime(0)
    expect(open).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10)
    expect(open).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(20)
    expect(open).toHaveBeenCalledTimes(3)

    // landed: the schedule is over
    vi.advanceTimersByTime(60_000)
    expect(open).toHaveBeenCalledTimes(3)
    watcher.dispose()
  })

  it('drops a pending retry the moment the session changes again', () => {
    const sessions = createFakeSessions('old')
    const { ctx } = createFakeContext({ sessions: sessions.sessions })
    const open = vi.fn(() => false)
    const watcher = createAutoOpenWatcher({
      ctx,
      runtime: createRuntime({ autoOpenOnNewSession: true }),
      open,
      retryDelaysMs: [50, 50],
    })

    sessions.set('a')
    sessions.set('b')
    vi.advanceTimersByTime(50)
    // only the newest session may be opened, and only once per schedule step
    expect(open).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(50)
    expect(open).toHaveBeenCalledTimes(2)
    watcher.dispose()
  })

  it('does nothing without a sessions service, and picks it up when it arrives late', () => {
    const { ctx, observers } = createFakeContext()
    const open = vi.fn(() => true)
    const watcher = createAutoOpenWatcher({ ctx, runtime: createRuntime({ autoOpenOnNewSession: true }), open })

    sessions_noop()
    function sessions_noop(): void {
      vi.advanceTimersByTime(1000)
      expect(open).not.toHaveBeenCalled()
    }

    const sessions = createFakeSessions('late-1')
    ;(ctx as unknown as { get: (name: string) => unknown }).get = (name: string) =>
      name === 'sessions' ? sessions.sessions : undefined
    observers.find((entry) => entry.deps[0] === 'sessions')!.fire()

    // the late-arriving current session is a starting point, not a "new" one
    vi.advanceTimersByTime(1000)
    expect(open).not.toHaveBeenCalled()

    sessions.set('late-2')
    vi.advanceTimersByTime(0)
    expect(open).toHaveBeenCalledTimes(1)
    watcher.dispose()
  })

  it('stops everything on dispose', () => {
    const sessions = createFakeSessions('old')
    const { ctx } = createFakeContext({ sessions: sessions.sessions })
    const open = vi.fn(() => false)
    const watcher = createAutoOpenWatcher({
      ctx,
      runtime: createRuntime({ autoOpenOnNewSession: true }),
      open,
      retryDelaysMs: [10, 10, 10],
    })

    sessions.set('fresh')
    watcher.dispose()
    vi.advanceTimersByTime(60_000)
    expect(open).not.toHaveBeenCalled()
    expect(sessions.listeners.size).toBe(0)

    sessions.set('later')
    vi.advanceTimersByTime(60_000)
    expect(open).not.toHaveBeenCalled()
  })
})

describe('attachAutoOpen', () => {
  /**
   * A `ctx.sidebarRight` double that keeps DSH's two facts apart, because the
   * v0.2.2 bug lived exactly in the gap between them. The shipped controller:
   *
   * - commits IMMUTABLY — an open produces a new surface with `expanded: true`
   *   and the tab in it;
   * - answers `isExpanded()` from the surface snapshot the seat bound at its
   *   LAST RENDER, so inside the synchronous call that opened a collapsed panel
   *   it still reports `false` (React commits that binding on a later tick);
   * - flips the LIVE surface in `toggleExpanded()`, so "read it, then flip it"
   *   collapses the column the open had just revealed.
   *
   * `isExpanded` / `toggleExpanded` are extra members on purpose: the real
   * controller carries them, and the regression is a plugin that touches them.
   */
  function createNativeRight() {
    let live = { expanded: false, tabs: [] as string[] }
    let bound = live // what the seat last rendered and bound into the controller
    const calls = { openTab: [] as string[], isExpanded: 0, toggleExpanded: 0 }
    const right = {
      openTab(kind: string): void {
        calls.openTab.push(kind)
        live = { expanded: true, tabs: [...live.tabs, kind] }
      },
      isExpanded(): boolean {
        calls.isExpanded += 1
        // Stale on purpose: `bound` only catches up when React commits.
        return bound.expanded
      },
      toggleExpanded(): void {
        calls.toggleExpanded += 1
        live = { ...live, expanded: !live.expanded }
      },
      /** React's commit: the seat rebinds with the surface that is live now. */
      commit(): void {
        bound = live
      },
    }
    return {
      right,
      calls,
      commit: right.commit,
      get live() {
        return live
      },
      get bound() {
        return bound
      },
    }
  }

  it('leaves the column open: the open IS the reveal, so nothing may undo it', () => {
    const sessions = createFakeSessions('old')
    const { ctx } = createFakeContext({ sessions: sessions.sessions })
    const host = createNativeRight()
    const dispose = attachAutoOpen(
      ctx,
      createRuntime({ autoOpenOnNewSession: true }),
      host.right,
      'dsh-notebook',
      { retryDelaysMs: [0] },
    )

    sessions.set('fresh')
    vi.advanceTimersByTime(0)

    expect(host.calls.openTab).toEqual(['dsh-notebook'])
    expect(host.live.expanded).toBe(true)
    expect(host.live.tabs).toEqual(['dsh-notebook'])

    // Nothing corrected the column, so it is still open after React commits
    // the binding: the plugin neither read the stale snapshot nor flipped the
    // live surface.
    expect(host.calls.isExpanded).toBe(0)
    expect(host.calls.toggleExpanded).toBe(0)
    host.commit()
    expect(host.right.isExpanded()).toBe(true)
    dispose()
  })

  it('pins why: the v0.2.2 read-then-flip collapses the column the open revealed', () => {
    // This is the double's own contract, and the shape of the shipped bug: the
    // sequence the plugin used to run after `openTab` left the panel collapsed.
    const host = createNativeRight()
    host.right.openTab('dsh-notebook')
    expect(host.right.isExpanded()).toBe(false) // stale — the trigger
    host.right.toggleExpanded() // the "correction"
    host.commit()
    expect(host.right.isExpanded()).toBe(false) // the open, undone
  })

  it('keeps retrying while the controller refuses (the seat holds no binding)', () => {
    const sessions = createFakeSessions('old')
    const { ctx } = createFakeContext({ sessions: sessions.sessions })
    const host = createNativeRight()
    let attempts = 0
    const right = {
      ...host.right,
      openTab(kind: string): void {
        attempts += 1
        // The real controller throws this while no session surface is mounted.
        if (attempts < 2) throw new Error('sidebarRight: no session surface is mounted')
        host.right.openTab(kind)
      },
    }
    const dispose = attachAutoOpen(
      ctx,
      createRuntime({ autoOpenOnNewSession: true }),
      right,
      'dsh-notebook',
      { retryDelaysMs: [0, 0] },
    )

    sessions.set('fresh')
    vi.advanceTimersByTime(1)

    expect(attempts).toBe(2)
    expect(host.live.expanded).toBe(true)
    dispose()
  })

  it('is a no-op without a navigation controller', () => {
    const sessions = createFakeSessions('old')
    const { ctx } = createFakeContext({ sessions: sessions.sessions })
    const dispose = attachAutoOpen(ctx, createRuntime({ autoOpenOnNewSession: true }), undefined, 'dsh-notebook')
    sessions.set('fresh')
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow()
    dispose()
  })
})

describe('attachSessionAutoOpen — preference hydration', () => {
  /**
   * The document prefs arrive over HTTP *after* activation, so for the first
   * moments every switch holds its default — and `autoOpenOnNewSession` defaults
   * to `false`. A watcher that treats that "not read yet" as "no" drops the
   * gesture for good, because it only ever reacts to session changes; these two
   * tests pin both halves of the fix.
   */
  it('does not lose a session that becomes current before the host answers', () => {
    const sessions = createFakeSessions('old')
    const { ctx } = createFakeContext({ sessions: sessions.sessions })
    const host = createHydratingRuntime()
    const open = vi.fn(() => true)
    const dispose = attachSessionAutoOpen(ctx, host.runtime, open, { retryDelaysMs: [0, 200, 500] })

    sessions.set('fresh')
    vi.advanceTimersByTime(0)
    // The gate holds while the answer is unknown: nothing opens on a default.
    expect(open).not.toHaveBeenCalled()

    host.hydrate({ autoOpenOnNewSession: true })
    vi.advanceTimersByTime(200)
    expect(open).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('gives up at once once the host has answered "off"', () => {
    const sessions = createFakeSessions('old')
    const { ctx } = createFakeContext({ sessions: sessions.sessions })
    const host = createHydratingRuntime()
    host.hydrate()
    const open = vi.fn(() => true)
    const dispose = attachSessionAutoOpen(ctx, host.runtime, open, { retryDelaysMs: [0, 200, 500] })

    sessions.set('fresh')
    vi.advanceTimersByTime(60_000)
    expect(open).not.toHaveBeenCalled()
    dispose()
  })

  it('stops waiting when the read fails: the defaults are the answer then', () => {
    const sessions = createFakeSessions('old')
    const { ctx } = createFakeContext({ sessions: sessions.sessions })
    const host = createHydratingRuntime()
    const open = vi.fn(() => true)
    const dispose = attachSessionAutoOpen(ctx, host.runtime, open, { retryDelaysMs: [0] })

    sessions.set('fresh')
    host.hydrate() // a failed read settles the prefs on their defaults
    vi.advanceTimersByTime(60_000)
    expect(open).not.toHaveBeenCalled()
    dispose()
  })

  it('does not let a throwing readiness probe escape the watcher', () => {
    // The probe is optional plumbing from someone else's composition, and the
    // watcher runs inside the session list's own notification stack: a throw
    // here would escape into whoever committed the store. It must be swallowed,
    // and the fallback reading ("the answer is known") fails closed — a `false`
    // preference gives up, so nothing opens.
    const sessions = createFakeSessions('old')
    const { ctx } = createFakeContext({ sessions: sessions.sessions })
    const runtime: NotebookRuntime = {
      ...createRuntime(),
      prefsReady: () => {
        throw new Error('probe unavailable')
      },
    }
    const open = vi.fn(() => true)
    const dispose = attachSessionAutoOpen(ctx, runtime, open, { retryDelaysMs: [0, 200] })

    sessions.set('fresh')
    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow()
    expect(open).not.toHaveBeenCalled()
    dispose()
  })
})
