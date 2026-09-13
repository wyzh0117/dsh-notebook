/**
 * Browser-side HTTP client for the host HTTP API (design spec §6).
 *
 * Everything the client half knows about the host goes through this module, so
 * the UI components never see `fetch`, status codes, or the error envelope.
 * Non-2xx responses are normalised into {@link NotebookApiError}, which carries
 * the host's `{ error: { code, message } }` envelope verbatim so the UI can show
 * the real reason instead of swallowing it.
 *
 * Purity: this file runs inside the client bundle's CJS module table — no
 * `node:*` imports, no `@deepseek-ai/*` value imports (only `import type` from
 * the dependency-free `../shared/types`).
 */
import { DEFAULT_PREFS } from '../shared/types'
import type { NotebookDoc, NotebookNote, NotebookPrefs } from '../shared/types'

/** One image as it travels to the host: bytes ride along as a data URL (§6). */
export interface NewAttachmentInput {
  name: string
  mime: string
  size: number
  dataUrl: string
}

/** The frozen client surface every sidebar tier renders against. */
export interface NotebookApiClient {
  getState(): Promise<{ doc: NotebookDoc; degraded: boolean }>
  createNote(input: { title: string; body: string; attachments: NewAttachmentInput[] }): Promise<NotebookNote>
  updateNote(id: string, patch: { title?: string; body?: string; attachments?: NewAttachmentInput[] }): Promise<NotebookNote>
  deleteNote(id: string): Promise<void>
  updatePrefs(patch: Partial<NotebookPrefs>): Promise<NotebookPrefs>
  attachmentUrl(noteId: string, relPath: string): string
}

/** The host registers its router under this prefix (spec §6). */
export const DEFAULT_API_BASE = '/notebook/api'

/**
 * Any failed API call. `code` is the host's error code when it sent one
 * (`not_found`, `unsupported_media`, …), otherwise a synthetic one
 * (`http_500`, `network`, `bad_response`). `status` is the HTTP status, and 0
 * when the request never reached the host (offline / aborted).
 */
export class NotebookApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number, message?: string) {
    super(message && message.length > 0 ? message : code)
    this.name = 'NotebookApiError'
    this.code = code
    this.status = status
    // Keeps `instanceof` working when the class is transpiled down a level.
    Object.setPrototypeOf(this, NotebookApiError.prototype)
  }
}

/** Human-readable text for anything thrown by this module (never "" ). */
export function apiErrorMessage(error: unknown): string {
  if (error instanceof NotebookApiError) return error.message || error.code
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string' && error.length > 0) return error
  return 'unknown error'
}

/** Last path segment of a relPath, with separators stripped (`..` safe). */
function baseName(relPath: string): string {
  const parts = String(relPath ?? '')
    .split(/[\\/]+/)
    .filter((part) => part.length > 0)
  const last = parts.length > 0 ? parts[parts.length - 1] : ''
  return last === '' || last === '.' || last === '..' ? '_' : last
}

function segment(value: string): string {
  return encodeURIComponent(String(value ?? ''))
}

function normalizePrefs(raw: unknown): NotebookPrefs {
  const source = raw !== null && typeof raw === 'object' ? (raw as Partial<NotebookPrefs>) : {}
  const sortOrder =
    source.sortOrder === 'created' || source.sortOrder === 'title' || source.sortOrder === 'updated'
      ? source.sortOrder
      : DEFAULT_PREFS.sortOrder
  return {
    sortOrder,
    copyImagesAsName:
      typeof source.copyImagesAsName === 'boolean' ? source.copyImagesAsName : DEFAULT_PREFS.copyImagesAsName,
    maxImagesPerNote:
      typeof source.maxImagesPerNote === 'number' && Number.isFinite(source.maxImagesPerNote) && source.maxImagesPerNote > 0
        ? Math.floor(source.maxImagesPerNote)
        : DEFAULT_PREFS.maxImagesPerNote,
    confirmDelete: typeof source.confirmDelete === 'boolean' ? source.confirmDelete : DEFAULT_PREFS.confirmDelete,
    openOnStart: typeof source.openOnStart === 'boolean' ? source.openOnStart : DEFAULT_PREFS.openOnStart,
  }
}

function normalizeNote(raw: unknown): NotebookNote {
  const note = (raw ?? {}) as Partial<NotebookNote>
  const now = Date.now()
  return {
    id: typeof note.id === 'string' ? note.id : '',
    title: typeof note.title === 'string' ? note.title : '',
    body: typeof note.body === 'string' ? note.body : '',
    attachments: Array.isArray(note.attachments) ? note.attachments : [],
    createdAt: typeof note.createdAt === 'number' ? note.createdAt : now,
    updatedAt: typeof note.updatedAt === 'number' ? note.updatedAt : now,
  }
}

function normalizeDoc(raw: unknown): NotebookDoc {
  const doc = (raw ?? {}) as Partial<NotebookDoc>
  return {
    version: 1,
    notes: Array.isArray(doc.notes) ? doc.notes.map(normalizeNote) : [],
    prefs: normalizePrefs(doc.prefs),
  }
}

/**
 * Build a client bound to one base path. `base` defaults to
 * {@link DEFAULT_API_BASE}; pass an explicit base for tests or for a host
 * mounted somewhere else.
 */
export function createNotebookApi(options?: { base?: string }): NotebookApiClient {
  const base = (options?.base ?? DEFAULT_API_BASE).replace(/\/+$/, '')

  async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const fetcher = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined
    if (!fetcher) throw new NotebookApiError('no_fetch', 0, 'fetch is unavailable in this environment')
    const method = init?.method ?? 'GET'
    const hasBody = init?.body !== undefined
    let response: Response
    try {
      response = await fetcher(`${base}${path}`, {
        method,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: hasBody
          ? { accept: 'application/json', 'content-type': 'application/json' }
          : { accept: 'application/json' },
        body: hasBody ? JSON.stringify(init?.body) : undefined,
      })
    } catch (error) {
      throw new NotebookApiError('network', 0, apiErrorMessage(error))
    }

    const text = await response.text().catch(() => '')
    let parsed: unknown
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
    }

    if (!response.ok) {
      const envelope = parsed as { error?: { code?: string; message?: string } } | undefined
      const code = envelope?.error?.code ?? `http_${response.status}`
      const message = envelope?.error?.message ?? (text.length > 0 ? text : response.statusText) ?? code
      throw new NotebookApiError(code, response.status, message)
    }
    if (parsed === undefined) {
      throw new NotebookApiError('bad_response', response.status, 'the host did not return JSON')
    }
    return parsed as T
  }

  return {
    async getState() {
      const payload = await request<{ doc?: unknown; degraded?: unknown }>('/state')
      return { doc: normalizeDoc(payload.doc), degraded: payload.degraded === true }
    },

    async createNote(input) {
      const payload = await request<{ note?: unknown }>('/notes', { method: 'POST', body: input })
      return normalizeNote(payload.note)
    },

    async updateNote(id, patch) {
      const payload = await request<{ note?: unknown }>(`/notes/${segment(id)}`, { method: 'PATCH', body: patch })
      return normalizeNote(payload.note)
    },

    async deleteNote(id) {
      await request<{ ok?: boolean }>(`/notes/${segment(id)}`, { method: 'DELETE' })
    },

    async updatePrefs(patch) {
      const payload = await request<{ prefs?: unknown }>('/prefs', { method: 'PATCH', body: patch })
      return normalizePrefs(payload.prefs)
    },

    /** Only ever one path segment — a relPath can never smuggle `..` through. */
    attachmentUrl(noteId, relPath) {
      return `${base}/attachments/${segment(noteId)}/${segment(baseName(relPath))}`
    },
  }
}
