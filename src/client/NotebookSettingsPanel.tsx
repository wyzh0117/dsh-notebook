/**
 * The plugin's settings surface (spec §5).
 *
 * One field definition shared by all three tiers: the adapters register this
 * panel (or the matching declarative rows) and the values still travel through
 * `PATCH /notebook/api/prefs`, so the host document stays the single source of
 * truth — no tier keeps private settings state.
 *
 * Purity: no `node:*`, no `@deepseek-ai/*` value imports.
 */
import { useMemo } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { NotebookPrefs } from '../shared/types'
import { t } from './locales'
import { uiSizes, uiTokens } from './icons'

export interface NotebookSettingsPanelProps {
  prefs: NotebookPrefs
  onChange(patch: Partial<NotebookPrefs>): void
}

const MIN_IMAGES = 1
const MAX_IMAGES = 100

function clampImages(value: number): number {
  if (!Number.isFinite(value)) return MIN_IMAGES
  return Math.min(MAX_IMAGES, Math.max(MIN_IMAGES, Math.floor(value)))
}

function Row(props: { label: string; description: string; control: ReactNode }): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '8px 0',
        borderBottom: `1px solid ${uiTokens.border}`,
      }}
    >
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: uiTokens.text }}>{props.label}</div>
        <div style={{ marginTop: 2, fontSize: 11, lineHeight: '16px', color: uiTokens.textTertiary }}>
          {props.description}
        </div>
      </div>
      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', paddingTop: 2 }}>{props.control}</div>
    </div>
  )
}

export function NotebookSettingsPanel(props: NotebookSettingsPanelProps): JSX.Element {
  const { prefs, onChange } = props

  const styles: { select: CSSProperties; input: CSSProperties; check: CSSProperties } = useMemo(
    () => ({
      select: {
        height: uiSizes.controlHeight,
        minWidth: 128,
        padding: '0 6px',
        border: `1px solid ${uiTokens.borderStrong}`,
        borderRadius: uiSizes.radius,
        background: uiTokens.field,
        color: uiTokens.text,
        fontSize: 12,
      },
      input: {
        width: 64,
        height: uiSizes.controlHeight,
        padding: '0 6px',
        border: `1px solid ${uiTokens.borderStrong}`,
        borderRadius: uiSizes.radius,
        background: uiTokens.field,
        color: uiTokens.text,
        fontSize: 12,
        textAlign: 'right',
        boxSizing: 'border-box',
      },
      check: {
        width: 16,
        height: 16,
        accentColor: uiTokens.accent,
        cursor: 'pointer',
      },
    }),
    [],
  )

  return (
    <div data-testid="notebook-settings" style={{ color: uiTokens.text, fontFamily: 'inherit' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: uiTokens.textSecondary, paddingBottom: 4 }}>
        {t('settingsTitle')}
      </div>

      <Row
        label={t('settingsSortOrder')}
        description={t('settingsSortOrderDesc')}
        control={
          <select
            data-testid="notebook-setting-sortOrder"
            aria-label={t('settingsSortOrder')}
            value={prefs.sortOrder}
            onChange={(event) =>
              onChange({ sortOrder: event.target.value as NotebookPrefs['sortOrder'] })
            }
            style={styles.select}
          >
            <option value="updated">{t('settingsSortUpdated')}</option>
            <option value="created">{t('settingsSortCreated')}</option>
            <option value="title">{t('settingsSortTitle')}</option>
          </select>
        }
      />

      <Row
        label={t('settingsCopyImages')}
        description={t('settingsCopyImagesDesc')}
        control={
          <input
            data-testid="notebook-setting-copyImagesAsName"
            type="checkbox"
            aria-label={t('settingsCopyImages')}
            checked={prefs.copyImagesAsName === true}
            onChange={(event) => onChange({ copyImagesAsName: event.target.checked })}
            style={styles.check}
          />
        }
      />

      <Row
        label={t('settingsMaxImages')}
        description={t('settingsMaxImagesDesc')}
        control={
          <input
            data-testid="notebook-setting-maxImagesPerNote"
            type="number"
            aria-label={t('settingsMaxImages')}
            min={MIN_IMAGES}
            max={MAX_IMAGES}
            step={1}
            value={prefs.maxImagesPerNote}
            onChange={(event) => onChange({ maxImagesPerNote: clampImages(Number(event.target.value)) })}
            style={styles.input}
          />
        }
      />

      <Row
        label={t('settingsConfirmDelete')}
        description={t('settingsConfirmDeleteDesc')}
        control={
          <input
            data-testid="notebook-setting-confirmDelete"
            type="checkbox"
            aria-label={t('settingsConfirmDelete')}
            checked={prefs.confirmDelete === true}
            onChange={(event) => onChange({ confirmDelete: event.target.checked })}
            style={styles.check}
          />
        }
      />

      <Row
        label={t('settingsOpenOnStart')}
        description={t('settingsOpenOnStartDesc')}
        control={
          <input
            data-testid="notebook-setting-openOnStart"
            type="checkbox"
            aria-label={t('settingsOpenOnStart')}
            checked={prefs.openOnStart === true}
            onChange={(event) => onChange({ openOnStart: event.target.checked })}
            style={styles.check}
          />
        }
      />
    </div>
  )
}
