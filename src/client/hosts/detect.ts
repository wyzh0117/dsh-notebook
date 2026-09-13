/**
 * Three-tier sidebar detection (spec §2.2) as a DOM-free, unit-testable core.
 *
 * `index.tsx` owns nothing but wiring: every decision about *which* carrier
 * wins, *when* the standalone fallback fires, and *how* a late-arriving service
 * upgrades the page lives here, so `test/tier-detect.test.ts` can drive the
 * whole flow with a fake context and no React tree at all.
 *
 * Priority is 1 > 2 > 3 (native > service > standalone). The page must never
 * show two Notebook entries, so a host is torn down *before* its successor
 * registers.
 */
import type {
  BetterSidebarLike,
  ClientContext,
  NotebookHost,
  NotebookRuntime,
  SidebarRightLike,
  SidebarRightTabsLike,
  SidebarTier,
} from './types'

/** How long we wait for a sidebar service before drawing our own (spec §2.2 step 3). */
export const FALLBACK_DELAY_MS = 700

/** Ascending rank: lower wins. Used to refuse downgrades and same-tier re-registration. */
export const TIER_RANK: Record<SidebarTier, number> = { native: 0, service: 1, standalone: 2 }

/** The sidebar services found on a context (any subset may be missing). */
export interface SidebarServices {
  tabs?: SidebarRightTabsLike
  right?: SidebarRightLike
  sidebar?: BetterSidebarLike
}

/** Service names probed for, in priority order. */
export const NATIVE_TABS_SERVICE = 'sidebarRightTabs'
export const NATIVE_RIGHT_SERVICE = 'sidebarRight'
export const SERVICE_SIDEBAR_SERVICE = 'betterSidebar'

/**
 * Read one service off the context.
 *
 * `ctx.get(name)` is tried first and the direct property second, each inside
 * its own try/catch: a cordis context under strict reflection *throws* on an
 * unprovided service property, and `ctx.get` is the documented safe read. The
 * fake context in the tests supports both shapes, so either order works there.
 */
export function lookupService<T>(ctx: ClientContext, name: string): T | undefined {
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (viaGet !== undefined && viaGet !== null) return viaGet as T
  } catch {
    // Strict reflection on an unprovided service: fall through to the property read.
  }
  try {
    const direct = (ctx as unknown as Record<string, unknown>)[name]
    if (direct !== undefined && direct !== null) return direct as T
  } catch {
    // Same as above: an absent service is simply absent.
  }
  return undefined
}

/** Probe every sidebar service we know how to adapt to. */
export function probeSidebarServices(ctx: ClientContext): SidebarServices {
  const services: SidebarServices = {}
  const tabs = lookupService<SidebarRightTabsLike>(ctx, NATIVE_TABS_SERVICE)
  if (tabs !== undefined) services.tabs = tabs
  const right = lookupService<SidebarRightLike>(ctx, NATIVE_RIGHT_SERVICE)
  if (right !== undefined) services.right = right
  const sidebar = lookupService<BetterSidebarLike>(ctx, SERVICE_SIDEBAR_SERVICE)
  if (sidebar !== undefined) services.sidebar = sidebar
  return services
}

/**
 * Synchronous tier probe: `'native'` when the DSH native right sidebar is
 * present, `'service'` when a compatible sidebar product is, `null` when the
 * standalone layer still has to be considered (the caller then arms the
 * fallback timer + late-arrival observers).
 */
export function detectTierSync(ctx: ClientContext): 'native' | 'service' | null {
  const services = probeSidebarServices(ctx)
  if (services.tabs !== undefined) return 'native'
  if (services.sidebar !== undefined) return 'service'
  return null
}

/**
 * Normalize a disposer-ish value into a plain function.
 *
 * `ctx.effect` and the fake context return disposer functions; `ctx.inject`
 * returns a cordis `Fiber` (disposed through `.dispose()`). Both must work, so
 * every registration helper accepts an `unknown` and adapts here.
 */
export function disposeOf(value: unknown): () => void {
  if (typeof value === 'function') return value as () => void
  if (value !== null && typeof value === 'object') {
    const candidate = (value as { dispose?: unknown }).dispose
    if (typeof candidate === 'function') {
      return () => {
        ;(candidate as () => unknown).call(value)
      }
    }
  }
  return () => {}
}

/**
 * `window.setTimeout` in the browser (there `window === globalThis`) and the
 * plain node timer under vitest's `environment: 'node'` + fake timers — the
 * controller has to stay testable without a DOM.
 */
type TimerHandle = ReturnType<typeof globalThis.setTimeout>

function scheduleTimeout(fn: () => void, ms: number): TimerHandle {
  return globalThis.setTimeout(fn, ms)
}

function cancelTimeout(handle: TimerHandle): void {
  globalThis.clearTimeout(handle)
}

/** Options of {@link createTierController}. */
export interface TierControllerOptions {
  ctx: ClientContext
  runtime: NotebookRuntime
  /** Build the host for a tier; return `null` when that tier cannot be served after all. */
  createHost(tier: SidebarTier, services: SidebarServices): NotebookHost | null
  /** Overridable for tests; defaults to {@link FALLBACK_DELAY_MS}. */
  fallbackDelayMs?: number
  /** Observability hook ("which tier did we settle on"), used by `index.tsx` for `openOnStart`. */
  onTierChange?(tier: SidebarTier | null): void
}

export interface TierController {
  /** The settled tier, or `null` while still probing / after disposal. */
  readonly tier: SidebarTier | null
  /** Probe and register. Idempotent. */
  start(): void
  /** Show Notebook to the user (no-op before a host exists). */
  reveal(): void
  /** Tear everything down (timer, observers, host). Idempotent. */
  dispose(): void
}

/**
 * Drive the three-tier registration for one activation.
 *
 * Registration only ever happens inside `ctx.effect(...)` bodies (the fallback
 * timer effect here, plus the per-host effects and the outer lifecycle effect
 * in `index.tsx`), so HMR/unload is clean and a reactivation can never hit
 * "already registered".
 */
export function createTierController(options: TierControllerOptions): TierController {
  const { ctx, runtime } = options
  const fallbackDelayMs = options.fallbackDelayMs ?? FALLBACK_DELAY_MS

  let settled: SidebarTier | null = null
  let host: NotebookHost | null = null
  let hostDispose: (() => void) | null = null
  let timerDispose: (() => void) | null = null
  let started = false
  let disposed = false
  const observerDisposers: Array<() => void> = []

  function report(tier: SidebarTier | null): void {
    try {
      options.onTierChange?.(tier)
    } catch (error) {
      console.warn('[dsh-notebook] onTierChange handler failed:', error)
    }
  }

  /** Remove the current host *before* anything else registers (one entry, always). */
  function teardownHost(): void {
    const dispose = hostDispose
    hostDispose = null
    host = null
    settled = null
    if (dispose === null) return
    try {
      dispose()
    } catch (error) {
      console.warn('[dsh-notebook] host dispose failed:', error)
    }
  }

  function stopFallbackTimer(): void {
    const dispose = timerDispose
    timerDispose = null
    if (dispose === null) return
    try {
      dispose()
    } catch (error) {
      console.warn('[dsh-notebook] fallback timer cleanup failed:', error)
    }
  }

  function activate(tier: SidebarTier, services: SidebarServices): void {
    if (disposed) return
    // Never downgrade, and never re-register the same tier (repeated inject
    // callbacks must not throw "already registered").
    if (settled !== null && TIER_RANK[tier] >= TIER_RANK[settled]) return
    const next = options.createHost(tier, services)
    if (next === null) return
    // Late upgrade (standalone → service/native): the old host goes away first,
    // so the page never carries two Notebook entries at once.
    teardownHost()
    try {
      const dispose = next.register(runtime)
      host = next
      hostDispose = typeof dispose === 'function' ? dispose : null
      settled = tier
    } catch (error) {
      console.error(`[dsh-notebook] ${tier} host registration failed:`, error)
      host = null
      hostDispose = null
      settled = null
      return
    }
    if (tier !== 'standalone') stopFallbackTimer()
    report(tier)
  }

  /** A service appeared after `apply()` ran: upgrade if it outranks what we have. */
  function upgrade(tier: SidebarTier): void {
    if (disposed) return
    const services = probeSidebarServices(ctx)
    if (tier === 'native' && services.tabs === undefined) return
    if (tier === 'service' && services.sidebar === undefined) return
    activate(tier, services)
  }

  function start(): void {
    if (started || disposed) return
    started = true

    const services = probeSidebarServices(ctx)
    if (services.tabs !== undefined) {
      activate('native', services)
      // A native host whose registration threw leaves `settled` null: fall
      // through and arm the observers + fallback rather than leaving no entry.
      if (settled !== null) return
    }
    if (services.sidebar !== undefined) {
      activate('service', services)
      if (settled !== null) return
    }

    // Nothing yet: watch for both services (either may arrive later) and race
    // them against the fallback timer that draws our own sidebar.
    try {
      observerDisposers.push(disposeOf(ctx.inject([NATIVE_TABS_SERVICE], () => upgrade('native'))))
      observerDisposers.push(disposeOf(ctx.inject([SERVICE_SIDEBAR_SERVICE], () => upgrade('service'))))
    } catch (error) {
      console.warn('[dsh-notebook] failed to observe sidebar services:', error)
    }

    try {
      timerDispose = disposeOf(
        ctx.effect(() => {
          const handle = scheduleTimeout(() => {
            if (disposed || settled !== null) return
            activate('standalone', probeSidebarServices(ctx))
          }, fallbackDelayMs)
          return () => cancelTimeout(handle)
        }, 'dsh-notebook:sidebar-tier-fallback'),
      )
    } catch (error) {
      console.warn('[dsh-notebook] failed to arm the sidebar fallback:', error)
    }
  }

  function reveal(): void {
    if (disposed) return
    const current = host
    if (current === null) return
    try {
      current.reveal()
    } catch (error) {
      console.warn('[dsh-notebook] reveal failed:', error)
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    for (const off of observerDisposers.splice(0)) {
      try {
        off()
      } catch {
        // an observer that already went away is fine
      }
    }
    stopFallbackTimer()
    teardownHost()
    report(null)
  }

  return {
    get tier() {
      return settled
    },
    start,
    reveal,
    dispose,
  }
}
