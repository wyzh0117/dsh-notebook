/**
 * The composer bridge: how the notebook reaches the DSH conversation input.
 *
 * Everything here is **duck-typed on purpose**. The client half is a CJS
 * closure factory (`lib/client.js`) whose `require` resolves only the shell's
 * module table, so importing `@deepseek-ai/dsh-client-ui-conversation` (or any
 * other UI package) is not an option; and DSH versions differ. Every member is
 * therefore optional and every call is guarded: a host without the conversation
 * plugin keeps the old clipboard behaviour instead of throwing.
 *
 * Three seams are used, all public:
 *
 * 1. `ctx.sessions` — `list.getSnapshot().current` names the addressed session
 *    and `scope(id)` resolves that session's Agent-scoped cordis context.
 * 2. `ctx.conversation` — `createDrafts(sessionId, files)` mints browser-owned
 *    draft attachments (images never upload until the prompt is sent) and
 *    `releaseDraftAttachments(drafts)` gives them back when the rail refuses;
 *    `input.for(actx)` resolves the per-session input facade.
 * 3. The scoped input events `slash/input-insert-text` /
 *    `slash/input-insert-reference`, dispatched with the session context as the
 *    subject (`actx.bail(actx, name, payload)`, the exact call the trigger
 *    pipeline makes when a menu row is picked). These are the chip-preserving
 *    way to write into the composer: unlike `setDraft`, they splice at a caret
 *    span and never rebuild the document, so `@`-chips already in the draft
 *    keep their identity.
 *
 * Purity: no `node:*`, no `@deepseek-ai/*` value imports (only `import type`
 * from the dependency-free `../shared/types`).
 */
import { normalizeMime } from '../shared/types'
import type { NotebookAttachment, NotebookNote } from '../shared/types'
import { lookupService } from './hosts/detect'
import { t } from './locales'
import type { ClientContext } from './hosts/types'

/**
 * Image MIME types the DSH composer accepts as image drafts (its
 * `isImageMediaType`). Notebook image types outside this set — SVG, notably —
 * cannot ride the attachment path and are reported as skipped.
 */
export const COMPOSER_IMAGE_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Identity of our `@` source: the routing key for chip serialization. */
export const NOTE_REFERENCE_SOURCE = 'dsh-notebook'

/** True when a notebook image can become a composer image draft. */
export function isComposerImageMime(mime?: string): boolean {
  return COMPOSER_IMAGE_MIMES.includes(normalizeMime(mime))
}

/** One draft attachment as the conversation service returns it (id is all we need). */
export interface DshDraftAttachment {
  id?: unknown
  kind?: unknown
}

/** `ctx.conversation` — the subset of the service face this plugin calls. */
export interface DshConversationLike {
  createDrafts?(sessionId: string, files: readonly File[]): readonly DshDraftAttachment[]
  releaseDraftAttachments?(attachments: readonly unknown[]): void
  input?: { for?(actx: unknown): unknown }
}

/** One reference occurrence as published in `InputState` (clipboard coordinates). */
export interface DshOccurrenceLike {
  offset?: unknown
  length?: unknown
}

/** `InputState` as published by the per-session input shell. */
export interface DshInputStateLike {
  draft?: unknown
  draftRev?: unknown
  phase?: unknown
  occurrences?: unknown
}

/** A caret span in the editor's **detect** projection, guarded by the draft revision. */
export interface DraftSpan {
  start: number
  end: number
  draftRev: number
}

/** The structured reference an `@` source inserts (see `reference.ts`). */
export interface ReferenceInsertLike {
  source: string
  ref: string
  label: string
  appearance?: 'session' | 'file' | 'folder'
  clipboardText: string
}

/** The per-session input facade — only the members used here. */
export interface DshSessionInputLike {
  state?: { getSnapshot?(): DshInputStateLike }
  addAttachments?(ids: readonly string[]): boolean
  setDraft?(text: string): void
  insertText?(text: string, span: DraftSpan, keepCompleting?: boolean): boolean
  insertReference?(reference: ReferenceInsertLike, span: DraftSpan): boolean
}

/** `ctx.sessions` — the subset of the service face this plugin calls. */
export interface DshSessionsLike {
  list?: {
    getSnapshot?(): { current?: unknown }
    subscribe?(listener: () => void): unknown
  }
  scope?(id: string): unknown
}

/** Everything one write needs: the addressed session and its input facade. */
export interface ComposerTarget {
  sessionId: string
  conversation: DshConversationLike
  /** Session-scoped cordis context (the dispatch subject of the scoped events). */
  actx: unknown
  input?: DshSessionInputLike
}

/** The published input state, normalized to what this module reasons about. */
export interface ComposerState {
  draft: string
  draftRev: number
  phase: string
  occurrences: ReadonlyArray<{ offset: number; length: number }>
}

/** Why an attachment batch did not land, for the caller's toast. */
export type AttachFailure = 'no-target' | 'no-images' | 'refused' | 'fetch-failed'

/** Outcome of {@link NotebookComposer.attachImages}. */
export interface AttachImagesResult {
  ok: boolean
  /** Images registered in the composer rail. */
  inserted: number
  /** Stored images whose format the composer cannot take (SVG, …). */
  skipped: number
  /** Images that failed to load or to register. */
  failed: number
  reason?: AttachFailure
}

/**
 * What the note list can do with the live conversation. Built once per
 * activation; every method resolves the current session at call time, so a
 * session switch never leaves a stale target behind.
 *
 * WIRING NOTE (2026-09-15): only {@link NotebookComposer.reference} is reachable
 * from the UI today. The image-attachment and draft-text paths
 * ({@link NotebookComposer.attachImages} / {@link NotebookComposer.appendText})
 * are implemented, unit-tested seams that NO control calls — clicking a note
 * title must stay a pure clipboard copy (a product decision), so they wait for
 * an explicit action of their own. They are kept rather than deleted because
 * the seams are the expensive part and they are covered by tests.
 */
export interface NotebookComposer {
  /** True when a composer can be reached right now. */
  available(): boolean
  /** The addressed session id, or null when there is none. */
  sessionId(): string | null
  /** Put the note's images into the composer's attachment rail. */
  attachImages(note: NotebookNote, options?: { max?: number }): Promise<AttachImagesResult>
  /** Append plain text to the composer draft (chip-preserving when possible). */
  appendText(text: string): boolean
  /** Insert an atomic `@`-reference chip to the note; falls back to its text. */
  reference(note: NotebookNote, fallbackText?: string): boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/**
 * Resolve the composer target: the current session plus its input facade.
 *
 * Returns `null` — never throws — when any link is missing (no conversation
 * plugin, no selected session, a session whose scope is not materialized yet),
 * which is exactly the signal the caller needs to fall back to the clipboard.
 */
export function resolveComposerTarget(ctx: ClientContext | null | undefined): ComposerTarget | null {
  if (!isObject(ctx)) return null
  const sessions = lookupService<DshSessionsLike>(ctx, 'sessions')
  const conversation = lookupService<DshConversationLike>(ctx, 'conversation')
  if (sessions === undefined || conversation === undefined) return null

  let sessionId: string | null = null
  try {
    const snapshot = sessions.list?.getSnapshot?.()
    if (isObject(snapshot)) sessionId = asId(snapshot.current)
  } catch {
    // An unreadable list is simply no target.
  }
  if (sessionId === null) return null

  let actx: unknown
  try {
    actx = sessions.scope?.(sessionId)
  } catch {
    actx = undefined
  }

  let input: DshSessionInputLike | undefined
  const resolver = conversation.input
  if (actx !== undefined && actx !== null && resolver && typeof resolver.for === 'function') {
    try {
      const resolved = resolver.for(actx)
      if (isObject(resolved)) input = resolved as DshSessionInputLike
    } catch {
      // No shell for this scope: attachments are impossible, text may still be.
    }
  }

  return { sessionId, conversation, actx, input }
}

/** Read and normalize the published input state (null when unreadable). */
export function readComposerState(input: DshSessionInputLike | undefined): ComposerState | null {
  if (!input) return null
  let raw: unknown
  try {
    raw = input.state?.getSnapshot?.()
  } catch {
    return null
  }
  if (!isObject(raw)) return null

  const occurrences: Array<{ offset: number; length: number }> = []
  if (Array.isArray(raw.occurrences)) {
    for (const entry of raw.occurrences) {
      if (!isObject(entry)) continue
      const offset = typeof entry.offset === 'number' && Number.isFinite(entry.offset) ? entry.offset : 0
      const length = typeof entry.length === 'number' && Number.isFinite(entry.length) ? entry.length : 0
      occurrences.push({ offset: Math.max(0, offset), length: Math.max(0, length) })
    }
  }

  return {
    draft: typeof raw.draft === 'string' ? raw.draft : '',
    draftRev: typeof raw.draftRev === 'number' && Number.isFinite(raw.draftRev) ? raw.draftRev : 0,
    phase: typeof raw.phase === 'string' ? raw.phase : 'plain',
    occurrences,
  }
}

/**
 * The collapsed span at the end of the draft, in **detect** coordinates.
 *
 * The published `draft` is the clipboard projection, where every reference chip
 * expands to its whole clipboard text; the editor's detect projection gives a
 * chip exactly ONE character (U+FFFC). Both projections agree everywhere else,
 * so the document end is `clipboardLength + Σ(1 - chipClipboardLength)` — exact
 * even for a chip whose clipboard text is empty (one detect character, zero
 * clipboard characters), which is what keeps an append from landing inside an
 * existing chip.
 */
export function endOfDraftSpan(state: ComposerState): DraftSpan {
  let chipCharacters = 0
  for (const occurrence of state.occurrences) {
    chipCharacters += Math.floor(occurrence.length)
  }
  const end = Math.max(0, state.draft.length + state.occurrences.length - chipCharacters)
  return { start: end, end, draftRev: state.draftRev }
}

/** True while the input machine accepts an edit (plain or claimed). */
function acceptsEdits(state: ComposerState): boolean {
  return state.phase === 'plain' || state.phase === 'claimed'
}

/** Dispatch one scoped input event with the session context as the subject. */
function emitScoped(target: ComposerTarget, name: string, payload: unknown): boolean {
  const actx = target.actx as
    | { bail?: (thisArg: unknown, event: string, body: unknown) => unknown }
    | undefined
  if (actx === undefined || typeof actx.bail !== 'function') return false
  try {
    // Exactly the dispatch the trigger pipeline uses on a menu pick:
    // `actx.bail(actx, name, payload)`, the scoped context as the subject.
    return actx.bail(actx, name, payload) === true
  } catch {
    return false
  }
}

/**
 * Append `text` to the composer draft. Prefers the scoped insert-text event
 * (splices at a caret span, keeps every chip intact), then the facade's own
 * `insertText`, and only as a last resort rebuilds the whole draft — the one
 * path that degrades existing chips to their clipboard text.
 */
export function appendComposerText(target: ComposerTarget, text: string): boolean {
  const value = typeof text === 'string' ? text : ''
  if (value.length === 0) return true
  const state = readComposerState(target.input)
  if (state === null || !acceptsEdits(state)) return false

  const span = endOfDraftSpan(state)
  // One newline between the existing draft and the appended text, never two.
  const needsBreak =
    state.draft.length > 0 && !state.draft.endsWith('\n') && !value.startsWith('\n')
  const payload = needsBreak ? `\n${value}` : value
  if (emitScoped(target, 'slash/input-insert-text', { text: payload, span })) return true

  const insertText = target.input?.insertText
  if (typeof insertText === 'function') {
    try {
      if (insertText.call(target.input, payload, span) === true) return true
    } catch {
      // fall through to the draft rebuild
    }
  }

  const setDraft = target.input?.setDraft
  if (typeof setDraft !== 'function') return false
  try {
    setDraft.call(target.input, `${state.draft}${payload}`)
    return true
  } catch {
    return false
  }
}

/** Insert one atomic reference chip at the end of the draft. */
export function insertComposerReference(target: ComposerTarget, reference: ReferenceInsertLike): boolean {
  const state = readComposerState(target.input)
  if (state === null || !acceptsEdits(state)) return false
  const span = endOfDraftSpan(state)
  if (emitScoped(target, 'slash/input-insert-reference', { reference, span })) return true
  const insertReference = target.input?.insertReference
  if (typeof insertReference === 'function') {
    try {
      return insertReference.call(target.input, reference, span) === true
    } catch {
      return false
    }
  }
  return false
}

/** A safe `File` name: the stored name, or a synthesised one that carries the extension. */
function fileNameFor(attachment: NotebookAttachment, mime: string): string {
  const raw = typeof attachment.name === 'string' ? attachment.name.trim() : ''
  if (raw.length > 0) return raw
  const extension = mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length)
  return `image.${extension}`
}

/**
 * Re-read one stored image as a `File`. The composer's image draft path needs a
 * browser `File` (it keeps the bytes in memory and base64-encodes them at send
 * time), and the notebook already serves the bytes over its own same-origin
 * route.
 */
export async function fetchAttachmentFile(
  attachment: NotebookAttachment,
  url: string,
): Promise<File> {
  const fetcher = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined
  if (!fetcher) throw new Error('fetch is unavailable in this environment')
  if (typeof File !== 'function') throw new Error('File is unavailable in this environment')
  const response = await fetcher(url, { cache: 'no-store', credentials: 'same-origin' })
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`)
  const blob = await response.blob()
  const mime = isComposerImageMime(attachment.mime) ? normalizeMime(attachment.mime) : normalizeMime(blob.type)
  return new File([blob], fileNameFor(attachment, mime), { type: mime })
}

/**
 * Build the composer bridge for one activation.
 *
 * @param ctx - client root context (services are resolved per call).
 * @param attachmentUrl - the notebook's own image URL builder.
 */
export function createNotebookComposer(
  ctx: ClientContext | null | undefined,
  attachmentUrl: (noteId: string, relPath: string) => string,
): NotebookComposer {
  return {
    available(): boolean {
      return resolveComposerTarget(ctx) !== null
    },

    sessionId(): string | null {
      return resolveComposerTarget(ctx)?.sessionId ?? null
    },

    async attachImages(note, options): Promise<AttachImagesResult> {
      const target = resolveComposerTarget(ctx)
      if (target === null) {
        return { ok: false, inserted: 0, skipped: 0, failed: 0, reason: 'no-target' }
      }
      const createDrafts = target.conversation.createDrafts
      const addAttachments = target.input?.addAttachments
      if (typeof createDrafts !== 'function' || typeof addAttachments !== 'function') {
        return { ok: false, inserted: 0, skipped: 0, failed: 0, reason: 'no-target' }
      }

      const stored = Array.isArray(note?.attachments) ? note.attachments : []
      const max = typeof options?.max === 'number' && Number.isFinite(options.max) ? Math.max(0, Math.floor(options.max)) : stored.length
      const files: File[] = []
      let skipped = 0
      let failed = 0

      for (const attachment of stored) {
        if (files.length >= max) break
        if (!isObject(attachment) || typeof attachment.id !== 'string') continue
        if (!isComposerImageMime(attachment.mime)) {
          skipped += 1
          continue
        }
        try {
          files.push(await fetchAttachmentFile(attachment, attachmentUrl(note.id, attachment.relPath)))
        } catch (error) {
          failed += 1
          console.warn('[dsh-notebook] reading a stored image for the composer failed:', error)
        }
      }

      if (files.length === 0) {
        return {
          ok: false,
          inserted: 0,
          skipped,
          failed,
          reason: failed > 0 ? 'fetch-failed' : 'no-images',
        }
      }

      let drafts: readonly DshDraftAttachment[]
      try {
        drafts = createDrafts.call(target.conversation, target.sessionId, files)
      } catch (error) {
        console.warn('[dsh-notebook] creating composer drafts failed:', error)
        return { ok: false, inserted: 0, skipped, failed: failed + files.length, reason: 'refused' }
      }

      const ids = (Array.isArray(drafts) ? drafts : [])
        .map((draft) => asId(draft?.id))
        .filter((id): id is string => id !== null)

      let accepted = false
      try {
        accepted = ids.length > 0 && addAttachments.call(target.input, ids) === true
      } catch (error) {
        console.warn('[dsh-notebook] adding composer attachments failed:', error)
        accepted = false
      }

      if (!accepted) {
        // The rail refused (a submission is in flight): give the drafts back so
        // no object URL or upload outlives the attempt.
        try {
          target.conversation.releaseDraftAttachments?.(drafts)
        } catch (error) {
          console.warn('[dsh-notebook] releasing refused composer drafts failed:', error)
        }
        return { ok: false, inserted: 0, skipped, failed, reason: 'refused' }
      }

      return { ok: true, inserted: ids.length, skipped, failed }
    },

    appendText(text: string): boolean {
      const target = resolveComposerTarget(ctx)
      if (target === null) return false
      try {
        return appendComposerText(target, text)
      } catch (error) {
        console.warn('[dsh-notebook] appending to the composer draft failed:', error)
        return false
      }
    },

    reference(note, fallbackText?: string): boolean {
      const target = resolveComposerTarget(ctx)
      if (target === null) return false
      try {
        if (insertComposerReference(target, noteReferenceInsert(note, t('untitled')))) return true
        // No chip path in this composition: hand the model the same text the
        // chip would have serialized to.
        const text = typeof fallbackText === 'string' ? fallbackText : ''
        return text.length > 0 ? appendComposerText(target, text) : false
      } catch (error) {
        console.warn('[dsh-notebook] inserting a note reference failed:', error)
        return false
      }
    },
  }
}

/**
 * The reference payload for one note. Declared here (not in `reference.ts`) so
 * the bridge stays free of the trigger-source wiring; `reference.ts` imports it
 * for its menu picks.
 *
 * @param note - the note being referenced.
 * @param labelOverride - chip label used when the note has no title.
 */
export function noteReferenceInsert(note: NotebookNote, labelOverride?: string): ReferenceInsertLike {
  const id = typeof note?.id === 'string' ? note.id : ''
  const title = typeof note?.title === 'string' ? note.title.trim() : ''
  const label = title.length > 0 ? title : String(labelOverride ?? '')
  return {
    source: NOTE_REFERENCE_SOURCE,
    ref: id,
    label,
    appearance: 'file',
    clipboardText: noteMention(id, label),
  }
}

/** The canonical mention form of one note (clipboard / persistence projection). */
export function noteMention(id: string, label: string): string {
  const safeLabel = String(label ?? '').replace(/[[\]]/g, '')
  return `@[${safeLabel}](dsh-notebook:${id})`
}
