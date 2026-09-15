// @vitest-environment node
/**
 * New-session auto-open (native tier).
 *
 * The watcher is the only thing standing between "a session starts collapsed and
 * empty" and the user's preference to see the notebook in every new session, so
 * the tests below pin its restraint as much as its action: the session that is
 * current at activation is never opened, the preference gates everything, and a
 * surface that is not mounted yet is retried instead of given up on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachAutoOpen, createAutoOpenWatcher } from '../src/client/hosts/autoOpen'
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

  it('retries while the session surface is still unmounted, then stops', () => {
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
  function createRight(openTab: (kind: string) => void) {
    let expanded = false
    const right: SidebarRightLike = {
      openTab: vi.fn((kind: string) => {
        openTab(kind)
      }),
      toggleExpanded: vi.fn(() => {
        expanded = !expanded
      }),
      isExpanded: vi.fn(() => expanded),
    }
    return right
  }

  it('opens the notebook tab and expands the panel when openTab left it collapsed', () => {
    const sessions = createFakeSessions('old')
    const { ctx } = createFakeContext({ sessions: sessions.sessions })
    const right = createRight(() => {})
    const dispose = attachAutoOpen(
      ctx,
      createRuntime({ autoOpenOnNewSession: true }),
      right,
      'dsh-notebook',
      { retryDelaysMs: [0] },
    )

    sessions.set('fresh')
    vi.advanceTimersByTime(0)

    expect(right.openTab).toHaveBeenCalledWith('dsh-notebook')
    expect(right.toggleExpanded).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('keeps retrying while the navigation controller refuses (no mounted surface)', () => {
    const sessions = createFakeSessions('old')
    const { ctx } = createFakeContext({ sessions: sessions.sessions })
    let attempts = 0
    const right = createRight(() => {
      attempts += 1
      if (attempts < 2) throw new Error('no mounted session surface')
    })
    const dispose = attachAutoOpen(
      ctx,
      createRuntime({ autoOpenOnNewSession: true }),
      right,
      'dsh-notebook',
      { retryDelaysMs: [0, 0] },
    )

    sessions.set('fresh')
    vi.advanceTimersByTime(1)
    expect(right.openTab).toHaveBeenCalledTimes(2)
    expect(right.toggleExpanded).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('does not collapse an already-expanded panel', () => {
    const sessions = createFakeSessions('old')
    const { ctx } = createFakeContext({ sessions: sessions.sessions })
    let expanded = true
    const right: SidebarRightLike = {
      openTab: vi.fn(() => {}),
      toggleExpanded: vi.fn(() => {
        expanded = !expanded
      }),
      isExpanded: vi.fn(() => expanded),
    }
    const dispose = attachAutoOpen(
      ctx,
      createRuntime({ autoOpenOnNewSession: true }),
      right,
      'dsh-notebook',
      { retryDelaysMs: [0] },
    )

    sessions.set('fresh')
    vi.advanceTimersByTime(0)

    expect(right.openTab).toHaveBeenCalledWith('dsh-notebook')
    expect(right.toggleExpanded).not.toHaveBeenCalled()
    expect(expanded).toBe(true)
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
