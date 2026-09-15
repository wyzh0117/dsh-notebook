/**
 * The global plugin settings seat (`settings.section`), shared by the tiers that
 * have no settings surface of their own.
 *
 * The standalone tier used to own this registration; the native right sidebar
 * has no per-tab settings page at all, so it needs the same seat to expose the
 * new "open the notebook for new sessions" switch (and every other preference).
 * Registering the panel is a no-op wherever the slot is not declared, so a
 * composition without a settings dialog is never an error.
 *
 * Purity: no `node:*`, no `@deepseek-ai/*` value imports.
 */
import { createElement, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { NotebookSettingsPanel } from '../NotebookSettingsPanel'
import { t } from '../locales'
import { disposeOf } from './detect'
import type { NotebookPrefs } from '../../shared/types'
import type { ClientContext, NotebookRuntime } from './types'

/** Slot id of our settings section (stable across tiers: never registered twice). */
export const SETTINGS_SECTION_ID = 'dsh-notebook'

/** The section body: one shared panel over the shared runtime prefs. */
function createSettingsSection(runtime: NotebookRuntime): () => ReactNode {
  return function NotebookSettingsSection(): ReactNode {
    const prefs = useSyncExternalStore(runtime.subscribe, runtime.getPrefs)
    return createElement(
      'div',
      {
        'data-dsh-notebook': 'settings',
        style: { display: 'flex', flexDirection: 'column', padding: '4px 0 12px' },
      },
      createElement(NotebookSettingsPanel, {
        prefs,
        onChange: (patch: Partial<NotebookPrefs>) => runtime.setPrefs(patch),
      }),
    )
  }
}

/**
 * Register the settings section.
 *
 * @returns the disposer (a safe no-op when the slot is not declared).
 */
export function registerSettingsSection(ctx: ClientContext, runtime: NotebookRuntime): () => void {
  return disposeOf(
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: SETTINGS_SECTION_ID,
          order: 100,
          label: () => t('settingsSection'),
        },
        createSettingsSection(runtime),
      ),
    ),
  )
}
