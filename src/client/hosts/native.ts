/**
 * tier 1 — native right sidebar registration (DSH ≥ 0.1.5-rc.1, the shape the
 * better-sidebar README's IMPORTANT section points at).
 *
 * Native registration is TWO-PHASE (see
 * `dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts`):
 *   1. the tab *body* goes into the **keyed** slot `sidebar.right.pane.tab`
 *      under `key` — the seat dispatches a tab to the entry keyed by the `id`
 *      of the type in force for its `kind`, so `key` is our identity here;
 *   2. the tab *type* goes into `ctx.sidebarRightTabs.register({ id, kind, … })`
 *      (`kind` is what `openTab` takes, `id` is our identity; both are the same
 *      string here), with a `guide` entry for the "new tab" list.
 *
 * The two are registered body-first and torn down together: a type whose body
 * is missing still shows a Notebook tab and answers "nothing here can view this
 * kind of content yet", which hides the cause instead of reporting it.
 *
 * Two further registrations belong to this tier because nothing else provides
 * them here: the global settings seat (`settings.section`, `settingsSeat.ts`)
 * and the new-session auto-open watcher (`autoOpen.ts`). The service tier keeps
 * its own settings page; the standalone tier registers the same seat through
 * the same helper.
 *
 * Verified live on DSH 0.1.5-rc.2 (the tier that wins whenever
 * `dsh-client-ui-sidebar-right` is mounted); `test/tier-detect.test.ts` drives
 * the registration sequence against a fake context that enforces the keyed-slot
 * constraint, so a list-shaped (`id`/`order`) registration fails there too.
 */
import { createElement, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { NotebookView } from '../NotebookView'
import { NotebookGlyph } from '../icons'
import { t } from '../locales'
import { attachAutoOpen } from './autoOpen'
import { disposeOf } from './detect'
import { registerSettingsSection } from './settingsSeat'
import type {
  ClientContext,
  NotebookHost,
  NotebookRuntime,
  SidebarRightLike,
  SidebarRightTabsLike,
} from './types'

/** Identity of our tab: the `kind` discriminant AND the `sidebar.right.pane.tab` slot key. */
export const NATIVE_TAB_ID = 'dsh-notebook'

/** Bottom-ish of the extension band — external plugins default here (spec §2.3). */
export const NATIVE_TAB_ORDER = 60

export interface NativeHostServices {
  tabs: SidebarRightTabsLike
  right?: SidebarRightLike
}

/**
 * The props a native tab body can receive. The slot declares its information
 * hook under `inject.hooks.tabInfo`, so DSH hands it over as `useTabInfo`; the
 * plain `tab`/`visible` members only ever existed in older shapes.
 */
interface NativeTabProps {
  useTabInfo?: () => { tab?: { visible?: unknown } } | undefined
  tab?: { visible?: unknown }
  visible?: unknown
}

/**
 * The tab body.
 *
 * Visibility matters: a hidden tab must not hit the host (`NotebookView` skips
 * loading and polling while `visible === false`). On DSH 0.1.5-rc.2 the seat
 * renders a tab as `renderSlot(seat, {}, …)` — an EMPTY owner share — so
 * `tab.visible` never arrives as a plain prop and only the injected
 * `useTabInfo()` hook knows it. The hook may only be called from a component,
 * and calling it conditionally inside one component would break the rules of
 * hooks, so the choice is made once, outside: an information-hook body or a
 * plain-props body, each with a stable hook order.
 */
function createTabBody(runtime: NotebookRuntime): (props: unknown) => unknown {
  /** Shared render: one `useSyncExternalStore` read, whichever branch got here. */
  function body(visible: unknown): ReactNode {
    const prefs = useSyncExternalStore(runtime.subscribe, runtime.getPrefs)
    return createElement(NotebookView, {
      api: runtime.api,
      prefs,
      onPrefsChange: (patch) => runtime.setPrefs(patch),
      composer: runtime.composer,
      visible: visible !== false,
    })
  }

  function NotebookTabBodyWithInfo(props: NativeTabProps): ReactNode {
    const info = props.useTabInfo?.()
    return body(info?.tab?.visible ?? props.tab?.visible ?? props.visible)
  }

  function NotebookTabBody(props: NativeTabProps): ReactNode {
    return body(props.tab?.visible ?? props.visible)
  }

  return function NotebookNativeTabBody(props: unknown): unknown {
    const raw = (props ?? {}) as NativeTabProps
    return typeof raw.useTabInfo === 'function'
      ? createElement(NotebookTabBodyWithInfo, raw)
      : createElement(NotebookTabBody, raw)
  }
}

export function createNativeHost(ctx: ClientContext, services: NativeHostServices): NotebookHost {
  const { tabs, right } = services

  return {
    tier: 'native',

    register(runtime: NotebookRuntime): () => void {
      const disposers: Array<() => void> = []
      let released = false

      /** Undo every registration made so far, newest first. Idempotent. */
      const release = (): void => {
        if (released) return
        released = true
        for (const off of disposers.reverse()) {
          try {
            off()
          } catch (error) {
            console.warn('[dsh-notebook] native registration dispose failed:', error)
          }
        }
      }

      /**
       * Best-effort extra registrations (the settings seat, the new-session
       * watcher): the tab is the essential part of this tier, so an optional
       * seat that throws must not take the whole tier down with it.
       */
      const optional = (label: string, register: () => () => void): void => {
        try {
          disposers.push(register())
        } catch (error) {
          console.warn(`[dsh-notebook] ${label} registration failed (the tab stays):`, error)
        }
      }

      try {
        // Phase 1 — the tab BODY, in the keyed `sidebar.right.pane.tab` slot.
        //
        // A keyed slot addresses its entries by `key` and a registration
        // without one THROWS, so `{ id, order }` — the LIST shape — is not a
        // near miss here, it is a failed registration. The body also goes in
        // BEFORE the type on purpose: a type whose body never registered still
        // draws a Notebook tab, and opening it answers "nothing here can view
        // this kind of content yet" instead of failing where the cause is
        // visible.
        disposers.push(
          disposeOf(
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register(
                { name: 'sidebar.right.pane.tab', key: NATIVE_TAB_ID },
                createTabBody(runtime),
              ),
            ),
          ),
        )

        // Phase 2 — the tab type, plus the guide entry the "new tab" list
        // shows. `ctx.effect` keeps the registration bound to the plugin fiber
        // so HMR/unload removes it (spec §2.2 step 5).
        disposers.push(
          disposeOf(
            ctx.effect(
              () =>
                tabs.register({
                  id: NATIVE_TAB_ID,
                  kind: NATIVE_TAB_ID,
                  priority: 'extension',
                  title: () => t('title'),
                  guide: [
                    {
                      order: NATIVE_TAB_ORDER,
                      title: () => t('title'),
                      description: () => t('description'),
                      icon: NotebookGlyph,
                    },
                  ],
                }),
              'dsh-notebook:native-tab-type',
            ),
          ),
        )

        // Phase 3 — the global settings seat. The native sidebar has no per-tab
        // settings page, so this is the only place a user can flip
        // `autoOpenOnNewSession` (and the other preferences) in this tier.
        optional('settings seat', () => registerSettingsSection(ctx, runtime))

        // Phase 4 — "open the notebook for a new session": watch the session
        // list and open the tab whenever a new session becomes current, only
        // while the preference is on. Inert without `ctx.sessions` or a
        // navigation controller.
        optional('auto-open watcher', () =>
          disposeOf(
            ctx.effect(
              () => attachAutoOpen(ctx, runtime, right, NATIVE_TAB_ID),
              'dsh-notebook:auto-open-on-new-session',
            ),
          ),
        )
      } catch (error) {
        // A half-registered tier would leave the sidebar showing a Notebook
        // that cannot render, so a failed phase never survives its sibling.
        release()
        throw error
      }

      return release
    },

    reveal(): void {
      // `sidebarRight.openTab` can throw on an unknown kind (a version skew with
      // the tab registry) — a failed reveal must never break the caller.
      try {
        right?.openTab(NATIVE_TAB_ID)
      } catch (error) {
        console.warn('[dsh-notebook] native openTab failed:', error)
      }
      // An open tab nobody can see is not revealed: expand the sidebar when it
      // is collapsed.
      try {
        if (right !== undefined && typeof right.isExpanded === 'function' && !right.isExpanded()) {
          right.toggleExpanded()
        }
      } catch (error) {
        console.warn('[dsh-notebook] native toggleExpanded failed:', error)
      }
    },
  }
}
