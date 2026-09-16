// @vitest-environment node
/**
 * tier-detect — the three-tier sidebar probe (spec §2.2) driven end to end with a
 * fake client context.
 *
 * The UI leaves are mocked on purpose: tier detection is about the registration
 * CALL SEQUENCE, and the node environment has no DOM, so the real
 * `NotebookView` / `NotebookSettingsPanel` trees are irrelevant here (and are
 * covered by `test/editor.test.tsx`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/client/NotebookView', () => ({ NotebookView: () => null }))
vi.mock('../src/client/NotebookSettingsPanel', () => ({ NotebookSettingsPanel: () => null }))

import { apply, mergePrefs, reveal, tierOf } from '../src/client/index'
import { createTierController } from '../src/client/hosts/detect'
import type { NotebookApiClient } from '../src/client/api'
import type { NotebookComposer } from '../src/client/composer'
import type {
  ClientContext,
  NotebookHost,
  NotebookRuntime,
  SlotRegisterOptions,
  TabDescriptorLike,
} from '../src/client/hosts/types'
import { DEFAULT_PREFS } from '../src/shared/types'
import type { NotebookPrefs } from '../src/shared/types'

// ── fakes ───────────────────────────────────────────────────────────────────

interface NativeTabRegistryDef {
  id: string
  kind: string
  priority?: string
  title: (address: string) => string
  guide?: readonly {
    order: number
    title: () => string
    description?: () => string
    icon?: unknown
  }[]
}

interface SlotRegistration {
  options: SlotRegisterOptions
  component: unknown
  disposed: boolean
}

/**
 * Slots the shell declares as `kind: 'keyed'`, which the real registry
 * addresses by `key` and rejects an `id`-only descriptor for. Kept here so the
 * double fails the same way the shell does.
 */
const KEYED_SLOTS = new Set<string>(['sidebar.right.pane.tab'])

interface FakeContext extends ClientContext {
  setService(name: string, value: unknown): void
  /** Fire every registered effect disposer in reverse order, like a cordis unload / HMR. */
  disposeEffects(): void
  readonly slotRegistrations: SlotRegistration[]
  readonly observers: Array<{ deps: readonly string[]; fire: () => void }>
  readonly disposedEffects: number
}

function createFakeContext(initial: Record<string, unknown> = {}): FakeContext {
  const services = new Map<string, unknown>(Object.entries(initial) as Array<[string, unknown]>)
  const slotRegistrations: SlotRegistration[] = []
  const observers: Array<{ deps: readonly string[]; fire: () => void }> = []
  const effectDisposers: Array<() => void> = []
  let disposedEffects = 0

  const ctx: FakeContext = {
    slots: {
      register(options: SlotRegisterOptions, component: unknown): () => void {
        // Mirror the real registry's load-time kind check (`SlotCore.register`):
        // a keyed slot addresses its entries by `key`, and a descriptor without
        // one THROWS. A permissive double here is how a list-shaped
        // registration on the keyed `sidebar.right.pane.tab` once shipped and
        // left the sidebar showing a Notebook tab nothing could render.
        if (KEYED_SLOTS.has(options.name) && !('key' in options)) {
          throw new Error(`slot "${options.name}" is keyed: register it under \`key\`, not \`id\``)
        }
        const entry: SlotRegistration = { options, component, disposed: false }
        slotRegistrations.push(entry)
        return () => {
          entry.disposed = true
        }
      },
      // Stands in for a slot the shell has declared: the callback runs and its
      // disposer is handed back, exactly like the real registry.
      inject(_key: string, callback: () => () => void): () => void {
        const off = callback()
        return () => {
          if (typeof off === 'function') off()
        }
      },
    },
    locale: {
      register: () => () => {},
      get: () => 'zh',
    },
    effect(callback: () => (() => void) | void): unknown {
      const off = callback()
      // cordis's `effect()` disposer is idempotent (`if (disposing) return
      // disposalTask` in its source), and the plugin legitimately disposes the
      // same effect twice: once through its own host teardown and once when the
      // fiber unloads. The fake mirrors that so a double release stays visible
      // instead of silently double-invoking a third party's disposer.
      let disposing = false
      const dispose = (): void => {
        if (disposing) return
        disposing = true
        disposedEffects += 1
        if (typeof off === 'function') off()
      }
      effectDisposers.push(dispose)
      return dispose
    },
    get(name: string): unknown {
      return services.get(name)
    },
    // cordis returns a Fiber here, not a disposer — the fake mirrors that shape
    // so `disposeOf()` in detect.ts is exercised for real.
    inject(deps: readonly string[], callback: (inner: ClientContext) => unknown): unknown {
      observers.push({
        deps: [...deps],
        fire: () => {
          callback(ctx)
        },
      })
      return { dispose: () => {} }
    },
    setService(name: string, value: unknown): void {
      services.set(name, value)
    },
    disposeEffects(): void {
      for (const dispose of effectDisposers.splice(0).reverse()) dispose()
    },
    slotRegistrations,
    observers,
    get disposedEffects(): number {
      return disposedEffects
    },
  }

  return ctx
}

function createFakeNativeTabs() {
  let disposeCount = 0
  const register = vi.fn((_def: NativeTabRegistryDef): (() => void) => {
    return () => {
      disposeCount += 1
    }
  })
  return { register, disposeCount: () => disposeCount }
}

function createFakeNativeRight() {
  // The real controller also carries `isExpanded()` / `toggleExpanded()`, and
  // that pair is a trap — `isExpanded()` answers from the seat's last render and
  // is stale right after an open, while `toggleExpanded()` flips the live state
  // (see `src/client/hosts/types.ts`). They are spied here, not modelled as
  // behaviour, so a regression that reaches for them fails loudly instead of
  // being swallowed by the `try`/`catch` such a call site would sit in.
  let expanded = false
  return {
    openTab: vi.fn((_kind: string, _options?: unknown): void => {}),
    isExpanded: vi.fn((): boolean => expanded),
    toggleExpanded: vi.fn((): void => {
      expanded = !expanded
    }),
  }
}

function createFakeSidebar(options?: { features?: readonly string[] }) {
  const tabDisposers: Array<ReturnType<typeof vi.fn>> = []
  const registerTab = vi.fn((_descriptor: TabDescriptorLike): (() => void) => {
    const dispose = vi.fn()
    tabDisposers.push(dispose)
    return dispose
  })
  const openTab = vi.fn((_seed: { type: string; title: string; id?: string }): void => {})
  const getTab = vi.fn((_id: string): TabDescriptorLike | undefined => undefined)
  return {
    registerTab,
    openTab,
    getTab,
    tabDisposers,
    ...(options?.features === undefined ? {} : { features: options.features }),
  }
}

function createFakeApi(prefs: Partial<NotebookPrefs> = {}): NotebookApiClient {
  const api: NotebookApiClient = {
    getState: async () => ({
      doc: { version: 1, notes: [], prefs: { ...DEFAULT_PREFS, ...prefs } },
      degraded: false,
    }),
    createNote: async () => {
      throw new Error('[tier-detect] createNote is not part of tier detection')
    },
    updateNote: async () => {
      throw new Error('[tier-detect] updateNote is not part of tier detection')
    },
    deleteNote: async () => {},
    updatePrefs: async (patch) => mergePrefs(DEFAULT_PREFS, patch),
    attachmentUrl: (noteId, relPath) =>
      `/notebook/api/attachments/${encodeURIComponent(noteId)}/${encodeURIComponent(relPath)}`,
  }
  return api
}

/** A session-list double: `set()` publishes a change to its subscribers. */
function createFakeSessions(initial: string | null = null) {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    list: {
      getSnapshot: () => ({ current }),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    set(next: string | null): void {
      current = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** The composer bridge stub: tier detection never talks to a real composer. */
function createFakeComposer(): NotebookComposer {
  return {
    available: () => false,
    sessionId: () => null,
    attachImages: async () => ({ ok: false, inserted: 0, skipped: 0, failed: 0, reason: 'no-target' }),
    appendText: () => false,
    reference: () => false,
  }
}

/**
 * The tier-3 self-drawn shell entry.
 *
 * Narrowed by `id` on purpose: since v0.2.0 the tier-independent capture
 * surfaces also live in `shell.overlay`, so "is a shell registered?" can no
 * longer be answered by the slot name alone.
 */
const shellRegistrations = (ctx: FakeContext): SlotRegistration[] =>
  ctx.slotRegistrations.filter(
    (entry) => entry.options.name === 'shell.overlay' && entry.options.id === 'dsh-notebook-shell',
  )

/**
 * The list-slot id of a registration (`''` for a keyed one, which has none).
 *
 * The options union discriminates on the slot name rather than on `id`, so
 * every id read has to narrow first — exactly the compile-time discipline the
 * real registry rewards.
 */
const listId = (entry: SlotRegistration): string => ('id' in entry.options ? entry.options.id : '')

/**
 * The v0.2.0 capture surfaces (floating selection action + answer action).
 * Registered once per activation whatever the tier, so every tier test must
 * find them and must never mistake them for a sidebar carrier.
 */
const captureRegistrations = (ctx: FakeContext): SlotRegistration[] =>
  ctx.slotRegistrations.filter(
    (entry) =>
      listId(entry) === 'dsh-notebook-capture' ||
      entry.options.name === 'conversation.chat.assistant-actions',
  )

const paneRegistrations = (ctx: FakeContext): SlotRegistration[] =>
  ctx.slotRegistrations.filter((entry) => entry.options.name === 'sidebar.right.pane.tab')

// ── tests ───────────────────────────────────────────────────────────────────

describe('three-tier sidebar detection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('tier 1 — native: registers tab type + tab body, never the service, never the shell', async () => {
    const tabs = createFakeNativeTabs()
    const right = createFakeNativeRight()
    const sidebar = createFakeSidebar()
    const ctx = createFakeContext({
      sidebarRightTabs: tabs,
      sidebarRight: right,
      betterSidebar: sidebar,
    })

    apply(ctx, { api: createFakeApi() })
    await vi.advanceTimersByTimeAsync(0)

    expect(tierOf(ctx)).toBe('native')
    expect(tabs.register).toHaveBeenCalledTimes(1)

    const def = tabs.register.mock.calls[0]![0]
    expect(def.id).toBe('dsh-notebook')
    expect(def.kind).toBe('dsh-notebook')
    expect(def.priority).toBe('extension')
    expect(def.guide?.[0]?.order).toBe(60)
    expect(typeof def.title('')).toBe('string')
    expect(def.title('').length).toBeGreaterThan(0)

    // phase one: the body goes into the keyed pane slot under `key` — the id
    // of the type in force, which is what the seat dispatches a tab on
    const pane = paneRegistrations(ctx)
    expect(pane).toHaveLength(1)
    const paneOptions = pane[0]!.options
    if (paneOptions.name !== 'sidebar.right.pane.tab') {
      throw new Error('expected the registration to target the keyed pane slot')
    }
    expect(paneOptions.key).toBe('dsh-notebook')
    expect(typeof pane[0]!.component).toBe('function')

    // no own shell, and the sidebar service was never touched
    expect(shellRegistrations(ctx)).toHaveLength(0)
    expect(sidebar.registerTab).not.toHaveBeenCalled()

    // startup never reveals; the user-activation path does — and neither ever
    // touches the panel state directly (the v0.2.2 collapse, pinned here so the
    // `try`/`catch` in `reveal()` cannot hide it coming back)
    expect(right.openTab).not.toHaveBeenCalled()
    expect(reveal(ctx)).toBe('native')
    expect(right.openTab).toHaveBeenCalledWith('dsh-notebook')
    expect(right.isExpanded).not.toHaveBeenCalled()
    expect(right.toggleExpanded).not.toHaveBeenCalled()

    // and the fallback timer never drew a shell
    await vi.advanceTimersByTimeAsync(2000)
    expect(shellRegistrations(ctx)).toHaveLength(0)
    expect(tierOf(ctx)).toBe('native')
  })

  it('tier 1 — auto-opens the notebook when a NEW session becomes current (opt-in)', async () => {
    const tabs = createFakeNativeTabs()
    const right = createFakeNativeRight()
    const sessions = createFakeSessions(null)
    const ctx = createFakeContext({
      sidebarRightTabs: tabs,
      sidebarRight: right,
      sessions,
    })

    apply(ctx, { api: createFakeApi({ autoOpenOnNewSession: true }) })
    await vi.advanceTimersByTimeAsync(0)

    // the hero screen (no session) opens nothing, however the preference reads
    expect(right.openTab).not.toHaveBeenCalled()

    sessions.set('session-new')
    await vi.advanceTimersByTimeAsync(0)
    expect(right.openTab).toHaveBeenCalledWith('dsh-notebook')

    // switching away and back is one open per session, not one per render
    sessions.set('session-other')
    await vi.advanceTimersByTimeAsync(0)
    sessions.set('session-new')
    await vi.advanceTimersByTimeAsync(0)
    expect(right.openTab).toHaveBeenCalledTimes(3)
  })

  it('tier 1 — auto-open stays off by default', async () => {
    const right = createFakeNativeRight()
    const sessions = createFakeSessions('existing')
    const ctx = createFakeContext({
      sidebarRightTabs: createFakeNativeTabs(),
      sidebarRight: right,
      sessions,
    })

    apply(ctx, { api: createFakeApi() })
    await vi.advanceTimersByTimeAsync(0)
    sessions.set('session-new')
    await vi.advanceTimersByTimeAsync(5000)

    expect(right.openTab).not.toHaveBeenCalled()
  })

  it('tier 1 — a rejected tab body never leaves a bodyless tab type behind', async () => {
    const tabs = createFakeNativeTabs()
    const ctx = createFakeContext({
      sidebarRightTabs: tabs,
      sidebarRight: createFakeNativeRight(),
    })

    // The shell rejects the body registration — which is exactly what a
    // list-shaped (`id`/`order`) descriptor on the keyed pane slot does. The
    // type must stay unregistered: a registered type whose body never landed
    // still draws a Notebook tab, and opening it answers "nothing here can view
    // this kind of content yet" instead of failing where the cause is visible.
    ctx.slots.register = () => {
      throw new Error('slot "sidebar.right.pane.tab" is keyed: missing `key`')
    }

    apply(ctx, { api: createFakeApi() })
    await vi.advanceTimersByTimeAsync(0)

    expect(tabs.register).not.toHaveBeenCalled()
    expect(paneRegistrations(ctx)).toHaveLength(0)
    expect(tierOf(ctx)).toBeNull()
  })

  it('tier 2 — service: one single-instance tab carrying every preference row', () => {
    const sidebar = createFakeSidebar({ features: ['badge', 'pluginSettings'] })
    const ctx = createFakeContext({ betterSidebar: sidebar })

    apply(ctx, { api: createFakeApi() })

    expect(tierOf(ctx)).toBe('service')
    expect(sidebar.registerTab).toHaveBeenCalledTimes(1)

    const descriptor = sidebar.registerTab.mock.calls[0]![0]
    expect(descriptor.id).toBe('dsh-notebook:notebook')
    expect(descriptor.single).toBe(true)
    expect(descriptor.order).toBe(60)
    expect(typeof descriptor.component).toBe('function')
    expect(typeof (descriptor.title as () => string)()).toBe('string')

    const settings = descriptor.settings as {
      pluginToggles: Array<{ key: string; type?: string }>
    }
    // Every preference except `openOnStart`, which only means something in the
    // standalone tier (the one tier that does not go through this declaration).
    expect(settings.pluginToggles.map((row) => row.key)).toEqual([
      'sortOrder',
      'copyImagesAsName',
      'maxImagesPerNote',
      'confirmDelete',
      'autoOpenOnNewSession',
      'selectionToNotebook',
      'messageToNotebook',
    ])

    expect(shellRegistrations(ctx)).toHaveLength(0)

    expect(reveal(ctx)).toBe('service')
    expect(sidebar.openTab).toHaveBeenCalledWith({
      type: 'dsh-notebook:notebook',
      title: expect.any(String),
    })
  })

  it('tier 2 — a service without a capability list still gets the toggles (no hard feature gate)', () => {
    const sidebar = createFakeSidebar()
    const ctx = createFakeContext({ betterSidebar: sidebar })

    apply(ctx, { api: createFakeApi() })

    const descriptor = sidebar.registerTab.mock.calls[0]![0]
    const settings = descriptor.settings as { pluginToggles: Array<{ key: string }> }
    expect(settings.pluginToggles).toHaveLength(7)
  })

  it('tier 3 — standalone: no service means our own shell, but only after the fallback delay', async () => {
    const ctx = createFakeContext()
    apply(ctx, { api: createFakeApi() })

    // both services are being watched for, and nothing is registered yet
    expect(ctx.observers.map((entry) => entry.deps[0]).sort()).toEqual([
      'betterSidebar',
      'inputTriggers',
      'sidebarRightTabs',
    ])
    expect(tierOf(ctx)).toBeNull()
    // Nothing sidebar-shaped yet, but the tier-independent capture surfaces are
    // already registered: they belong to the shell, not to the carrier probe.
    expect(paneRegistrations(ctx)).toHaveLength(0)
    expect(shellRegistrations(ctx)).toHaveLength(0)
    expect(captureRegistrations(ctx)).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(699)
    expect(tierOf(ctx)).toBeNull()

    await vi.advanceTimersByTimeAsync(1)
    expect(tierOf(ctx)).toBe('standalone')
    expect(
      ctx.slotRegistrations.some(
        (entry) => entry.options.name === 'shell.overlay' && entry.options.id === 'dsh-notebook-shell',
      ),
    ).toBe(true)
    expect(
      ctx.slotRegistrations.some(
        (entry) => entry.options.name === 'settings.section' && entry.options.id === 'dsh-notebook',
      ),
    ).toBe(true)
  })

  it('v0.2.0 — registers both capture surfaces once, with the contract the shell expects', async () => {
    const ctx = createFakeContext({ sidebarRightTabs: createFakeNativeTabs() })
    apply(ctx, { api: createFakeApi() })
    await vi.advanceTimersByTimeAsync(0)

    const overlay = ctx.slotRegistrations.find((entry) => listId(entry) === 'dsh-notebook-capture')
    expect(overlay?.options.name).toBe('shell.overlay')
    expect(typeof overlay?.component).toBe('function')
    // Above the tier-3 shell entry (order 5), so the floating action and its
    // toasts draw over the panel instead of under it.
    if (overlay?.options.name !== 'shell.overlay') throw new Error('expected the overlay list slot')
    expect(overlay.options.order).toBe(20)

    const answer = ctx.slotRegistrations.find(
      (entry) => entry.options.name === 'conversation.chat.assistant-actions',
    )
    expect(typeof answer?.component).toBe('function')
    if (answer?.options.name !== 'conversation.chat.assistant-actions') {
      throw new Error('expected the assistant-actions list slot')
    }
    expect(answer.options.id).toBe('dsh-notebook-save')
    // The shipped feedback pair registers at order 10; anything above it lands
    // at the end of the actions band.
    expect(answer.options.order).toBeGreaterThan(10)

    // The business face travels through `inject`, so the entry carries the
    // capabilities it actually uses.
    const face = answer.options.inject?.() as
      | { capture?: { save?: unknown }; getPrefs?: unknown; subscribe?: unknown }
      | undefined
    expect(typeof face?.capture?.save).toBe('function')
    expect(typeof face?.getPrefs).toBe('function')
    expect(typeof face?.subscribe).toBe('function')
  })

  it('v0.2.0 — a late tier upgrade never re-registers the capture surfaces', async () => {
    const ctx = createFakeContext()
    apply(ctx, { api: createFakeApi() })
    await vi.advanceTimersByTimeAsync(700)
    expect(tierOf(ctx)).toBe('standalone')
    expect(captureRegistrations(ctx)).toHaveLength(2)

    const sidebar = createFakeSidebar()
    ctx.setService('betterSidebar', sidebar)
    ctx.observers.find((entry) => entry.deps[0] === 'betterSidebar')!.fire()
    expect(tierOf(ctx)).toBe('service')

    // The capture surfaces belong to the shell, not to the winning carrier: a
    // second copy would render two floating actions and two action buttons.
    expect(captureRegistrations(ctx)).toHaveLength(2)
    expect(captureRegistrations(ctx).filter((entry) => entry.disposed)).toHaveLength(0)

    // …and they go away with the activation, not with the tier.
    ctx.disposeEffects()
    expect(captureRegistrations(ctx).filter((entry) => entry.disposed)).toHaveLength(2)
  })

  it('late upgrade — a sidebar service arriving after the shell tears the shell down first', async () => {    const ctx = createFakeContext()
    apply(ctx, { api: createFakeApi() })
    await vi.advanceTimersByTimeAsync(700)

    expect(tierOf(ctx)).toBe('standalone')
    const shell = shellRegistrations(ctx)[0]!
    expect(shell.disposed).toBe(false)

    const sidebar = createFakeSidebar()
    ctx.setService('betterSidebar', sidebar)
    ctx.observers.find((entry) => entry.deps[0] === 'betterSidebar')!.fire()

    expect(tierOf(ctx)).toBe('service')
    // the standalone entry is gone …
    expect(shell.disposed).toBe(true)
    expect(shellRegistrations(ctx).filter((entry) => !entry.disposed)).toHaveLength(0)
    // … and exactly one entry took its place
    expect(sidebar.registerTab).toHaveBeenCalledTimes(1)
  })

  it('late upgrade — native outranks a service that arrives later, and never double-registers', async () => {
    const ctx = createFakeContext()
    apply(ctx, { api: createFakeApi() })
    await vi.advanceTimersByTimeAsync(700)
    expect(tierOf(ctx)).toBe('standalone')

    const tabs = createFakeNativeTabs()
    const sidebar = createFakeSidebar()
    ctx.setService('sidebarRightTabs', tabs)
    ctx.setService('sidebarRight', createFakeNativeRight())
    ctx.setService('betterSidebar', sidebar)

    ctx.observers.find((entry) => entry.deps[0] === 'sidebarRightTabs')!.fire()
    expect(tierOf(ctx)).toBe('native')
    expect(shellRegistrations(ctx).filter((entry) => !entry.disposed)).toHaveLength(0)

    // the service observer firing afterwards must not downgrade or re-register
    ctx.observers.find((entry) => entry.deps[0] === 'betterSidebar')!.fire()
    expect(tierOf(ctx)).toBe('native')
    expect(sidebar.registerTab).not.toHaveBeenCalled()
    expect(tabs.register).toHaveBeenCalledTimes(1)
  })

  it('applying twice on the same context never throws "already registered"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tabs = createFakeNativeTabs()
    const ctx = createFakeContext({
      sidebarRightTabs: tabs,
      sidebarRight: createFakeNativeRight(),
    })

    expect(() => apply(ctx, { api: createFakeApi() })).not.toThrow()
    expect(() => apply(ctx, { api: createFakeApi() })).not.toThrow()

    expect(tabs.register).toHaveBeenCalledTimes(1)
    expect(paneRegistrations(ctx)).toHaveLength(1)

    // the guard is per context: a fresh context activates normally
    const otherTabs = createFakeNativeTabs()
    const otherCtx = createFakeContext({
      sidebarRightTabs: otherTabs,
      sidebarRight: createFakeNativeRight(),
    })
    apply(otherCtx, { api: createFakeApi() })
    expect(otherTabs.register).toHaveBeenCalledTimes(1)
    expect(tierOf(otherCtx)).toBe('native')

    warn.mockRestore()
  })

  it('exposes no tier and a safe no-op reveal before anything settles', () => {
    const ctx = createFakeContext()
    apply(ctx, { api: createFakeApi() })

    expect(tierOf({} as unknown)).toBeNull()
    expect(reveal({} as unknown)).toBeNull()
    expect(reveal(ctx)).toBeNull()
  })

  it('unloading the plugin (effect disposers) unregisters the tab — HMR clean', () => {
    const sidebar = createFakeSidebar()
    const ctx = createFakeContext({ betterSidebar: sidebar })

    apply(ctx, { api: createFakeApi() })
    expect(tierOf(ctx)).toBe('service')
    const registered = sidebar.tabDisposers[0]!
    expect(registered).not.toHaveBeenCalled()

    // what cordis does when the fiber unloads
    ctx.disposeEffects()

    expect(registered).toHaveBeenCalledTimes(1)
    expect(ctx.disposedEffects).toBeGreaterThan(0)
    expect(tierOf(ctx)).toBeNull()
    expect(reveal(ctx)).toBeNull()
  })

  it('the controller forwards reveal() only to a live host, and dispose() tears it down', () => {
    const ctx = createFakeContext()
    const reveals: string[] = []
    const disposals: string[] = []
    const stablePrefs = { ...DEFAULT_PREFS }
    const runtime: NotebookRuntime = {
      api: createFakeApi(),
      composer: createFakeComposer(),
      getPrefs: () => stablePrefs,
      setPrefs: () => {},
      subscribe: () => () => {},
    }

    const controller = createTierController({
      ctx,
      runtime,
      createHost: (tier): NotebookHost => ({
        tier,
        register: () => () => {
          disposals.push(tier)
        },
        reveal: () => {
          reveals.push(tier)
        },
      }),
    })

    controller.start()
    // nothing settled yet: reveal must not invent a host
    expect(controller.tier).toBeNull()
    controller.reveal()
    expect(reveals).toEqual([])

    vi.advanceTimersByTime(700)
    expect(controller.tier).toBe('standalone')
    controller.reveal()
    expect(reveals).toEqual(['standalone'])

    controller.dispose()
    expect(disposals).toEqual(['standalone'])
    expect(controller.tier).toBeNull()
    controller.reveal()
    controller.dispose()
    expect(reveals).toEqual(['standalone'])
    expect(disposals).toEqual(['standalone'])
  })
})

describe('mergePrefs', () => {
  it('applies only present keys and clamps the image cap', () => {
    const merged = mergePrefs(DEFAULT_PREFS, { maxImagesPerNote: 1000, sortOrder: 'title' })
    expect(merged.maxImagesPerNote).toBe(100)
    expect(merged.sortOrder).toBe('title')
    expect(merged.confirmDelete).toBe(DEFAULT_PREFS.confirmDelete)

    const lowered = mergePrefs(merged, { maxImagesPerNote: 0 })
    expect(lowered.maxImagesPerNote).toBe(1)

    const untouched = mergePrefs(merged, {})
    expect(untouched).toEqual(merged)

    // a nonsense value never leaks in
    const bogus = mergePrefs(merged, { maxImagesPerNote: Number.NaN as unknown as number })
    expect(bogus.maxImagesPerNote).toBe(merged.maxImagesPerNote)
  })
})
