/**
 * tier 1 — native right sidebar registration (DSH ≥ 0.1.5-rc.1, the shape the
 * better-sidebar README's IMPORTANT section points at).
 *
 * Native registration is TWO-PHASE (see
 * `dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts`):
 *   1. the tab *type* goes into `ctx.sidebarRightTabs.register({ id, kind, … })`
 *      (`kind` is what `openTab` takes, `id` is our identity; both are the same
 *      string here), with a `guide` entry for the "new tab" list;
 *   2. the tab *body* goes into the keyed slot `sidebar.right.pane.tab`, keyed by
 *      the same `id`.
 *
 * The local machine runs DSH 0.1.1-rc.2, which has no right sidebar package at
 * all, so this tier is written against the type declarations and covered only at
 * the "registration call sequence" level (`test/tier-detect.test.ts` with a fake
 * context) — exactly as the spec allows (spec §2.3 warning box).
 */
import { createElement, useSyncExternalStore } from 'react'
import { NotebookView } from '../NotebookView'
import { NotebookGlyph } from '../icons'
import { t } from '../locales'
import { disposeOf } from './detect'
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
 * The tab body. Props come from the native sidebar and differ across DSH
 * versions, so every read is defensive: `props.tab.visible` (0.1.5-rc.2 shape),
 * then a bare `props.visible`, then "assume visible".
 */
function createTabBody(runtime: NotebookRuntime): (props: unknown) => unknown {
  return function NotebookNativeTabBody(props: unknown): unknown {
    const raw = (props ?? {}) as { tab?: { visible?: unknown }; visible?: unknown }
    const tabVisible = raw.tab?.visible
    const visible = (typeof tabVisible === 'boolean' ? tabVisible : raw.visible) !== false
    const prefs = useSyncExternalStore(runtime.subscribe, runtime.getPrefs)
    return createElement(NotebookView, {
      api: runtime.api,
      prefs,
      onPrefsChange: (patch) => runtime.setPrefs(patch),
      visible,
    })
  }
}

export function createNativeHost(ctx: ClientContext, services: NativeHostServices): NotebookHost {
  const { tabs, right } = services

  return {
    tier: 'native',

    register(runtime: NotebookRuntime): () => void {
      const disposers: Array<() => void> = []

      // Phase 1 — the tab type. `ctx.effect` keeps the registration bound to the
      // plugin fiber so HMR/unload removes it (spec §2.2 step 5).
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

      // Phase 2 — the tab body, in the keyed `sidebar.right.pane.tab` slot.
      disposers.push(
        disposeOf(
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              { name: 'sidebar.right.pane.tab', id: NATIVE_TAB_ID, order: 0 },
              createTabBody(runtime),
            ),
          ),
        ),
      )

      let released = false
      return () => {
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
