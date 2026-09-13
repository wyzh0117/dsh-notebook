/**
 * 16px linear icons in the app's outline style (1.5px `currentColor` strokes),
 * plus the small theme-token map the three UI modules share.
 *
 * The token map lives here — beside the icons — because the brief fixes this
 * file list (no `theme.ts` allowed); it keeps `NotebookView`,
 * `NotebookEditor` and `NotebookSettingsPanel` from drifting apart.
 *
 * Purity: inline `<svg>` only, no `node:*`, no `@deepseek-ai/*` value imports.
 */

/**
 * Theme-aware style values. Every colour is a DSH semantic token with a
 * literal fallback, and the fallbacks are neutral/translucent on purpose: they
 * must survive both the light and the dark scheme, so nothing here hardcodes an
 * opaque surface colour. `--dsw-alias-*` is the token family the DSH web shell
 * and dsh-better-sidebar's own chrome use.
 */
export const uiTokens = {
  /** Primary ink. */
  text: 'var(--dsw-alias-label-primary, #1f2328)',
  /** Secondary ink: metadata lines, hints. */
  textSecondary: 'var(--dsw-alias-label-secondary, #656d76)',
  /** Tertiary ink: the quietest labels. */
  textTertiary: 'var(--dsw-alias-label-tertiary, #8b949e)',
  /** Ink on a filled affirmative control. */
  textInverted: 'var(--dsw-alias-label-primary-inverted, #ffffff)',
  /** Hairline borders between rows. */
  border: 'var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28))',
  /** Stronger border for inputs that must read as fields. */
  borderStrong: 'var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.45))',
  /** Raised layer for the editor overlay and image chips. */
  surface: 'var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.06))',
  /** Field fill (inputs, textarea, the list row hover). */
  field: 'var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.04))',
  /** Hover wash: translucent grey works in both schemes. */
  hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))',
  /** Accent ink. */
  accent: 'var(--dsw-alias-brand-primary, #2f6feb)',
  /** Fill of the affirmative button. */
  primaryFill: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #2f6feb))',
  /** Destructive ink. */
  danger: 'var(--dsw-alias-state-error-primary, #d1242f)',
  /** Motion tokens; the theme supplies the real durations. */
  transition: 'var(--ds-transition-duration-slow, 180ms) var(--ds-ease-in-out, ease-in-out)',
} as const

/** Sizes shared by the row controls (matches the app's 28px icon buttons). */
export const uiSizes = {
  iconButton: 28,
  controlHeight: 28,
  radius: 8,
} as const

interface IconProps {
  size?: number
}

function svgProps(size: number, strokeWidth = 1.5) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
    focusable: 'false' as const,
    style: { display: 'block', flex: '0 0 auto' as const },
  }
}

/** The product glyph: a ring-bound notebook. */
export function NotebookGlyph({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)} data-testid="icon-notebook">
      <rect x="3" y="1.75" width="10.25" height="12.5" rx="2" />
      <path d="M5.75 1.75v12.5" />
      <path d="M8.25 5.5h2.75M8.25 8h2.75M8.25 10.5h1.75" />
    </svg>
  )
}

/**
 * The right-panel toggle glyph ("侧拉"): a rounded frame with a filled strip
 * along its RIGHT edge, a hair of space between the two. Visual twin of
 * dsh-better-sidebar's `IconPanelRightOutline16`.
 */
export function PanelRightOutline16(_props: Record<string, never>): JSX.Element {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flex: '0 0 auto' }}
    >
      <rect x="1.5" y="2" width="13" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="10.5" y="3.25" width="2.75" height="9.5" rx="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** Plus: the "new note" affordance. */
export function PlusIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </svg>
  )
}

/** Trash: delete a note. */
export function TrashIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path d="M2.75 4.25h10.5" />
      <path d="M6.25 4.25V3a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 .75.75v1.25" />
      <path d="M4.25 4.25l.6 8.1a1.25 1.25 0 0 0 1.25 1.15h3.8a1.25 1.25 0 0 0 1.25-1.15l.6-8.1" />
      <path d="M6.6 6.75v4M9.4 6.75v4" />
    </svg>
  )
}

/** Pencil: edit an existing note. */
export function EditIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path d="M10.9 2.35a1.4 1.4 0 0 1 2 0l.75.75a1.4 1.4 0 0 1 0 2l-6.9 6.9-3 .75.75-3z" />
      <path d="M9.9 3.35l2.75 2.75" />
    </svg>
  )
}

/** Picture: the image-attachment affordance. */
export function ImageIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <rect x="1.75" y="2.5" width="12.5" height="11" rx="2" />
      <circle cx="5.6" cy="6.1" r="1.15" />
      <path d="M2.75 12.25l3.1-3.1 2.35 2.35 2.4-2.4 2.65 2.65" />
    </svg>
  )
}

/** Cross: remove one attached image / close the editor. */
export function CloseIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}
