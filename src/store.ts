/**
 * Document persistence for the dsh-notebook host half.
 *
 * Storage layout (mirrors the DSH convention `$DSH_HOME/storages/*.json`):
 *
 * ```
 * $DSH_HOME/storages/notebook.json                  # the NotebookDoc
 * $DSH_HOME/storages/notebook.json.bak              # previous good version
 * $DSH_HOME/storages/notebook.json.corrupt-<ts>     # quarantined garbage
 * $DSH_HOME/storages/notebook-attachments/<noteId>/<attachmentId>.<ext>
 * ```
 *
 * Guarantees:
 *   - **atomic writes**: temp file → `fsync` → copy old file to `.bak` → `rename`;
 *   - **serialized read-modify-write**: every mutation runs on one promise chain,
 *     so concurrent requests cannot lose each other's updates;
 *   - **corruption recovery**: a broken document is restored from `.bak`, and both
 *     broken are quarantined instead of being silently overwritten;
 *   - **degraded mode**: when `$DSH_HOME` is unwritable the store keeps working in
 *     memory, reports `degraded: true` on every API response and warns loudly —
 *     it never pretends a write succeeded.
 *
 * The module depends only on `node:*`, `./shared/types` and `./attachments`.
 */

import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { removeAttachment, removeNoteAttachmentDir } from './attachments'
import {
  DEFAULT_PREFS,
  IMAGE_MIME_ALLOW,
  parseAttachmentIds,
  parseAttachmentMarkers,
  type NotebookAttachment,
  type NotebookDoc,
  type NotebookNote,
  type NotebookPrefs,
  type NotebookSortOrder,
} from './shared/types'

/** Resolved on-disk locations of the notebook. */
export interface NotebookPaths {
  homeDir: string
  storagesDir: string
  filePath: string
  backupPath: string
  attachmentsDir: string
}

/** One note id, `crypto.randomUUID()` based (safe as a directory name). */
export function newNoteId(): string {
  return randomUUID()
}

/** Resolve the DSH home directory: explicit argument > `DSH_HOME` > `~/.dsh`. */
export function resolveHomeDir(explicit?: string): string {
  const fromArgument = typeof explicit === 'string' && explicit.trim() !== '' ? explicit.trim() : undefined
  const fromEnv =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME.trim()
      : undefined
  const base = fromArgument ?? fromEnv ?? path.join(homedir(), '.dsh')
  return normalizeDir(expandTilde(base))
}

function expandTilde(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2))
  return value
}

function normalizeDir(value: string): string {
  return path.resolve(value).replace(/[/\\]+$/, '') || path.sep
}

/** All paths derived from one DSH home directory. */
export function notebookPaths(homeDir: string): NotebookPaths {
  const home = normalizeDir(expandTilde(homeDir))
  const storagesDir = path.join(home, 'storages')
  return {
    homeDir: home,
    storagesDir,
    filePath: path.join(storagesDir, 'notebook.json'),
    backupPath: path.join(storagesDir, 'notebook.json.bak'),
    attachmentsDir: path.join(storagesDir, 'notebook-attachments'),
  }
}

/** Thrown when a note id does not exist (mapped to HTTP 404 by the router). */
export class NoteNotFoundError extends Error {
  readonly code = 'NOT_FOUND'
  readonly status = 404
  readonly noteId: string

  constructor(noteId: string) {
    super(`note "${noteId}" was not found`)
    this.name = 'NoteNotFoundError'
    this.noteId = noteId
  }
}

/** Input accepted by {@link NotebookStore.createNote}. */
export interface NoteCreateInput {
  /** Pre-generated id (the router allocates it so attachments land in the right directory). */
  id?: string
  title?: string
  body?: string
  /** Attachment descriptors already persisted under `<attachmentsDir>/<noteId>/`. */
  attachments?: NotebookAttachment[]
}

/** Input accepted by {@link NotebookStore.updateNote}. */
export interface NoteUpdateInput {
  title?: string
  body?: string
  /** Newly persisted attachments, appended to the surviving list. */
  newAttachments?: NotebookAttachment[]
  /** Existing attachment ids the caller explicitly wants to keep. */
  keepAttachmentIds?: string[]
  /** When true, `newAttachments` becomes the complete list (no marker-based merging). */
  replaceAttachments?: boolean
}

/** The store surface used by the HTTP router. */
export interface NotebookStore {
  readonly homeDir: string
  readonly filePath: string
  readonly backupPath: string
  readonly attachmentsDir: string
  /** True when `$DSH_HOME` is unwritable and the document lives in memory only. */
  readonly degraded: boolean
  readonly degradedReason: string | undefined
  /** Every non-fatal warning the store raised (degraded mode, corruption recovery). */
  readonly warnings: readonly string[]
  /** Idempotent lazy initialization (creating directories and loading the document). */
  init(): Promise<void>
  getDoc(): Promise<NotebookDoc>
  getPrefs(): Promise<NotebookPrefs>
  createNote(input?: NoteCreateInput): Promise<NotebookNote>
  updateNote(id: string, patch: NoteUpdateInput): Promise<NotebookNote>
  /** @returns `false` when the note does not exist. */
  deleteNote(id: string): Promise<boolean>
  updatePrefs(patch: Partial<NotebookPrefs>): Promise<NotebookPrefs>
}

/** Options for {@link createNotebookStore}. */
export interface NotebookStoreOptions {
  /** DSH home directory; pass a temp directory in tests. */
  homeDir: string
  /** Warning sink; defaults to `console.warn` with a `[dsh-notebook]` prefix. */
  warn?: (message: string) => void
  /** Injectable clock (tests). */
  now?: () => number
  /** Injectable note id factory (tests). */
  newId?: () => string
}

function emptyDoc(): NotebookDoc {
  return { version: 1, notes: [], prefs: { ...DEFAULT_PREFS } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSortOrder(value: unknown): value is NotebookSortOrder {
  return value === 'updated' || value === 'created' || value === 'title'
}

/** Coerce an arbitrary value into a valid {@link NotebookPrefs} (unknown fields ignored). */
export function normalizePrefs(raw: unknown): NotebookPrefs {
  const prefs: NotebookPrefs = { ...DEFAULT_PREFS }
  if (!isRecord(raw)) return prefs
  if (isSortOrder(raw.sortOrder)) prefs.sortOrder = raw.sortOrder
  if (typeof raw.copyImagesAsName === 'boolean') prefs.copyImagesAsName = raw.copyImagesAsName
  if (typeof raw.confirmDelete === 'boolean') prefs.confirmDelete = raw.confirmDelete
  if (typeof raw.openOnStart === 'boolean') prefs.openOnStart = raw.openOnStart
  if (typeof raw.autoOpenOnNewSession === 'boolean') prefs.autoOpenOnNewSession = raw.autoOpenOnNewSession
  if (typeof raw.selectionToNotebook === 'boolean') prefs.selectionToNotebook = raw.selectionToNotebook
  if (typeof raw.messageToNotebook === 'boolean') prefs.messageToNotebook = raw.messageToNotebook
  if (typeof raw.maxImagesPerNote === 'number' && Number.isFinite(raw.maxImagesPerNote)) {
    const value = Math.floor(raw.maxImagesPerNote)
    if (value >= 1 && value <= 100) prefs.maxImagesPerNote = value
  }
  return prefs
}

function coerceAttachment(raw: unknown): NotebookAttachment | undefined {
  if (!isRecord(raw)) return undefined
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (id.length === 0) return undefined
  const mime = typeof raw.mime === 'string' && IMAGE_MIME_ALLOW.includes(raw.mime) ? raw.mime : 'image/png'
  const attachment: NotebookAttachment = {
    id,
    name: typeof raw.name === 'string' ? raw.name : id,
    mime,
    size: typeof raw.size === 'number' && raw.size >= 0 ? raw.size : 0,
    relPath: typeof raw.relPath === 'string' ? raw.relPath : id,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
  }
  if (typeof raw.width === 'number') attachment.width = raw.width
  if (typeof raw.height === 'number') attachment.height = raw.height
  return attachment
}

function coerceNote(raw: unknown): NotebookNote | undefined {
  if (!isRecord(raw)) return undefined
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (id.length === 0) return undefined
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments.map(coerceAttachment).filter((item): item is NotebookAttachment => item !== undefined)
    : []
  const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : 0
  const note: NotebookNote = {
    id,
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    attachments,
    createdAt,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : createdAt,
  }
  return note
}

/** Parse persisted JSON into a document, or `undefined` when it is unusable. */
export function parseDoc(text: string): NotebookDoc | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(raw)) return undefined
  if (raw.version !== 1) return undefined
  if (!Array.isArray(raw.notes)) return undefined
  const notes = raw.notes.map(coerceNote).filter((note): note is NotebookNote => note !== undefined)
  return { version: 1, notes, prefs: normalizePrefs(raw.prefs) }
}

/** Canonical persisted order: most recently updated first. */
export function sortByUpdated(notes: readonly NotebookNote[]): NotebookNote[] {
  return [...notes].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Sort for presentation according to `prefs.sortOrder`. */
export function sortNotes(notes: readonly NotebookNote[], order: NotebookSortOrder): NotebookNote[] {
  if (order === 'created') {
    return [...notes].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }
  if (order === 'title') {
    return [...notes].sort(
      (a, b) =>
        a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }) ||
        b.updatedAt - a.updatedAt ||
        (a.id < b.id ? -1 : 1),
    )
  }
  return sortByUpdated(notes)
}

function cloneNote(note: NotebookNote): NotebookNote {
  return { ...note, attachments: note.attachments.map((attachment) => ({ ...attachment })) }
}

function cloneDoc(doc: NotebookDoc): NotebookDoc {
  return { version: 1, notes: doc.notes.map(cloneNote), prefs: { ...doc.prefs } }
}

/**
 * Create the notebook store for one DSH home directory.
 *
 * The home directory is always injected (tests pass a temp directory); the
 * environment is never read at module scope.
 */
export function createNotebookStore(options: NotebookStoreOptions): NotebookStore {
  const paths = notebookPaths(options.homeDir)
  const newId = options.newId ?? newNoteId
  const now = options.now ?? Date.now
  const warnings: string[] = []
  const warn = (message: string): void => {
    warnings.push(message)
    if (options.warn) options.warn(message)
    else console.warn(`[dsh-notebook] ${message}`)
  }

  let doc: NotebookDoc = emptyDoc()
  let loaded = false
  let degraded = false
  let degradedReason: string | undefined
  let chain: Promise<unknown> = Promise.resolve()

  /** Serialize every read-modify-write cycle on one promise chain (mutex). */
  function withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function enterDegraded(error: unknown): void {
    const code = (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN'
    const message = (error as Error)?.message ?? String(error)
    degraded = true
    degradedReason = `${code}: ${message}`
    doc = emptyDoc()
    loaded = true
    warn(
      `$DSH_HOME is not writable (${degradedReason}); notebook is running in MEMORY-ONLY degraded mode ` +
        `and nothing will be persisted to ${paths.filePath}`,
    )
  }

  async function assertWritableDir(): Promise<void> {
    await mkdir(paths.storagesDir, { recursive: true })
    // A directory can exist yet be read-only; probe with a real write so the
    // degraded flag is trustworthy before we accept any mutation.
    const probe = path.join(paths.storagesDir, `.notebook-write-probe-${process.pid}-${randomUUID()}`)
    await writeFile(probe, 'ok', { mode: 0o600 })
    await unlink(probe)
  }

  /** Atomic write: temp file → fsync → copy old to `.bak` → rename. */
  async function writeAtomic(next: NotebookDoc): Promise<void> {
    await mkdir(paths.storagesDir, { recursive: true })
    const tmpPath = `${paths.filePath}.tmp`
    const json = `${JSON.stringify(next, null, 2)}\n`
    const handle = await open(tmpPath, 'w', 0o600)
    try {
      await handle.writeFile(json, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await copyFile(paths.filePath, paths.backupPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code !== 'ENOENT') throw error
    }
    await rename(tmpPath, paths.filePath)
  }

  async function quarantine(filePath: string): Promise<void> {
    const target = `${filePath}.corrupt-${Date.now()}`
    try {
      await rename(filePath, target)
      warn(`${path.basename(filePath)} was corrupt; kept it as ${path.basename(target)}`)
    } catch {
      // Best effort only: the quarantine name must never break startup.
    }
  }

  async function readTextIfExists(filePath: string): Promise<string | undefined> {
    try {
      return await readFile(filePath, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return undefined
      throw error
    }
  }

  async function loadDoc(): Promise<NotebookDoc> {
    const primaryText = await readTextIfExists(paths.filePath)
    const primary = primaryText === undefined ? undefined : parseDoc(primaryText)
    if (primary) return primary

    const backupText = await readTextIfExists(paths.backupPath)
    const backup = backupText === undefined ? undefined : parseDoc(backupText)

    if (primaryText !== undefined) {
      await quarantine(paths.filePath)
      if (backup) {
        warn('notebook.json was corrupt; restored it from notebook.json.bak')
        await writeAtomic(backup)
        return backup
      }
      if (backupText !== undefined) await quarantine(paths.backupPath)
      warn('notebook.json and notebook.json.bak were both unreadable; starting from an empty notebook')
      return emptyDoc()
    }

    if (backup) {
      // A crash between "copy to .bak" and "rename" leaves the primary missing.
      warn('notebook.json was missing; recovered it from notebook.json.bak')
      await writeAtomic(backup)
      return backup
    }
    if (backupText !== undefined) await quarantine(paths.backupPath)

    // First use: create the document lazily and leave a valid file behind.
    const fresh = emptyDoc()
    await writeAtomic(fresh)
    return fresh
  }

  async function ensureReady(): Promise<void> {
    if (loaded) return
    try {
      await assertWritableDir()
    } catch (error) {
      enterDegraded(error)
      return
    }
    try {
      doc = await loadDoc()
      loaded = true
    } catch (error) {
      enterDegraded(error)
    }
  }

  /** Persist the document; in degraded mode this is a no-op by design. */
  async function commit(next: NotebookDoc): Promise<void> {
    if (degraded) {
      doc = next
      return
    }
    // Write first: if the disk write fails the in-memory state stays untouched,
    // so the caller sees an error instead of a silent, unpersisted "success".
    await writeAtomic(next)
    doc = next
  }

  function findNote(target: NotebookDoc, id: string): NotebookNote | undefined {
    return target.notes.find((note) => note.id === id)
  }

  async function dropAttachmentFiles(noteId: string, attachments: readonly NotebookAttachment[]): Promise<void> {
    for (const attachment of attachments) {
      try {
        await removeAttachment(paths.attachmentsDir, noteId, attachment.relPath)
      } catch (error) {
        warn(`could not delete attachment ${attachment.relPath}: ${(error as Error)?.message ?? error}`)
      }
    }
  }

  const store: NotebookStore = {
    homeDir: paths.homeDir,
    filePath: paths.filePath,
    backupPath: paths.backupPath,
    attachmentsDir: paths.attachmentsDir,
    get degraded() {
      return degraded
    },
    get degradedReason() {
      return degradedReason
    },
    get warnings() {
      return warnings
    },

    init() {
      return withLock(async () => {
        await ensureReady()
      })
    },

    getDoc() {
      return withLock(async () => {
        await ensureReady()
        const snapshot = cloneDoc(doc)
        snapshot.notes = sortNotes(snapshot.notes, snapshot.prefs.sortOrder)
        return snapshot
      })
    },

    getPrefs() {
      return withLock(async () => {
        await ensureReady()
        return { ...doc.prefs }
      })
    },

    createNote(input: NoteCreateInput = {}) {
      return withLock(async () => {
        await ensureReady()
        const timestamp = now()
        const note: NotebookNote = {
          id: typeof input.id === 'string' && input.id.length > 0 ? input.id : newId(),
          title: typeof input.title === 'string' ? input.title.trim() : '',
          body: typeof input.body === 'string' ? input.body : '',
          attachments: (input.attachments ?? []).map((attachment) => ({ ...attachment })),
          createdAt: timestamp,
          updatedAt: timestamp,
        }
        if (findNote(doc, note.id)) {
          throw new Error(`note "${note.id}" already exists`)
        }
        const next = cloneDoc(doc)
        next.notes = sortByUpdated([note, ...next.notes])
        await commit(next)
        return cloneNote(note)
      })
    },

    updateNote(id: string, patch: NoteUpdateInput) {
      return withLock(async () => {
        await ensureReady()
        const current = findNote(doc, id)
        if (!current) throw new NoteNotFoundError(id)

        const next = cloneDoc(doc)
        const note = findNote(next, id)
        if (!note) throw new NoteNotFoundError(id)

        if (patch.title !== undefined) note.title = String(patch.title).trim()
        if (patch.body !== undefined) note.body = String(patch.body)

        if (patch.replaceAttachments || patch.newAttachments !== undefined || patch.keepAttachmentIds !== undefined) {
          const newAttachments = (patch.newAttachments ?? []).map((attachment) => ({ ...attachment }))
          let kept: NotebookAttachment[]
          if (patch.replaceAttachments) {
            kept = newAttachments
          } else {
            const nextBody = patch.body
            const nextRefs = nextBody === undefined ? undefined : new Set(parseAttachmentIds(nextBody))
            // The editor marks images by name too (`![<name>](attachment:<id>)`), so a
            // client that rewrites marker ids still keeps its existing images.
            const nextNames = new Set(parseAttachmentMarkers(nextBody ?? '').map((marker) => marker.alt))
            const oldRefs = new Set(parseAttachmentIds(current.body))
            const explicitKeep = new Set(patch.keepAttachmentIds ?? [])
            kept = current.attachments
              .filter((attachment) => {
                if (explicitKeep.has(attachment.id)) return true
                if (nextRefs === undefined) return true
                if (nextRefs.has(attachment.id)) return true
                if (nextNames.has(attachment.name)) return true
                // Defensive: an attachment the old body never referenced cannot be
                // recognized as "removed", so it is preserved rather than dropped.
                return !oldRefs.has(attachment.id)
              })
              .map((attachment) => ({ ...attachment }))
            kept.push(...newAttachments)
          }
          note.attachments = kept
        }

        note.updatedAt = now()
        next.notes = sortByUpdated(next.notes)
        await commit(next)

        const dropped = current.attachments.filter(
          (attachment) => !note.attachments.some((keptAttachment) => keptAttachment.id === attachment.id),
        )
        if (dropped.length > 0) await dropAttachmentFiles(id, dropped)
        return cloneNote(note)
      })
    },

    deleteNote(id: string) {
      return withLock(async () => {
        await ensureReady()
        if (!findNote(doc, id)) return false
        const next = cloneDoc(doc)
        next.notes = next.notes.filter((note) => note.id !== id)
        await commit(next)
        try {
          await removeNoteAttachmentDir(paths.attachmentsDir, id)
        } catch (error) {
          warn(`could not delete attachments of note ${id}: ${(error as Error)?.message ?? error}`)
        }
        return true
      })
    },

    updatePrefs(patch: Partial<NotebookPrefs>) {
      return withLock(async () => {
        await ensureReady()
        const next = cloneDoc(doc)
        next.prefs = normalizePrefs({ ...next.prefs, ...(isRecord(patch) ? patch : {}) })
        // Keep the persisted order canonical (updatedAt desc) independently of
        // the requested presentation order.
        next.notes = sortByUpdated(next.notes)
        await commit(next)
        return { ...next.prefs }
      })
    },
  }

  return store
}
