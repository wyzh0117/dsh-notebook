/**
 * Structural (duck-typed) faces for the client half of dsh-notebook.
 *
 * Why structure instead of the real DSH types: the client bundle is a CJS
 * closure factory handed to `window.__ModuleLoader__` (see the "Development"
 * section of the README), and every DSH package is a **peer** — the shell
 * resolves the module-table entries, the plugin never does. Reaching for
 * `@deepseek-ai/dsh-client-ui-sidebar-right`'s own types would therefore buy a
 * compile-time dependency the runtime cannot honour, and would break the moment
 * a host ships a different version. Declaring only the members we actually
 * touch keeps the bundle free of `@deepseek-ai/*` value imports (verified
 * against DSH 0.1.5-rc.2's published declarations) and lets
 * `test/tier-detect.test.ts` drive the whole activation with a fake context.
 *
 * The `*Like` faces are also deliberately NOT imported from `dsh-better-sidebar`:
 * we refuse to build a compile-time dependency on another third-party plugin
 * (its package is an optional peer, imported only as documentation).
 */
import type { NotebookApiClient } from '../api'
import type { NotebookComposer } from '../composer'
import type { NotebookPrefs } from '../../shared/types'

/** Which registration tier the current host settled on (spec §2.1). */
export type SidebarTier = 'native' | 'service' | 'standalone'

/**
 * The per-activation runtime handed to whichever host wins the tier probe.
 * One instance per `apply()` call — never a module-level singleton.
 */
export interface NotebookRuntime {
  api: NotebookApiClient
  /**
   * The composer bridge (attach images / append draft text / insert an `@`
   * reference). Every tier passes it to the note list, so the list itself never
   * touches DSH services.
   */
  composer: NotebookComposer
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

/** The cell kind of each slot this plugin contributes to, as the shell declares it. */
export type KeyedSlotName = 'sidebar.right.pane.tab'
export type ListSlotName = 'shell.overlay' | 'settings.section'

/**
 * Registration options accepted by `ctx.slots.register` (the subset in use).
 *
 * Modelled as a UNION over the slot name because the real registry validates
 * the descriptor against the target slot's declared kind at load time and
 * throws on a mismatch: a **keyed** slot addresses its entries by `key` and a
 * registration without one throws; a **list** slot addresses them by `id` and
 * sorts them by `order`. `name` alone is not enough to go on — the same
 * `{ id, order }` that is correct for `shell.overlay` is a *failed
 * registration* on the keyed `sidebar.right.pane.tab`, and the sidebar's answer
 * is a Notebook tab that can never render rather than an error anyone can see.
 *
 * Discriminating on `name` keeps that mistake a compile error here.
 */
export type SlotRegisterOptions =
  /** Keyed: dispatched by the `id` of the type in force, registered under `key`. */
  | {
      name: KeyedSlotName
      key: string
      /** Cell shadowing rank (ascending, default 0). */
      priority?: number
      inject?: (...args: never[]) => Record<string, unknown>
    }
  /** List: one row per `id`, shown in ascending `order`. */
  | {
      name: ListSlotName
      id: string
      order?: number
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
  /**
   * Bail-mode event dispatch (`actx.bail(actx, name, payload)`), the plumbing
   * behind the conversation input machine's scoped mutation events. Optional:
   * a context without it simply cannot receive programmatic composer edits.
   */
  bail?(thisArg: unknown, name: string, payload: unknown): unknown
}
