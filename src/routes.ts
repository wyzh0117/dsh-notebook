/**
 * Host HTTP API for dsh-notebook.
 *
 * `createNotebookRouter` returns a pure request handler: it only touches
 * `node:http` / `node:url` plus the plugin's own modules, so tests can mount it
 * on a real `http.createServer(handler)` and drive it with `fetch`.
 *
 * Registered by `src/index.ts` on the DSH web server as
 * `{ kind: 'prefix', path: '/notebook/api' }`; the handler strips that prefix
 * itself, so `req.url` arrives as `/notebook/api/state` etc.
 *
 * Contract:
 *
 * | method | path                            | response                     |
 * |--------|---------------------------------|------------------------------|
 * | GET    | /state                          | `{ doc, degraded }`          |
 * | POST   | /notes                          | `{ note }`                   |
 * | PATCH  | /notes/:id                      | `{ note }`                   |
 * | DELETE | /notes/:id                      | `{ ok: true }`               |
 * | PATCH  | /prefs                          | `{ prefs }`                  |
 * | GET    | /attachments/:noteId/:file      | image bytes + headers        |
 * | GET    | /health                         | `{ ok, version, degraded }`  |
 *
 * Every response carries `Cache-Control: no-store`; every failure is a
 * structured `{ error: { code, message } }` with a matching status code.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AttachmentError,
  decodeUpload,
  imageResponseHeaders,
  readAttachment,
  removeAttachment,
  removeNoteAttachmentDir,
  storeAttachmentBytes,
  type AttachmentUploadInput,
} from './attachments'
import {
  ATTACHMENT_MARKER_RE,
  MAX_REQUEST_BYTES,
  attachmentMarker,
  parseAttachmentMarkers,
  type AttachmentMarkerRef,
  type NotebookAttachment,
  type NotebookPrefs,
} from './shared/types'
import { NoteNotFoundError, newNoteId, type NotebookStore } from './store'

/** Route prefix this handler owns (must match the registration in `src/index.ts`). */
export const NOTEBOOK_API_PREFIX = '/notebook/api'

/** Default request-body cap (32 MB); overridable through the plugin config. */
export const DEFAULT_MAX_BODY_BYTES = MAX_REQUEST_BYTES

/** Accepted range for `prefs.maxImagesPerNote`. */
const MAX_IMAGES_PER_NOTE_MAX = 100

/** Sources allowed to reach this API: the loopback interface only. */
const LOOPBACK_ADDRESSES: readonly string[] = ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']

/** Host names accepted in `Origin` / `Host`. */
const LOOPBACK_HOSTNAMES: readonly string[] = ['127.0.0.1', 'localhost', '::1', '[::1]']

/** A structured HTTP failure carrying its status code. */
export class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

/** Options for {@link createNotebookRouter}. */
export interface NotebookRouterOptions {
  store: NotebookStore
  /** Attachments root, i.e. `<DSH_HOME>/storages/notebook-attachments`. */
  root: string
  /** Plugin version reported by `/health`. */
  version: string
  /** Request body cap in bytes. */
  maxBodyBytes?: number
  /** Extra host names to trust besides loopback (escape hatch for exotic setups). */
  allowedHostnames?: readonly string[]
}

/** The handler returned by {@link createNotebookRouter}; `false` = not our path. */
export type NotebookRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    throw new HttpError(400, 'INVALID_PATH', 'path segment is not valid percent-encoding')
  }
}

function decodeNoteId(segment: string): string {
  const decoded = decodeSegment(segment)
  if (decoded.length === 0 || decoded === '.' || decoded === '..' || /[\\/\u0000]/.test(decoded)) {
    throw new HttpError(400, 'INVALID_PATH', 'invalid note id')
  }
  return decoded
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', String(Buffer.byteLength(text)))
  if (status === 413) res.setHeader('Connection', 'close')
  res.end(text)
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } })
}

/**
 * Read the request body with a streaming size cap.
 *
 * The check happens per chunk, so a 33 MB upload never reaches memory. Node
 * discards the unread remainder of the request after we answer, which keeps the
 * 413 response deliverable without a socket reset race.
 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false

    const cleanup = (): void => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.length
      if (total > limit) {
        fail(new HttpError(413, 'PAYLOAD_TOO_LARGE', `request body exceeds ${limit} bytes`))
        return
      }
      chunks.push(buffer)
    }
    const onEnd = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks))
    }
    const onError = (error: Error): void => {
      fail(error)
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

async function readJsonObject(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const raw = await readBody(req, limit)
  if (raw.length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new HttpError(400, 'BAD_JSON', 'request body is not valid JSON')
  }
  if (!isRecord(parsed)) throw new HttpError(400, 'BAD_REQUEST', 'request body must be a JSON object')
  return parsed
}

/** Either a freshly uploaded image (dataUrl) or a reference to a stored one (id). */
type IncomingAttachment = { kind: 'new'; input: AttachmentUploadInput } | { kind: 'existing'; id: string }

function asAttachmentInputs(value: unknown): IncomingAttachment[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new HttpError(400, 'BAD_REQUEST', '"attachments" must be an array')
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new HttpError(400, 'BAD_REQUEST', `attachments[${index}] must be an object`)
    const dataUrl = entry.dataUrl
    if (typeof dataUrl === 'string' && dataUrl.length > 0) {
      const input: AttachmentUploadInput = { dataUrl }
      if (typeof entry.name === 'string') input.name = entry.name
      if (typeof entry.mime === 'string') input.mime = entry.mime
      if (typeof entry.size === 'number') input.size = entry.size
      return { kind: 'new', input }
    }
    const id = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : undefined
    if (id) return { kind: 'existing', id }
    throw new HttpError(
      400,
      'BAD_REQUEST',
      `attachments[${index}] needs either "dataUrl" (new image) or "id" (existing image)`,
    )
  })
}

function requireStringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new HttpError(400, 'BAD_REQUEST', `field "${field}" must be a string`)
  return value
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (typeof address !== 'string') return false
  return LOOPBACK_ADDRESSES.includes(address)
}

function isTrustedHostname(hostname: string, allowed: readonly string[]): boolean {
  return allowed.includes(hostname)
}

/**
 * Point pending image markers at the ids the host just assigned.
 *
 * The upload payload carries `{ name, mime, size, dataUrl }` with no id, so a
 * client cannot know an attachment's id before it is stored. Markers it writes
 * for fresh images therefore carry a placeholder id; the marker's alt text is
 * the file name, which is exactly the correlation key. Markers whose id is
 * already known are left untouched.
 *
 * Matching order: file name (alt text), then positional pairing when the number
 * of leftover markers equals the number of leftover new attachments. When
 * neither lines up the body is returned unchanged — the host never invents a
 * mapping it cannot justify.
 */
export function rewriteNewAttachmentMarkers(
  body: string,
  knownIds: ReadonlySet<string>,
  saved: readonly NotebookAttachment[],
): string {
  if (body.length === 0 || saved.length === 0) return body
  const markers = parseAttachmentMarkers(body)
  const unused = [...saved]
  /** Raw marker text → replacement, queued per occurrence. */
  const queues = new Map<string, string[]>()
  const assign = (raw: string, replacement: string): void => {
    const queue = queues.get(raw)
    if (queue) queue.push(replacement)
    else queues.set(raw, [replacement])
  }
  const handled = new Set<AttachmentMarkerRef>()

  for (const marker of markers) {
    if (knownIds.has(marker.id)) continue
    const index = unused.findIndex((attachment) => attachment.name === marker.alt)
    if (index < 0) continue
    const attachment = unused.splice(index, 1)[0]
    if (!attachment) continue
    assign(marker.raw, attachmentMarker(attachment.id, marker.alt))
    handled.add(marker)
  }

  const remaining = markers.filter((marker) => !knownIds.has(marker.id) && !handled.has(marker))
  if (remaining.length > 0 && remaining.length === unused.length) {
    remaining.forEach((marker, index) => {
      const attachment = unused[index]
      if (attachment) assign(marker.raw, attachmentMarker(attachment.id, marker.alt))
    })
  }
  if (queues.size === 0) return body

  const re = new RegExp(ATTACHMENT_MARKER_RE.source, 'g')
  return body.replace(re, (whole) => {
    const queue = queues.get(whole)
    if (!queue || queue.length === 0) return whole
    return queue.shift() ?? whole
  })
}

/** Read-only list of attachment descriptors. */
type NotebookAttachmentList = readonly NotebookAttachment[]

/** Drop repeated ids, keeping the first occurrence (two uploads can share a file). */
function uniqueAttachments(list: NotebookAttachmentList): NotebookAttachment[] {
  const seen = new Set<string>()
  const unique: NotebookAttachment[] = []
  for (const attachment of list) {
    if (seen.has(attachment.id)) continue
    seen.add(attachment.id)
    unique.push(attachment)
  }
  return unique
}

/** Everything {@link storeUploads} needs to persist one request's images. */
interface UploadContext {
  root: string
  noteId: string
  /** Attachments the note already stores at the start of this request. */
  existing: NotebookAttachmentList
  /** `prefs.maxImagesPerNote`. */
  maxImages: number
  /** Images already attached to the note (counted against `maxImages`). */
  existingCount: number
}

/** Outcome of persisting one request's uploads. */
interface UploadResolution {
  /** Descriptors written to disk by THIS request (removed again if the request fails). */
  saved: NotebookAttachment[]
  /** One descriptor per uploaded image, in upload order (freshly stored or reused). */
  resolved: NotebookAttachment[]
}

/**
 * Store the uploaded images of one request, reusing identical bytes the note
 * already holds.
 *
 * The client re-uploads every image of a note whenever the image set changes,
 * so without this check each edit would duplicate every picture on disk.
 * Identity is the byte content: equal bytes are the same image.
 */
async function storeUploads(
  uploads: readonly AttachmentUploadInput[],
  context: UploadContext,
): Promise<UploadResolution> {
  const saved: NotebookAttachment[] = []
  const resolved: NotebookAttachment[] = []
  /** Attachment id → stored bytes (read on demand, `undefined` = unreadable). */
  const cache = new Map<string, Buffer | undefined>()

  try {
    for (const upload of uploads) {
      // Decode and fence first: a refused upload must never reach the disk.
      const { mime, bytes } = decodeUpload(upload)
      const reusable = await findIdenticalAttachment(context, saved, bytes, mime, cache)
      if (reusable) {
        resolved.push(reusable)
        continue
      }
      const attachment = await storeAttachmentBytes(
        context.root,
        context.noteId,
        { name: upload.name, mime, bytes },
        { maxImages: context.maxImages, existingCount: context.existingCount + saved.length },
      )
      saved.push(attachment)
      resolved.push(attachment)
    }
  } catch (error) {
    // All or nothing: a refused upload must not leave the earlier ones of the
    // same request orphaned on disk.
    for (const attachment of saved) {
      await removeAttachment(context.root, context.noteId, attachment.relPath).catch(() => undefined)
    }
    throw error
  }
  return { saved, resolved }
}

/** Find a stored attachment whose bytes equal this upload. */
async function findIdenticalAttachment(
  context: UploadContext,
  savedByThisRequest: NotebookAttachmentList,
  bytes: Buffer,
  mime: string,
  cache: Map<string, Buffer | undefined>,
): Promise<NotebookAttachment | undefined> {
  for (const candidate of [...context.existing, ...savedByThisRequest]) {
    if (candidate.mime !== mime || candidate.size !== bytes.length) continue
    if (!cache.has(candidate.id)) {
      const fileName = candidate.relPath.split('/').pop() ?? ''
      const stored = await readAttachment(context.root, context.noteId, fileName)
        .then((read) => read.bytes)
        .catch(() => undefined)
      cache.set(candidate.id, stored)
    }
    const stored = cache.get(candidate.id)
    if (stored && stored.equals(bytes)) return candidate
  }
  return undefined
}

/**
 * Create the notebook request handler.
 *
 * @returns a handler that resolves `true` when it owned the request (including
 *   every error response) and `false` when the path is not under
 *   {@link NOTEBOOK_API_PREFIX}.
 */
export function createNotebookRouter(options: NotebookRouterOptions): NotebookRequestHandler {
  const { store, root, version } = options
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const allowedHostnames = [...LOOPBACK_HOSTNAMES, ...(options.allowedHostnames ?? [])]

  async function handleState(res: ServerResponse): Promise<void> {
    const doc = await store.getDoc()
    const payload: Record<string, unknown> = { doc, degraded: store.degraded }
    if (store.degraded) payload.degradedReason = store.degradedReason
    sendJson(res, 200, payload)
  }

  function handleHealth(res: ServerResponse): void {
    sendJson(res, 200, { ok: true, version, degraded: store.degraded })
  }

  async function handleCreateNote(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonObject(req, maxBodyBytes)
    const title = requireStringField(body, 'title') ?? ''
    const noteBody = requireStringField(body, 'body') ?? ''
    const inputs = asAttachmentInputs(body.attachments) ?? []
    const prefs = await store.getPrefs()

    // The note id is allocated before the images are written because the
    // attachment directory is keyed by it.
    const noteId = newNoteId()
    let created = false
    try {
      const uploads: AttachmentUploadInput[] = []
      for (const entry of inputs) {
        if (entry.kind === 'new') uploads.push(entry.input) // A new note cannot reference stored images.
      }
      const { resolved } = await storeUploads(uploads, {
        root,
        noteId,
        existing: [],
        maxImages: prefs.maxImagesPerNote,
        existingCount: 0,
      })
      const knownIds = new Set(resolved.map((item) => item.id))
      const finalBody = rewriteNewAttachmentMarkers(noteBody, knownIds, resolved)
      const note = await store.createNote({
        id: noteId,
        title,
        body: finalBody,
        // Two identical uploads share one stored file, so the note lists it once.
        attachments: uniqueAttachments(resolved),
      })
      created = true
      sendJson(res, 200, { note })
    } catch (error) {
      if (!created) await removeNoteAttachmentDir(root, noteId).catch(() => undefined)
      throw error
    }
  }

  async function handleUpdateNote(req: IncomingMessage, res: ServerResponse, rawId: string): Promise<void> {
    const id = decodeNoteId(rawId)
    const body = await readJsonObject(req, maxBodyBytes)
    const title = requireStringField(body, 'title')
    const noteBody = requireStringField(body, 'body')
    const inputs = asAttachmentInputs(body.attachments)

    const doc = await store.getDoc()
    const existing = doc.notes.find((note) => note.id === id)
    if (!existing) throw new HttpError(404, 'NOT_FOUND', `note "${id}" was not found`)

    const prefs = await store.getPrefs()
    const uploads: AttachmentUploadInput[] = []
    const keepIds: string[] = []
    for (const entry of inputs ?? []) {
      if (entry.kind === 'existing') keepIds.push(entry.id)
      else uploads.push(entry.input)
    }

    // `storeUploads` is all-or-nothing: on failure it removes whatever it wrote.
    const outcome = await storeUploads(uploads, {
      root,
      noteId: id,
      existing: existing.attachments,
      maxImages: prefs.maxImagesPerNote,
      existingCount: existing.attachments.length,
    })
    const { saved, resolved } = outcome

    let committed = false
    try {
      const knownIds = new Set<string>([
        ...existing.attachments.map((item) => item.id),
        ...resolved.map((item) => item.id),
      ])
      const finalBody = noteBody === undefined ? undefined : rewriteNewAttachmentMarkers(noteBody, knownIds, resolved)
      const note = await store.updateNote(id, {
        title,
        body: finalBody,
        newAttachments: saved,
        keepAttachmentIds: inputs === undefined ? undefined : keepIds,
      })
      committed = true
      sendJson(res, 200, { note })
    } catch (error) {
      // The note itself is untouched on failure, so only the images uploaded by
      // this request are orphaned and must be removed.
      if (!committed) {
        for (const attachment of saved) {
          await removeAttachment(root, id, attachment.relPath).catch(() => undefined)
        }
      }
      throw error
    }
  }

  async function handleDeleteNote(res: ServerResponse, rawId: string): Promise<void> {
    const id = decodeNoteId(rawId)
    const removed = await store.deleteNote(id)
    if (!removed) throw new HttpError(404, 'NOT_FOUND', `note "${id}" was not found`)
    sendJson(res, 200, { ok: true })
  }

  async function handleUpdatePrefs(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonObject(req, maxBodyBytes)
    const patch: Partial<NotebookPrefs> = {}
    if ('sortOrder' in body) {
      const value = body.sortOrder
      if (value !== 'updated' && value !== 'created' && value !== 'title') {
        throw new HttpError(400, 'BAD_REQUEST', 'prefs.sortOrder must be one of updated|created|title')
      }
      patch.sortOrder = value
    }
    for (const key of ['copyImagesAsName', 'confirmDelete', 'openOnStart', 'autoOpenOnNewSession'] as const) {
      if (!(key in body)) continue
      const value = body[key]
      if (typeof value !== 'boolean') throw new HttpError(400, 'BAD_REQUEST', `prefs.${key} must be a boolean`)
      patch[key] = value
    }
    if ('maxImagesPerNote' in body) {
      const value = body.maxImagesPerNote
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > MAX_IMAGES_PER_NOTE_MAX
      ) {
        throw new HttpError(
          400,
          'BAD_REQUEST',
          `prefs.maxImagesPerNote must be an integer between 1 and ${MAX_IMAGES_PER_NOTE_MAX}`,
        )
      }
      patch.maxImagesPerNote = value
    }
    const prefs = await store.updatePrefs(patch)
    sendJson(res, 200, { prefs })
  }

  async function handleAttachment(res: ServerResponse, rawNoteId: string, rawFile: string): Promise<void> {
    const noteId = decodeSegment(rawNoteId)
    const file = decodeSegment(rawFile)
    const { bytes, mime } = await readAttachment(root, noteId, file)
    res.statusCode = 200
    for (const [name, value] of Object.entries(imageResponseHeaders(mime))) res.setHeader(name, value)
    res.setHeader('Content-Length', String(bytes.length))
    res.end(bytes)
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
      const rawUrl = req.url ?? '/'
      // `new URL` normalizes plain `..` segments away (and WHATWG treats `%2e%2e`
      // as a dot segment too), so a literal traversal collapses into an unknown
      // route (404) while an ENCODED separator (`..%2f`) survives and is caught
      // by the segment validation below (400). Both are refused.
      const pathname = new URL(rawUrl, 'http://127.0.0.1').pathname
      const relative = stripPrefix(pathname)
      if (relative === undefined) return false

      if (!isLoopbackAddress(req.socket?.remoteAddress)) {
        throw new HttpError(403, 'FORBIDDEN', 'notebook API is only reachable from loopback')
      }
      const host = req.headers.host
      if (typeof host === 'string' && host.length > 0) {
        let hostname: string
        try {
          hostname = new URL(`http://${host}`).hostname
        } catch {
          throw new HttpError(403, 'FORBIDDEN', 'invalid Host header')
        }
        if (!isTrustedHostname(hostname, allowedHostnames)) {
          throw new HttpError(403, 'FORBIDDEN', `Host "${hostname}" is not a loopback host`)
        }
      }
      const origin = req.headers.origin
      if (typeof origin === 'string' && origin.length > 0) {
        if (origin === 'null') throw new HttpError(403, 'FORBIDDEN', 'Origin "null" is not allowed')
        let parsed: URL
        try {
          parsed = new URL(origin)
        } catch {
          throw new HttpError(403, 'FORBIDDEN', 'invalid Origin header')
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new HttpError(403, 'FORBIDDEN', `Origin protocol "${parsed.protocol}" is not allowed`)
        }
        if (!isTrustedHostname(parsed.hostname, allowedHostnames)) {
          throw new HttpError(403, 'FORBIDDEN', `Origin "${parsed.hostname}" is not a loopback host`)
        }
      }

      const segments = relative.split('/').filter((segment) => segment.length > 0)
      const method = (req.method ?? 'GET').toUpperCase()
      const first: string | undefined = segments[0]
      const second: string | undefined = segments[1]

      // Lazily create/load the document up front so `/health` and `/state` report
      // the real degraded flag (initialization also probes writability).
      await store.init()

      if (segments.length === 1 && first === 'state' && method === 'GET') {
        await handleState(res)
        return true
      }
      if (segments.length === 1 && first === 'health' && method === 'GET') {
        handleHealth(res)
        return true
      }
      if (segments.length === 1 && first === 'notes' && method === 'POST') {
        await handleCreateNote(req, res)
        return true
      }
      if (segments.length === 2 && first === 'notes' && second !== undefined) {
        if (method === 'PATCH') {
          await handleUpdateNote(req, res, second)
          return true
        }
        if (method === 'DELETE') {
          await handleDeleteNote(res, second)
          return true
        }
      }
      if (segments.length === 1 && first === 'prefs' && method === 'PATCH') {
        await handleUpdatePrefs(req, res)
        return true
      }
      if (segments.length === 3 && first === 'attachments' && method === 'GET') {
        const [, noteId, file] = segments
        if (noteId === undefined || file === undefined) {
          throw new HttpError(400, 'INVALID_PATH', 'attachment path needs a note id and a file name')
        }
        await handleAttachment(res, noteId, file)
        return true
      }

      throw new HttpError(404, 'NOT_FOUND', `no notebook route for ${method} ${pathname}`)
    } catch (error) {
      if (res.headersSent) {
        try {
          res.end()
        } catch {
          // The response is already gone; nothing else to do.
        }
        return true
      }
      if (error instanceof HttpError) {
        sendError(res, error.status, error.code, error.message)
        return true
      }
      if (error instanceof NoteNotFoundError) {
        sendError(res, 404, 'NOT_FOUND', error.message)
        return true
      }
      if (error instanceof AttachmentError) {
        sendError(res, error.status, error.code, error.message)
        return true
      }
      sendError(res, 500, 'INTERNAL_ERROR', (error as Error)?.message ?? 'internal error')
      return true
    }
  }
}

/** Strip {@link NOTEBOOK_API_PREFIX}; `undefined` means "not our path". */
function stripPrefix(pathname: string): string | undefined {
  if (pathname === NOTEBOOK_API_PREFIX) return '/'
  if (pathname.startsWith(`${NOTEBOOK_API_PREFIX}/`)) return pathname.slice(NOTEBOOK_API_PREFIX.length)
  return undefined
}
