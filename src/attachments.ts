/**
 * Attachment (image) handling for the dsh-notebook host half.
 *
 * Responsibilities:
 *   - decode `data:` URLs coming from the browser (the client uses `FileReader`);
 *   - refuse video and every non-image payload with a typed 415 error;
 *   - enforce the size / count limits;
 *   - write bytes to `$DSH_HOME/storages/notebook-attachments/<noteId>/<attachmentId>.<ext>`
 *     (the original file name is never used as an on-disk name);
 *   - read them back with the correct response headers.
 *
 * This module depends only on `node:*` and `./shared/types`, so it is unit
 * testable without any DSH package.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import {
  IMAGE_MIME_ALLOW,
  MAX_IMAGE_BYTES,
  isVideoFile,
  normalizeMime,
  type NotebookAttachment,
} from './shared/types'

export { MAX_IMAGE_BYTES, MAX_REQUEST_BYTES } from './shared/types'

/** Longest file name we keep for display purposes. */
const MAX_FILE_NAME_LENGTH = 120

/** MIME → canonical on-disk extension. */
const MIME_TO_EXT: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

/** Canonical on-disk extension → MIME (reading side; `jpeg` is accepted as an alias). */
const EXT_TO_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

/** Base class for every attachment failure; `status` maps straight onto HTTP. */
export class AttachmentError extends Error {
  readonly status: number
  readonly code: string

  constructor(code: string, status: number, message: string) {
    super(message)
    this.name = 'AttachmentError'
    this.code = code
    this.status = status
  }
}

/** 415 — the payload is video or not an image at all. */
export class UnsupportedMediaError extends AttachmentError {
  constructor(message: string) {
    super('UNSUPPORTED_MEDIA', 415, message)
    this.name = 'UnsupportedMediaError'
  }
}

/** 413 — the payload is too large. */
export class AttachmentTooLargeError extends AttachmentError {
  constructor(message: string) {
    super('PAYLOAD_TOO_LARGE', 413, message)
    this.name = 'AttachmentTooLargeError'
  }
}

/** 413 — the note already holds the configured maximum number of images. */
export class AttachmentLimitError extends AttachmentError {
  constructor(message: string) {
    super('TOO_MANY_ATTACHMENTS', 413, message)
    this.name = 'AttachmentLimitError'
  }
}

/** 400 — malformed data URL or an unsafe path/id segment. */
export class AttachmentPathError extends AttachmentError {
  constructor(message: string) {
    super('INVALID_PATH', 400, message)
    this.name = 'AttachmentPathError'
  }
}

/** 404 — the attachment file does not exist (or has an unknown extension). */
export class AttachmentNotFoundError extends AttachmentError {
  constructor(message: string) {
    super('NOT_FOUND', 404, message)
    this.name = 'AttachmentNotFoundError'
  }
}

/** Canonical on-disk extension for a supported image MIME type. */
export function extForMime(mime: string): string {
  const normalized = normalizeMime(mime)
  const ext = MIME_TO_EXT[normalized]
  if (!ext) {
    throw new UnsupportedMediaError(
      `unsupported image type: ${normalized || '(empty)'}; allowed: ${IMAGE_MIME_ALLOW.join(', ')}`,
    )
  }
  return ext
}

/** MIME type for an on-disk extension, or `undefined` when unknown. */
export function mimeForExt(ext: string): string | undefined {
  return EXT_TO_MIME[ext.trim().toLowerCase().replace(/^\./, '')]
}

/**
 * Sanitize an uploaded file name for DISPLAY only (never for the on-disk name):
 * drops any directory component, control characters, bidi overrides, leading
 * dots and square brackets, trims whitespace and caps the length while keeping
 * the extension.
 *
 * Brackets are removed because the editor serializes an image as
 * `![<name>](attachment:<id>)`: a `]` inside the name would terminate the alt
 * text early and make the marker unparseable.
 */
export function sanitizeFileName(name: unknown): string {
  if (typeof name !== 'string') return ''
  let out = name.split(/[\\/]/).pop() ?? ''
  // Control characters (including NUL) would corrupt logs and JSON output.
  out = out.replace(/[\u0000-\u001f\u007f]/g, '')
  // Bidi overrides let a name spoof a different extension in the UI.
  out = out.replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
  out = out.replace(/[[\]]/g, '')
  out = out.replace(/^[.\s]+/, '')
  out = out.replace(/\s+$/, '')
  if (out.length > MAX_FILE_NAME_LENGTH) {
    const dot = out.lastIndexOf('.')
    const ext = dot > 0 && out.length - dot <= 12 ? out.slice(dot) : ''
    out = out.slice(0, Math.max(1, MAX_FILE_NAME_LENGTH - ext.length)) + ext
  }
  return out
}

/**
 * Parse a strict `data:<mime>[;param=...];base64,<payload>` URL.
 *
 * Strict about the shape (a base64 media type is required, the payload must be
 * base64 base characters) but tolerant about the optional parameters some
 * producers add in front of `;base64,` (e.g. `;charset=utf-8`) and about the
 * scheme's letter case.
 *
 * @throws {AttachmentError} 400 when the URL is not a base64 data URL.
 */
export function decodeDataUrl(dataUrl: unknown): { mime: string; bytes: Buffer } {
  if (typeof dataUrl !== 'string') {
    throw new AttachmentError('BAD_DATA_URL', 400, 'attachment dataUrl must be a string')
  }
  const trimmed = dataUrl.trim()
  const match = /^data:([^;,]+)((?:;[^;,]*)*);base64,([A-Za-z0-9+/=\s]*)$/i.exec(trimmed)
  if (!match) {
    throw new AttachmentError(
      'BAD_DATA_URL',
      400,
      'attachment dataUrl must have the form "data:<mime>;base64,<payload>"',
    )
  }
  const mime = normalizeMime(match[1])
  const payload = (match[3] ?? '').replace(/\s+/g, '')
  if (payload.length === 0) {
    throw new AttachmentError('BAD_DATA_URL', 400, 'attachment dataUrl carries an empty payload')
  }
  const bytes = Buffer.from(payload, 'base64')
  if (bytes.length === 0) {
    throw new AttachmentError('BAD_DATA_URL', 400, 'attachment dataUrl payload decoded to zero bytes')
  }
  return { mime, bytes }
}

/** Validate that a (name, mime) pair denotes an allowed image; returns the normalized MIME. */
export function assertSupportedImage(input: { name?: string; mime?: string }): string {
  if (isVideoFile({ type: input.mime, name: input.name })) {
    throw new UnsupportedMediaError('video files are not supported')
  }
  const mime = normalizeMime(input.mime)
  if (!IMAGE_MIME_ALLOW.includes(mime)) {
    throw new UnsupportedMediaError(
      `unsupported image type: ${mime || '(empty)'}; allowed: ${IMAGE_MIME_ALLOW.join(', ')}`,
    )
  }
  return mime
}

/**
 * Best-effort pixel size sniffing for the raster formats we accept. SVG is
 * vector (no intrinsic pixel size) and returns `undefined`.
 */
export function readImageSize(bytes: Buffer, mime: string): { width: number; height: number } | undefined {
  try {
    if (mime === 'image/png') {
      if (bytes.length < 24) return undefined
      if (bytes.readUInt32BE(0) !== 0x89504e47) return undefined
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    }
    if (mime === 'image/gif') {
      if (bytes.length < 10) return undefined
      if (bytes.toString('ascii', 0, 4) !== 'GIF8') return undefined
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
    }
    if (mime === 'image/jpeg') return readJpegSize(bytes)
    if (mime === 'image/webp') return readWebpSize(bytes)
  } catch {
    return undefined
  }
  return undefined
}

function readJpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1] ?? 0
    // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
    }
    const length = bytes.readUInt16BE(offset + 2)
    if (length < 2) return undefined
    offset += 2 + length
  }
  return undefined
}

function readWebpSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 30) return undefined
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return undefined
  const chunk = bytes.toString('ascii', 12, 16)
  if (chunk === 'VP8X') {
    const width = bytes.readUIntLE(24, 3) + 1
    const height = bytes.readUIntLE(27, 3) + 1
    return { width, height }
  }
  if (chunk === 'VP8 ') {
    const width = bytes.readUInt16LE(26) & 0x3fff
    const height = bytes.readUInt16LE(28) & 0x3fff
    return { width, height }
  }
  return undefined
}

/**
 * Reject any path segment that is not a single plain name.
 *
 * `%` is refused as well: callers must percent-DECODE url segments before
 * calling in (the router does), so a leftover `%2f`/`%5c` here can only be a
 * traversal attempt hiding behind encoding. Our own note ids are UUIDs and our
 * on-disk file names are `<attachmentId>.<ext>`, so no legitimate name needs it.
 */
function assertSafeSegment(segment: unknown, label: string): string {
  if (typeof segment !== 'string' || segment.length === 0) {
    throw new AttachmentPathError(`${label} must be a non-empty string`)
  }
  if (segment === '.' || segment === '..') {
    throw new AttachmentPathError(`${label} must not be a relative path segment`)
  }
  if (/[\\/\u0000%]/.test(segment)) {
    throw new AttachmentPathError(`${label} must be a single percent-decoded path segment`)
  }
  return segment
}

/** True when `target` is the root itself or lives strictly inside it. */
function isInside(root: string, target: string): boolean {
  if (target === root) return true
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  return target.startsWith(prefix)
}

/** Directory holding one note's attachment files. */
export function noteAttachmentDir(root: string, noteId: string): string {
  const rootResolved = path.resolve(root)
  const safeNoteId = assertSafeSegment(noteId, 'noteId')
  const dir = path.resolve(rootResolved, safeNoteId)
  if (!isInside(rootResolved, dir)) {
    // Unreachable given assertSafeSegment, kept as defense in depth.
    throw new AttachmentPathError('noteId escapes the attachments root')
  }
  return dir
}

/**
 * Absolute path of one attachment file, with directory-traversal protection.
 *
 * Both segments are validated as single names and the resolved result is
 * required to stay inside `root`; anything else is a 400.
 */
export function resolveAttachmentPath(root: string, noteId: string, file: string): string {
  const rootResolved = path.resolve(root)
  const safeNoteId = assertSafeSegment(noteId, 'noteId')
  const safeFile = assertSafeSegment(file, 'file')
  const resolved = path.resolve(rootResolved, safeNoteId, safeFile)
  if (!isInside(rootResolved, resolved)) {
    throw new AttachmentPathError('attachment path escapes the attachments root')
  }
  return resolved
}

/** Input shape accepted by {@link saveAttachment} (mirrors the client upload payload). */
export interface AttachmentUploadInput {
  name?: string
  /** MIME declared by the client; advisory — the data URL MIME is authoritative. */
  mime?: string
  /** Declared byte size; advisory — the decoded byte length is authoritative. */
  size?: number
  dataUrl: string
}

/** Options for {@link saveAttachment}. */
export interface SaveAttachmentOptions {
  /** Per-image byte cap; defaults to {@link MAX_IMAGE_BYTES} (10 MB). */
  maxBytes?: number
  /** Per-note image cap (`prefs.maxImagesPerNote`). */
  maxImages?: number
  /** Images already attached to the note (counted against `maxImages`). */
  existingCount?: number
  /** Injectable id factory (tests). */
  newId?: () => string
  /** Injectable clock (tests). */
  now?: () => number
}

/**
 * Validate one upload payload and decode its bytes, WITHOUT touching the disk.
 *
 * Both fences run here: the declared `{name, mime}` pair (a file named
 * `clip.mp4` is refused even when it claims to be `image/png`) and the MIME
 * carried by the data URL (which is what ends up on disk).
 *
 * @throws {UnsupportedMediaError} 415 for video payloads.
 * @throws {AttachmentError} 400 for malformed data URLs.
 */
export function decodeUpload(input: AttachmentUploadInput): { mime: string; bytes: Buffer } {
  if (isVideoFile({ type: input.mime, name: input.name })) {
    throw new UnsupportedMediaError('video files are not supported')
  }
  const { mime, bytes } = decodeDataUrl(input.dataUrl)
  if (isVideoFile({ type: mime, name: input.name })) {
    throw new UnsupportedMediaError('video files are not supported')
  }
  return { mime, bytes }
}

/**
 * Persist already-validated image bytes, returning the attachment descriptor.
 *
 * @throws {UnsupportedMediaError} 415 for video / non-image payloads.
 * @throws {AttachmentTooLargeError} 413 when the image exceeds `maxBytes`.
 * @throws {AttachmentLimitError} 413 when the note already holds `maxImages` images.
 */
export async function storeAttachmentBytes(
  root: string,
  noteId: string,
  input: { name?: string; mime: string; bytes: Buffer },
  options: SaveAttachmentOptions = {},
): Promise<NotebookAttachment> {
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES
  const newId = options.newId ?? randomUUID
  const now = options.now ?? Date.now

  const mime = assertSupportedImage({ name: input.name, mime: input.mime })
  if (input.bytes.length > maxBytes) {
    throw new AttachmentTooLargeError(
      `image is too large: ${input.bytes.length} bytes exceeds the ${maxBytes} byte limit`,
    )
  }
  if (
    typeof options.maxImages === 'number' &&
    typeof options.existingCount === 'number' &&
    options.existingCount >= options.maxImages
  ) {
    throw new AttachmentLimitError(`a note may hold at most ${options.maxImages} images`)
  }

  const noteDir = noteAttachmentDir(root, noteId)
  const id = newId()
  const ext = extForMime(mime)
  const fileName = `${id}.${ext}`
  await mkdir(noteDir, { recursive: true })
  await writeFile(path.join(noteDir, fileName), input.bytes, { mode: 0o600 })

  const attachment: NotebookAttachment = {
    id,
    name: sanitizeFileName(input.name) || fileName,
    mime,
    size: input.bytes.length,
    relPath: `${noteId}/${fileName}`,
    createdAt: now(),
  }
  const size = readImageSize(input.bytes, mime)
  if (size) {
    attachment.width = size.width
    attachment.height = size.height
  }
  return attachment
}

/**
 * Decode, validate and persist one image, returning its descriptor.
 *
 * @throws {UnsupportedMediaError} 415 for video / non-image payloads.
 * @throws {AttachmentTooLargeError} 413 when the image exceeds `maxBytes`.
 * @throws {AttachmentLimitError} 413 when the note already holds `maxImages` images.
 */
export async function saveAttachment(
  root: string,
  noteId: string,
  input: AttachmentUploadInput,
  options: SaveAttachmentOptions = {},
): Promise<NotebookAttachment> {
  const { mime, bytes } = decodeUpload(input)
  return storeAttachmentBytes(root, noteId, { name: input.name, mime, bytes }, options)
}

/** Read one attachment back from disk. */
export async function readAttachment(
  root: string,
  noteId: string,
  file: string,
): Promise<{ bytes: Buffer; mime: string }> {
  const resolved = resolveAttachmentPath(root, noteId, file)
  const mime = mimeForExt(path.extname(resolved))
  if (!mime) {
    throw new AttachmentNotFoundError(`attachment "${file}" has an unsupported extension`)
  }
  try {
    const bytes = await readFile(resolved)
    return { bytes, mime }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR' || code === 'ENAMETOOLONG') {
      throw new AttachmentNotFoundError(`attachment "${file}" was not found`)
    }
    throw error
  }
}

/** Remove one attachment file; missing files are not an error. */
export async function removeAttachment(root: string, noteId: string, fileOrRelPath: string): Promise<void> {
  const fileName = String(fileOrRelPath).split(/[\\/]/).pop() ?? ''
  if (fileName.length === 0) return
  const resolved = resolveAttachmentPath(root, noteId, fileName)
  await rm(resolved, { force: true })
}

/** Remove a whole note's attachment directory (used by note deletion). */
export async function removeNoteAttachmentDir(root: string, noteId: string): Promise<void> {
  const dir = noteAttachmentDir(root, noteId)
  await rm(dir, { recursive: true, force: true })
}

/**
 * Response headers for one attachment.
 *
 * SVG is dangerous in a way raster images are not: an `<img src=...>` pointing at
 * an SVG with an embedded `<script>` can execute in this document's origin in
 * some browsers. We therefore always serve `nosniff` + `inline`, and add a
 * `default-src 'none'` CSP for SVG (with `style-src 'unsafe-inline'` so ordinary
 * SVG style attributes still render) to neutralize script and network access.
 * `Cache-Control: no-store` keeps deleted images from lingering in the browser
 * cache, matching every other response of this API.
 */
export function imageResponseHeaders(mime: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
  }
  if (normalizeMime(mime) === 'image/svg+xml') {
    headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'"
  }
  return headers
}
