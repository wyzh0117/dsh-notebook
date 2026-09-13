/**
 * Structural (duck-typed) faces for the client half of dsh-notebook.
 *
 * Why structure instead of the real DSH types: the client bundle is a CJS
 * closure factory handed to `window.__ModuleLoader__` (see
 * `.briefs/00-context.md`), and this machine runs DSH 0.1.1-rc.2 — the newer
 * packages (`@deepseek-ai/dsh-client-ui-sidebar-right`) do not resolve locally.
 * Declaring only the members we actually touch keeps the bundle free of
 * `@deepseek-ai/*` value imports and lets `test/tier-detect.test.ts` drive the
 * whole activation with a fake context.
 *
 * The `*Like` faces are also deliberately NOT imported from `dsh-better-sidebar`:
 * we refuse to build a compile-time dependency on another third-party plugin
 * (its package is an optional peer, imported only as documentation).
 */
import type { NotebookApiClient } from '../api'
import type { NotebookPrefs } from '../../shared/types'

/** Which registration tier the current host settled on (spec §2.1). */
export type SidebarTier = 'native' | 'service' | 'standalone'

/**
 * The per-activation runtime handed to whichever host wins the tier probe.
 * One instance per `apply()` call — never a module-level singleton.
 */
export interface NotebookRuntime {
  api: NotebookApiClient
  /** Current preferences. Stable reference between changes (safe as a `useSyncExternalStore` snapshot). */
  getPrefs(): NotebookPrefs
  /** Optimistically apply a patch locally, then persist it through the host API. */
  setPrefs(patch: Partial<NotebookPrefs>): void
  /** Subscribe to preference changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
}

/** One sidebar carrier. Each tier implements exactly one. */
export interface NotebookHost {
  readonly tier: SidebarTier
  /** Register the Notebook page; returns the disposer that removes it again. */
  register(runtime: NotebookRuntime): () => void
  /** Make the user see Notebook (expand the sidebar and activate it). */
  reveal(): void
}

/** `dsh-better-sidebar`'s `TabDescriptor`, reduced to the fields we fill in. */
export interface TabDescriptorLike {
  id: string
  title: string | (() => string)
  description?: string | (() => string)
  icon?: unknown
  order?: number
  /** Single-instance sugar: `true` ≡ `dedupeKey: () => id` (focus instead of re-open). */
  single?: boolean
  hidden?: boolean
  component: (props: any) => unknown
  settings?: unknown
}

/** `ctx.betterSidebar` (better-sidebar 0.4.0–0.18.x and compatible products). */
export interface BetterSidebarLike {
  registerTab(descriptor: TabDescriptorLike): () => void
  openTab?(seed: { type: string; title: string; id?: string }): void
  /** Monotonic capability list (v0.12.0+); used only as a version gate, never required. */
  features?: readonly string[]
  getTab?(id: string): TabDescriptorLike | undefined
}

/** `ctx.sidebarRightTabs` — the native right sidebar's tab *type* registry (DSH ≥ 0.1.5-rc.1). */
export interface SidebarRightTabsLike {
  register(def: {
    id: string
    kind: string
    priority?: string
    title: (address: string) => string
    guide?: readonly { order: number; title: () => string; description?: () => string; icon?: unknown }[]
  }): () => void
}

/** `ctx.sidebarRight` — the native right sidebar itself. */
export interface SidebarRightLike {
  openTab(kind: string, options?: unknown): void
  toggleExpanded(): void
  isExpanded(): boolean
}

/** Registration options accepted by `ctx.slots.register` (subset of the real options). */
export interface SlotRegisterOptions {
  name: string
  id: string
  order?: number
  /** Chain/cell rank; only used through the `name`/`id`/`order` triple here. */
  priority?: number
  /** Section heading (used by the `settings.section` seat). */
  label?: string | (() => string)
  inject?: (...args: never[]) => Record<string, unknown>
}

/** The DSH client slot registry face we consume (`register` returns the disposer). */
export interface SlotsLike {
  register(options: SlotRegisterOptions, component: unknown): () => void
  /**
   * Run `callback` only once the named slot is declared; a slot nobody
   * declared is a silent no-op (never an error). Returns the disposer.
   */
  inject(key: string, callback: () => () => void): () => void
}

/** The DSH locale service face (matches `./locales`'s frozen `LocaleLike`). */
export interface LocaleLike {
  register(namespace: string, language: string, dictionary: Record<string, string>): () => void
  get?(): string
}

/** Effect body: returns the disposer (or nothing). */
export type EffectCallback = () => (() => void) | void

/**
 * The client context, reduced to the members this plugin actually uses.
 *
 * `inject` is typed loosely on purpose: cordis returns a `Fiber` (which is not
 * a disposer function), while the test's fake context returns a plain
 * disposer — `disposeOf()` in `detect.ts` normalizes both.
 */
export interface ClientContext {
  readonly slots: SlotsLike
  readonly locale: LocaleLike
  effect(callback: EffectCallback, label?: string): unknown
  get(name: string, strict?: boolean): unknown
  inject(deps: readonly string[], callback: (ctx: ClientContext) => unknown): unknown
}
