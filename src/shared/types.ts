/**
 * Shared notebook types + media guards.
 *
 * This module is imported by BOTH halves of the plugin:
 *   - the host half (`src/store.ts`, `src/attachments.ts`, `src/routes.ts`) runs
 *     under Node;
 *   - the client half (`src/client/**`) runs inside the DSH browser bundle, which
 *     is a CJS closure factory registered on `window.__ModuleLoader__`.
 *
 * Therefore this file MUST stay browser-safe: no `node:*` imports, no
 * `@deepseek-ai/*` value imports, no side effects, no globals other than the
 * standard ECMAScript ones. Everything below is a pure type/constant/function
 * declaration.
 */

/** How the note list is ordered. Persisted in {@link NotebookPrefs}. */
export type NotebookSortOrder = 'updated' | 'created' | 'title'

/**
 * Plugin preferences. The single source of truth lives in the host document
 * (`NotebookDoc.prefs`) so that all three sidebar tiers (native / better-sidebar
 * service / standalone) observe identical settings across browsers.
 */
export interface NotebookPrefs {
  /** List ordering; default `'updated'` (newest edit first). */
  sortOrder: NotebookSortOrder
  /** When copying a note body, render image markers as a `[图片: name]` line. */
  copyImagesAsName: boolean
  /** Upper bound of images attached to a single note. */
  maxImagesPerNote: number
  /** Ask before deleting a note. */
  confirmDelete: boolean
  /** Standalone tier only: expand the self-drawn sidebar on startup. */
  openOnStart: boolean
  /**
   * Native right-sidebar tier only: when a session becomes current (a freshly
   * created one, or one the user switched to), expand the sidebar and open the
   * Notebook page. Off by default — a panel nobody asked for must never appear
   * on its own. Other tiers have their own panel lifetime (`openOnStart`).
   */
  autoOpenOnNewSession: boolean
  /**
   * Select-to-notebook (v0.2.0): selecting text in the session shows a small
   * floating "save to notebook" action; the selection becomes a fresh note
   * titled {@link DEFAULT_SELECTION_TITLE_PREFIX}`n`. On by default.
   */
  selectionToNotebook: boolean
  /**
   * Answer-to-notebook (v0.2.0): every finalized assistant message carries a
   * "save to notebook" action at the end of its action row; the whole answer
   * becomes a fresh note titled with the session's title. On by default.
   */
  messageToNotebook: boolean
}

/** Default preferences, mirrored by the host schema and the client settings panel. */
export const DEFAULT_PREFS: NotebookPrefs = {
  sortOrder: 'updated',
  copyImagesAsName: true,
  maxImagesPerNote: 20,
  confirmDelete: true,
  openOnStart: false,
  autoOpenOnNewSession: false,
  selectionToNotebook: true,
  messageToNotebook: true,
}

/**
 * Title stem of a note minted from captured content (v0.2.0): the numbered
 * default `未命名1`, `未命名2`, … handed to a note the user did not name.
 *
 * The two capture features use the SAME stem on purpose — the user sees one
 * family of auto-created entries, and {@link nextUntitledTitle} numbers them
 * against whatever the notebook already holds.
 */
export const UNTITLED_TITLE_STEM = '未命名'

/** Matches a default title produced by {@link nextUntitledTitle}. */
export const UNTITLED_TITLE_RE: RegExp = /^未命名(\d+)$/

/**
 * The next free default title for a captured note: `未命名n` with the smallest
 * `n ≥ 1` no existing title already uses.
 *
 * "Smallest free" rather than "count + 1" so deleting `未命名2` hands the next
 * capture that slot instead of skipping to `未命名4`, and a non-numeric or
 * renamed title can never collide with a generated one. `used` is scanned as
 * plain strings — titles are compared exactly, not trimmed, because the host
 * stores what the user typed.
 */
export function nextUntitledTitle(existingTitles: readonly string[]): string {
  const used = new Set<number>()
  for (const title of existingTitles) {
    if (typeof title !== 'string') continue
    const match = UNTITLED_TITLE_RE.exec(title)
    if (match === null) continue
    const value = Number.parseInt(match[1] ?? '', 10)
    if (Number.isFinite(value) && value > 0) used.add(value)
  }
  let index = 1
  while (used.has(index)) index += 1
  return `${UNTITLED_TITLE_STEM}${index}`
}

/** Hard cap for one uploaded image (bytes). Enforced on both halves. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** Default cap for one HTTP request body (bytes); overridable via plugin config. */
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024

/** One stored image belonging to a note. */
export interface NotebookAttachment {
  /** Stable id; also the on-disk file stem. */
  id: string
  /** Original (sanitized) file name, shown to the user. */
  name: string
  /** One of {@link IMAGE_MIME_ALLOW}. */
  mime: string
  /** Byte length of the stored image. */
  size: number
  /** Path relative to the attachments root: `'<noteId>/<attachmentId>.<ext>'`. */
  relPath: string
  width?: number
  height?: number
  createdAt: number
}

/** One note. */
export interface NotebookNote {
  id: string
  title: string
  /**
   * Body text: plain text interleaved with image markers of the form
   * `![<name>](attachment:<attachmentId>)`. No rich-text dependency is used;
   * the editor parses markers back into image nodes and the clipboard writer
   * rewrites them (see {@link attachmentMarker} / {@link parseAttachmentIds}).
   */
  body: string
  attachments: NotebookAttachment[]
  createdAt: number
  updatedAt: number
}

/** The persisted document (`$DSH_HOME/storages/notebook.json`). */
export interface NotebookDoc {
  version: 1
  /** Sorted by `updatedAt` descending (host-guaranteed canonical order). */
  notes: NotebookNote[]
  prefs: NotebookPrefs
}

/** Image MIME types the plugin accepts (4 raster formats + SVG). */
export const IMAGE_MIME_ALLOW: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]

/** File extensions accepted as images (used when the MIME type is missing/generic). */
export const IMAGE_EXT_ALLOW: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']

/**
 * Video extensions that are ALWAYS rejected, even when a client claims an image
 * MIME type for them (the host re-checks the name and never trusts the client).
 */
export const VIDEO_EXT_DENY: readonly string[] = [
  'mp4',
  'mov',
  'webm',
  'mkv',
  'avi',
  'm4v',
  'ogv',
  'mpg',
  'mpeg',
  '3gp',
  'flv',
  'wmv',
]

/** MIME types that carry no usable media information (fall back to the extension). */
const GENERIC_MIME: readonly string[] = [
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/x-unknown',
  'application/unknown',
]

/** Lower-cased extension of a file name, without the dot ('' when absent). */
export function fileExtension(name?: string): string {
  if (typeof name !== 'string') return ''
  const base = name.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

/** Normalize a MIME string: lower-case, strip parameters, fold the `image/jpg` alias. */
export function normalizeMime(mime?: string): string {
  if (typeof mime !== 'string') return ''
  const head = mime.split(';')[0] ?? ''
  const value = head.trim().toLowerCase()
  if (value === 'image/jpg') return 'image/jpeg'
  return value
}

/**
 * True when the file must be treated as video: either the declared MIME type is
 * `video/*`, or the file name carries a known video extension.
 */
export function isVideoFile(file: { type?: string; name?: string }): boolean {
  const mime = normalizeMime(file?.type)
  if (mime.startsWith('video/')) return true
  return VIDEO_EXT_DENY.includes(fileExtension(file?.name))
}

/**
 * True when the file may be stored as a note image.
 *
 * MIME wins when it is specific; a missing or generic MIME (`''`,
 * `application/octet-stream`, ...) falls back to the file extension, which is
 * what drag-and-drop from some OS file managers produces.
 */
export function isAllowedImage(file: { type?: string; name?: string }): boolean {
  if (isVideoFile(file)) return false
  const mime = normalizeMime(file?.type)
  if (GENERIC_MIME.includes(mime)) return IMAGE_EXT_ALLOW.includes(fileExtension(file?.name))
  return IMAGE_MIME_ALLOW.includes(mime)
}

/**
 * Matches image markers in a note body: `![<alt>](attachment:<id>)`.
 *
 * The id character class is deliberately generous (`A-Z a-z 0-9 _ . : -`) so a
 * client-side placeholder id written before the upload is parsed as well as the
 * host's UUIDs. The alt text must not contain `]`, which is why
 * {@link NotebookAttachment.name} is sanitized without brackets.
 *
 * NOTE: this RegExp carries the `g` flag so `String.prototype.replace` /
 * `matchAll` cover every marker. A `g`-flagged RegExp is stateful — never call
 * `.test()`/`.exec()` on it in a loop without resetting `lastIndex`.
 */
export const ATTACHMENT_MARKER_RE: RegExp = /!\[([^\]]*)\]\(attachment:([A-Za-z0-9_.:-]+)\)/g

/** Build the body marker for one attachment. */
export function attachmentMarker(id: string, name = ''): string {
  return `![${name}](attachment:${id})`
}

/** One image marker found in a note body. */
export interface AttachmentMarkerRef {
  /** The exact matched text (used for splicing). */
  raw: string
  /** Alt text, which the editor keeps in sync with the attachment file name. */
  alt: string
  /** Referenced attachment id (may be a client-side placeholder before upload). */
  id: string
}

/** Every image marker in `body`, in order of appearance. */
export function parseAttachmentMarkers(body: string): AttachmentMarkerRef[] {
  const markers: AttachmentMarkerRef[] = []
  if (typeof body !== 'string' || body.length === 0) return markers
  const re = new RegExp(ATTACHMENT_MARKER_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(body)) !== null) {
    markers.push({ raw: match[0], alt: match[1] ?? '', id: match[2] ?? '' })
  }
  return markers
}

/** Every attachment id referenced by `body`, in order of first appearance. */
export function parseAttachmentIds(body: string): string[] {
  const ids: string[] = []
  for (const marker of parseAttachmentMarkers(body)) {
    if (marker.id.length > 0 && !ids.includes(marker.id)) ids.push(marker.id)
  }
  return ids
}
