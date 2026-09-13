/**
 * dsh-notebook — client half entry.
 *
 * This module becomes the body of the CJS closure factory the DSH client hands
 * to `window.__ModuleLoader__` (`lib/client.js`), so:
 * - nothing happens at module scope except a `WeakMap` allocation;
 * - there is no `node:*` import and no `@deepseek-ai/*` value import — React
 *   resolves through the module table, everything else is inlined by tsdown;
 * - `inject` lists only services that ALWAYS exist. Declaring `betterSidebar`
 *   here would mean the plugin never activates without a sidebar product, and
 *   tier 3 (standalone) would never get a chance (spec §2.2).
 *
 * The activation itself is a three-tier probe (spec §2.2): native right sidebar
 * → compatible sidebar service → our own shell.
 */
import { attachLocale } from './locales'
import { createNotebookApi, type NotebookApiClient } from './api'
import { DEFAULT_PREFS, type NotebookPrefs } from '../shared/types'
import {
  createTierController,
  type SidebarServices,
  type TierController,
} from './hosts/detect'
import { createNativeHost } from './hosts/native'
import { createServiceHost } from './hosts/service'
import { createStandaloneHost } from './hosts/standalone'
import type { ClientContext, NotebookHost, NotebookRuntime, SidebarTier } from './hosts/types'

/**
 * Core services only — never a sidebar service (see the file header).
 */
export const inject = ['slots', 'locale']

interface Activation {
  controller: TierController | null
}

/**
 * One activation per context. Also the guard that makes a second `apply(ctx)`
 * a no-op instead of a cascade of "already registered" throws.
 */
const activations = new WeakMap<object, Activation>()

function activationOf(ctx: unknown): Activation | null {
  if (ctx === null || typeof ctx !== 'object') return null
  return activations.get(ctx) ?? null
}

/** Which tier the live activation settled on (`null` while probing, or with no activation). */
export function tierOf(ctx: unknown): SidebarTier | null {
  return activationOf(ctx)?.controller?.tier ?? null
}

/**
 * Show Notebook to the user: expand the sidebar and activate the tab.
 * User-activation only — startup never calls this unless the standalone tier is
 * in charge and `prefs.openOnStart` is on (spec §2.2 / brief).
 *
 * @returns the settled tier, or `null` when there is nothing to reveal yet.
 */
export function reveal(ctx: unknown): SidebarTier | null {
  const controller = activationOf(ctx)?.controller ?? null
  if (controller === null) return null
  controller.reveal()
  return controller.tier
}

/** Clamp/validate one preference patch; only keys actually present are applied. */
export function mergePrefs(base: NotebookPrefs, patch: Partial<NotebookPrefs>): NotebookPrefs {
  const next: NotebookPrefs = { ...base }
  if (patch.sortOrder === 'updated' || patch.sortOrder === 'created' || patch.sortOrder === 'title') {
    next.sortOrder = patch.sortOrder
  }
  if (patch.copyImagesAsName !== undefined) next.copyImagesAsName = patch.copyImagesAsName === true
  if (patch.maxImagesPerNote !== undefined) {
    const value = Math.round(Number(patch.maxImagesPerNote))
    next.maxImagesPerNote = Number.isFinite(value) ? Math.min(100, Math.max(1, value)) : base.maxImagesPerNote
  }
  if (patch.confirmDelete !== undefined) next.confirmDelete = patch.confirmDelete === true
  if (patch.openOnStart !== undefined) next.openOnStart = patch.openOnStart === true
  return next
}

/**
 * Plugin entry point.
 *
 * @param options.api injected for tests — production always builds the real client.
 */
export function apply(ctx: ClientContext, options?: { api?: NotebookApiClient }): void {
  if (ctx === null || typeof ctx !== 'object') {
    console.warn('[dsh-notebook] apply() called without a client context; ignoring')
    return
  }
  // Reserve the slot first: a second activation of the same context is always a
  // no-op, whatever happens inside the first one.
  if (activations.has(ctx)) {
    console.warn('[dsh-notebook] apply() called twice on the same context; ignoring the second call')
    return
  }
  const record: Activation = { controller: null }
  activations.set(ctx, record)

  try {
    activate(ctx, record, options)
  } catch (error) {
    // Nothing may escape `apply`: a client plugin that throws takes the whole
    // boot down with it.
    console.error('[dsh-notebook] activation failed:', error)
  }
}

function activate(ctx: ClientContext, record: Activation, options?: { api?: NotebookApiClient }): void {
  // ── i18n: attach first, every string below goes through t() ───────────────
  // `attachLocale` publishes both dictionaries into the DSH locale service and
  // disposes the previous binding on re-activation, so it is called inside an
  // effect and nothing else registers the dictionaries here (double registration
  // would stack them across HMR).
  try {
    ctx.effect(() => {
      attachLocale(ctx.locale)
    }, 'dsh-notebook:locales')
  } catch (error) {
    console.warn('[dsh-notebook] locale registration effect failed:', error)
    try {
      attachLocale(ctx.locale)
    } catch (inner) {
      console.warn('[dsh-notebook] attachLocale failed:', inner)
    }
  }

  // ── the per-activation runtime (never a module singleton) ────────────────
  const api: NotebookApiClient = options?.api ?? createNotebookApi()
  let prefs: NotebookPrefs = { ...DEFAULT_PREFS }
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }

  const runtime: NotebookRuntime = {
    api,
    // Stable object identity between changes: safe as a useSyncExternalStore snapshot.
    getPrefs: () => prefs,
    setPrefs(patch: Partial<NotebookPrefs>): void {
      // Optimistic local write first (the UI must never lag a click), then the
      // host document — the single source of truth across all three tiers.
      prefs = mergePrefs(prefs, patch)
      notify()
      void Promise.resolve()
        .then(() => api.updatePrefs(patch))
        .then((server) => {
          if (server !== null && typeof server === 'object') {
            prefs = mergePrefs(prefs, server)
            notify()
          }
        })
        .catch((error: unknown) => {
          console.warn('[dsh-notebook] failed to persist preferences:', error)
        })
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }

  // ── three-tier registration ──────────────────────────────────────────────
  const hostFor = (tier: SidebarTier, services: SidebarServices): NotebookHost | null => {
    if (tier === 'native') {
      const tabs = services.tabs
      if (tabs === undefined) return null
      return services.right !== undefined
        ? createNativeHost(ctx, { tabs, right: services.right })
        : createNativeHost(ctx, { tabs })
    }
    if (tier === 'service') {
      const sidebar = services.sidebar
      if (sidebar === undefined) return null
      return createServiceHost(ctx, sidebar)
    }
    return createStandaloneHost(ctx)
  }

  const controller = createTierController({
    ctx,
    runtime,
    createHost: hostFor,
    onTierChange: (tier) => {
      // Startup auto-open is a tier-3-only convenience (spec §5, openOnStart).
      if (tier === 'standalone' && prefs.openOnStart) controller.reveal()
    },
  })
  record.controller = controller

  try {
    ctx.effect(
      () => {
        controller.start()
        return () => controller.dispose()
      },
      'dsh-notebook:sidebar-tier',
    )
  } catch (error) {
    console.warn('[dsh-notebook] tier effect registration failed; activating inline:', error)
    controller.start()
  }

  // ── preferences bootstrap: one state read, defaults on failure ───────────
  void Promise.resolve()
    .then(() => api.getState())
    .then((state) => {
      const loaded = state?.doc?.prefs
      if (loaded !== null && typeof loaded === 'object') {
        prefs = mergePrefs(prefs, loaded)
        notify()
      }
      if (prefs.openOnStart && record.controller?.tier === 'standalone') record.controller.reveal()
    })
    .catch((error: unknown) => {
      console.warn('[dsh-notebook] initial state load failed; keeping defaults:', error)
    })
}
