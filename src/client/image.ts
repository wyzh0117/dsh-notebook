/**
 * Image intake, preview, and body-marker plumbing for the editor (spec §3.1,
 * §4.2, §4.5).
 *
 * One funnel for all three entry points (`onPaste`, `onDrop`, the file input):
 * every `File` goes through {@link validateImageFile}, so the "no video" rule
 * lives in exactly one place — in the UI. The host re-checks the same rule and
 * answers 415, because the client is not trusted.
 *
 * Body format: the persisted `body` is plain text plus one marker line per
 * image — `![<name>](attachment:<attachmentId>)`. The editor shows the text in
 * a textarea and the images as chips; markers are re-composed on save, so a
 * round-trip is stable (text first, then the marker block).
 *
 * Purity: no `node:*`, no `@deepseek-ai/*` value imports.
 */
import { isAllowedImage, isVideoFile } from '../shared/types'
import type { NotebookAttachment, NotebookNote } from '../shared/types'
import type { NotebookApiClient } from './api'

/** Single-image ceiling (spec §4.2): 10 MB. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
/** The same ceiling in MB, for the message text. */
export const MAX_IMAGE_MB = 10
/** Longest file name we keep in a marker / attachment record. */
export const MAX_NAME_LENGTH = 120

/** Why a file was refused, mapped to a message key by the editor. */
export type ImageRejectReason = 'video' | 'not-image' | 'too-large' | 'too-many'

export type ImageValidation = { ok: true } | { ok: false; reason: ImageRejectReason }

/**
 * The single intake gate. Order matters: a video is reported as a video even
 * when its extension is missing, and "not an image" is reported before the size
 * rule so the user hears the more useful complaint.
 */
export function validateImageFile(file: File, options: { max: number; current: number }): ImageValidation {
  const probe = { type: file?.type ?? '', name: file?.name ?? '' }
  if (isVideoFile(probe)) return { ok: false, reason: 'video' }
  if (!isAllowedImage(probe)) return { ok: false, reason: 'not-image' }
  const size = typeof file?.size === 'number' ? file.size : 0
  if (size > MAX_IMAGE_BYTES) return { ok: false, reason: 'too-large' }
  if (options.current >= options.max) return { ok: false, reason: 'too-many' }
  return { ok: true }
}

/**
 * Pull `File`s out of a `DataTransfer` — used by both `onPaste` and `onDrop`.
 * Real browsers expose the same file through `files` *and* `items`; identical
 * objects are de-duplicated so one paste never becomes two attachments.
 */
export function filesFromDataTransfer(data: unknown): File[] {
  const transfer = data as { files?: ArrayLike<File> | null; items?: ArrayLike<DataTransferItem> | null } | null
  if (!transfer) return []
  const found: File[] = []
  const files = transfer.files
  if (files && typeof files.length === 'number') {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      if (file) found.push(file)
    }
  }
  const items = transfer.items
  if (items && typeof items.length === 'number') {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      if (!item) continue
      if (typeof item.kind === 'string' && item.kind !== 'file') continue
      if (typeof item.getAsFile !== 'function') continue
      const file = item.getAsFile()
      if (file) found.push(file)
    }
  }
  const seen = new Set<File>()
  return found.filter((file) => {
    if (seen.has(file)) return false
    seen.add(file)
    return true
  })
}

/** Strip separators / control characters, cap the length, keep the extension. */
export function cleanFileName(name: unknown): string {
  const raw = typeof name === 'string' ? name : ''
  const cleaned = raw
    .replace(/[\\/]+/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length === 0) return 'image'
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned
  const dot = cleaned.lastIndexOf('.')
  if (dot > 0 && cleaned.length - dot <= 12) {
    const ext = cleaned.slice(dot)
    return cleaned.slice(0, MAX_NAME_LENGTH - ext.length) + ext
  }
  return cleaned.slice(0, MAX_NAME_LENGTH)
}

/** File name safe to sit inside `![alt](…)`: no bracket/paren/newline breakage. */
export function sanitizeMarkerName(name: unknown): string {
  const cleaned = String(name ?? '')
    .replace(/[[\]()\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 0 ? cleaned.slice(0, MAX_NAME_LENGTH) : 'image'
}

/** `![<name>](attachment:<idOrKey>)` */
export function markerFor(idOrKey: string, name: string): string {
  return `![${sanitizeMarkerName(name)}](attachment:${String(idOrKey)})`
}

const MARKER_LINE_RE = /^[ \t]*!\[[^\]]*\]\(attachment:[^)]*\)[ \t]*$/
const MARKER_RE = /!\[[^\]]*\]\(attachment:([^)]*)\)/g

function isMarkerLine(line: string): boolean {
  return MARKER_LINE_RE.test(line)
}

/** The user's own text: the body with the marker block removed. */
export function stripMarkerLines(body: unknown): string {
  return String(body ?? '')
    .split(/\r?\n/)
    .filter((line) => !isMarkerLine(line))
    .join('\n')
    .replace(/\s+$/, '')
}

/** Attachment ids referenced by the body, in order of first appearance. */
export function attachmentIdsInBody(body: unknown): string[] {
  const text = String(body ?? '')
  const ids: string[] = []
  const seen = new Set<string>()
  MARKER_RE.lastIndex = 0
  let match = MARKER_RE.exec(text)
  while (match !== null) {
    const id = match[1]
    if (id && !seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
    match = MARKER_RE.exec(text)
  }
  return ids
}

/**
 * Compose the persisted body: the text, then one marker line per image in
 * editor order. `idFor` decides which id each image gets — its real attachment
 * id when it already exists, a local placeholder while it is being uploaded.
 */
export function composeBody(text: string, images: EditorImage[], idFor: (image: EditorImage) => string): string {
  const trimmed = String(text ?? '').trim()
  if (images.length === 0) return trimmed
  const markers = images.map((image) => markerFor(idFor(image), image.name)).join('\n')
  return trimmed.length > 0 ? `${trimmed}\n\n${markers}` : markers
}

/** One image as the editor holds it (either a local `File` or a stored one). */
export interface EditorImage {
  /** Editor-local identity; never persisted. */
  key: string
  name: string
  mime: string
  size: number
  /** `blob:` for a local file, the host attachment URL for a stored one. */
  previewUrl: string
  /** Whether {@link URL.revokeObjectURL} must be called for `previewUrl`. */
  revoke: boolean
  /** Set when the bytes already live on the host. */
  attachmentId?: string
  relPath?: string
  /** Set for a freshly added file that still has to be uploaded. */
  file?: File
}

let keyCounter = 0

/** Editor-local id (never sent to the host, never used as a real attachment id). */
export function newLocalKey(): string {
  keyCounter += 1
  return `local-${Date.now().toString(36)}-${keyCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Rebuild the editor's image list from a stored note: markers decide the order,
 * then any attachment the body forgot about is appended so nothing is lost.
 */
export function imagesFromNote(note: NotebookNote, api: NotebookApiClient): EditorImage[] {
  const remaining = new Map<string, NotebookAttachment>()
  for (const attachment of note.attachments ?? []) remaining.set(attachment.id, attachment)
  const ordered: NotebookAttachment[] = []
  for (const id of attachmentIdsInBody(note.body)) {
    const attachment = remaining.get(id)
    if (attachment) {
      ordered.push(attachment)
      remaining.delete(id)
    }
  }
  for (const attachment of note.attachments ?? []) {
    if (remaining.has(attachment.id)) {
      ordered.push(attachment)
      remaining.delete(attachment.id)
    }
  }
  return ordered.map((attachment) => ({
    key: newLocalKey(),
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
    previewUrl: api.attachmentUrl(note.id, attachment.relPath),
    revoke: false,
    attachmentId: attachment.id,
    relPath: attachment.relPath,
  }))
}

/** `URL.createObjectURL` guarded for environments without it (jsdom, SSR). */
export function objectUrlFor(file: File): string {
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') return URL.createObjectURL(file)
  return ''
}

/** Release a preview URL, tolerating a missing/foreign implementation. */
export function releaseObjectUrl(url: string | undefined, revoke: boolean): void {
  if (!revoke || !url) return
  if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    try {
      URL.revokeObjectURL(url)
    } catch {
      /* already released */
    }
  }
}

/** Read any blob as a `data:` URL (the upload encoding the host expects). */
export function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (typeof FileReader !== 'function') {
      reject(new Error('FileReader is unavailable in this environment'))
      return
    }
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('failed to read the file'))
    reader.onabort = () => reject(new Error('reading the file was aborted'))
    reader.onload = () => {
      const result = reader.result
      if (typeof result === 'string') resolve(result)
      else reject(new Error('unexpected FileReader result'))
    }
    reader.readAsDataURL(blob)
  })
}

/** A local file's bytes as a data URL. */
export function fileToDataUrl(file: File): Promise<string> {
  return readAsDataUrl(file)
}

/** Re-read an attachment that already lives on the host (edit re-upload path). */
export async function urlToDataUrl(url: string): Promise<string> {
  const fetcher = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined
  if (!fetcher) throw new Error('fetch is unavailable in this environment')
  const response = await fetcher(url, { cache: 'no-store', credentials: 'same-origin' })
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`)
  return readAsDataUrl(await response.blob())
}
