/**
 * tier 2 — registration into a compatible sidebar product's service
 * (`ctx.betterSidebar`, better-sidebar 0.4.0–0.18.x and any product exposing the
 * same `registerTab` face).
 *
 * Two rules this file exists to honour:
 * - our tab id is `dsh-notebook:notebook` — the reserved ids (`editor`, `git`,
 *   `subagent`, `sidechat`, `terminal`, `browser`, `diff`) stay untouched;
 * - preferences are NOT stored in the sidebar's own `pluginSettings` blob.
 *   `NotebookDoc.prefs` (host-persisted) is the single source of truth across
 *   all three tiers, so every edit here lands in `runtime.setPrefs()` and
 *   nothing else (spec §5).
 */
import { createElement, useSyncExternalStore } from 'react'
import { NotebookSettingsPanel } from '../NotebookSettingsPanel'
import { NotebookView } from '../NotebookView'
import { NotebookGlyph } from '../icons'
import { t } from '../locales'
import { disposeOf } from './detect'
import type { BetterSidebarLike, ClientContext, NotebookHost, NotebookRuntime } from './types'

/** Our tab type id. Namespaced so it can never collide with a builtin. */
export const SERVICE_TAB_ID = 'dsh-notebook:notebook'

/** Bottom-ish of the extension band (spec §2.4). */
export const SERVICE_TAB_ORDER = 60

/**
 * The four preferences exposed as declarative rows (spec §5). They are declared
 * so the sidebar's settings page can inventory them; the actual read/write path
 * is `settings.render` → `<NotebookSettingsPanel>` → `runtime.setPrefs`, because
 * the sidebar's own `pluginToggles` store would fork the truth away from
 * `NotebookDoc.prefs`.
 */
export function buildPluginToggles(): ReadonlyArray<Record<string, unknown>> {
  return [
    {
      key: 'sortOrder',
      title: () => t('settingsSortOrder'),
      desc: () => t('settingsSortOrderDesc'),
      type: 'select',
      options: [
        { value: 'updated', label: () => t('settingsSortUpdated') },
        { value: 'created', label: () => t('settingsSortCreated') },
        { value: 'title', label: () => t('settingsSortTitle') },
      ],
    },
    {
      key: 'copyImagesAsName',
      title: () => t('settingsCopyImages'),
      desc: () => t('settingsCopyImagesDesc'),
      type: 'switch',
    },
    {
      key: 'maxImagesPerNote',
      title: () => t('settingsMaxImages'),
      desc: () => t('settingsMaxImagesDesc'),
      type: 'number',
      min: 1,
      max: 100,
    },
    {
      key: 'confirmDelete',
      title: () => t('settingsConfirmDelete'),
      desc: () => t('settingsConfirmDeleteDesc'),
      type: 'switch',
    },
  ]
}

/** The live tab body: preferences come from the shared runtime, never from the sidebar. */
function createTabComponent(runtime: NotebookRuntime): (props: unknown) => unknown {
  return function NotebookServiceTab(props: unknown): unknown {
    const raw = (props ?? {}) as { visible?: unknown }
    const visible = raw.visible !== false
    const prefs = useSyncExternalStore(runtime.subscribe, runtime.getPrefs)
    return createElement(NotebookView, {
      api: runtime.api,
      prefs,
      onPrefsChange: (patch) => runtime.setPrefs(patch),
      visible,
    })
  }
}

/** The custom settings panel bridging the host document prefs into the sidebar's settings page. */
function createSettingsRender(runtime: NotebookRuntime): (props: unknown) => unknown {
  return function NotebookServiceSettings(): unknown {
    const prefs = useSyncExternalStore(runtime.subscribe, runtime.getPrefs)
    return createElement(NotebookSettingsPanel, {
      prefs,
      onChange: (patch) => runtime.setPrefs(patch),
    })
  }
}

/**
 * The declarative settings declaration.
 *
 * `pluginToggles` is always declared (it is the inventory). `render` is gated on
 * the `pluginSettings` capability *only when the service advertises a capability
 * list at all*: better-sidebar ≤ 0.11.x has no `features` array and will simply
 * ignore an unknown key, whereas a service that lists its capabilities and omits
 * `pluginSettings` would not render it. No capability is ever required.
 */
function buildSettings(runtime: NotebookRuntime, service: BetterSidebarLike): unknown {
  const settings: Record<string, unknown> = { pluginToggles: buildPluginToggles() }
  const features = service.features
  const supportsRender = features === undefined || features.includes('pluginSettings')
  if (supportsRender) settings.render = createSettingsRender(runtime)
  return settings
}

export function createServiceHost(ctx: ClientContext, service: BetterSidebarLike): NotebookHost {
  return {
    tier: 'service',

    register(runtime: NotebookRuntime): () => void {
      const dispose = disposeOf(
        ctx.effect(
          () =>
            service.registerTab({
              id: SERVICE_TAB_ID,
              title: () => t('title'),
              description: () => t('description'),
              icon: createElement(NotebookGlyph, {}),
              order: SERVICE_TAB_ORDER,
              // ≡ dedupeKey: () => id — a second open focuses the live tab
              // instead of minting a second Notebook (G8's "one container").
              single: true,
              component: createTabComponent(runtime),
              settings: buildSettings(runtime, service),
            }),
          'dsh-notebook:service-tab',
        ),
      )

      let released = false
      return () => {
        if (released) return
        released = true
        try {
          dispose()
        } catch (error) {
          console.warn('[dsh-notebook] service tab dispose failed:', error)
        }
      }
    },

    reveal(): void {
      try {
        service.openTab?.({ type: SERVICE_TAB_ID, title: t('title') })
      } catch (error) {
        console.warn('[dsh-notebook] service openTab failed:', error)
      }
    },
  }
}
