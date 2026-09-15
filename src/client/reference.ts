/**
 * The notebook's `@` reference source: type `@` in the composer and the
 * notebook's entries show up next to files and sessions.
 *
 * This is the same public seam the shipped `@file` / `@session` source uses
 * (`ctx.inputTriggers.registerSource` from `ui-input-trigger`), so a third-party
 * plugin can contribute a first-class reference domain without touching DSH:
 *
 * - `candidates()` lists our notes under the source's own heading;
 * - `onPick()` returns an **insert** outcome — an atomic inline chip whose
 *   display label is the note title and whose clipboard form is the canonical
 *   `@[title](dsh-notebook:<id>)` mention;
 * - `codec.serialize()` is what the model finally receives. It is invoked once
 *   per chip occurrence at submit time (by the trigger pipeline, which routes
 *   by source name), and it deliberately contributes the note's BODY only — the
 *   title is a label, not content.
 *
 * Failure policy, mirroring the pipeline's own contract: a note that no longer
 * exists serializes to nothing (the reference is simply gone), while a real
 * read failure rejects — the send is blocked with a visible error instead of
 * silently downgrading the mention to `@title`.
 *
 * Purity: no `node:*`, no `@deepseek-ai/*` value imports.
 */
import { buildBodyText, buildReferenceText } from './clipboard'
import { NOTE_REFERENCE_SOURCE, noteMention, noteReferenceInsert } from './composer'
import type { ReferenceInsertLike } from './composer'
import { lookupService } from './hosts/detect'
import { t } from './locales'
import type { NotebookApiClient } from './api'
import type { ClientContext } from './hosts/types'
import type { NotebookNote } from '../shared/types'

/** Menu group order (lower = higher); the built-in reference source sits at 0. */
export const NOTE_SOURCE_ORDER = 20

/** Candidates offered in one menu hit. */
export const NOTE_CANDIDATE_LIMIT = 8

/** How long a fetched note list serves menu hits before it is re-read. */
export const NOTE_CACHE_TTL_MS = 1500

/** How many times a refused registration (a not-yet-unloaded HMR predecessor) is retried. */
export const REFERENCE_RETRY_LIMIT = 5

/** Delay between registration retries. */
export const REFERENCE_RETRY_MS = 500

/** Structural face of `ctx.inputTriggers` (see `dsh-client-ui-input-trigger`). */
export interface InputTriggersLike {
  registerSource(source: InputTriggerSourceLike): () => void
}

/** Structural face of one trigger source (the subset this plugin implements). */
export interface InputTriggerSourceLike {
  trigger: '@' | '/'
  name: string
  order?: number
  showGroupTitle?: boolean
  candidates(
    session: { sessionId: string },
    request: { query?: unknown; signal?: AbortSignal },
  ): Promise<readonly InputTriggerCandidateLike[]>
  onPick(pick: { candidate: InputTriggerCandidateLike }): { insert: ReferenceInsertLike } | undefined
  codec: {
    clipboardText(ref: string): string
    serialize(ref: string, signal: AbortSignal): Promise<string>
  }
}

/** One menu row (pure display data). */
export interface InputTriggerCandidateLike {
  name: string
  description?: string
  icon?: 'file' | 'folder' | 'session'
  section?: string
  value?: string
}

/**
 * The read-through note cache shared by the menu and the serializer.
 *
 * `search` may hit the network; `labels`/`peek` never do — a menu pick must be
 * synchronous, so every note seen by a candidate fetch is remembered for the
 * label it will need a keystroke later.
 */
export interface NoteCatalog {
  /** Notes matching `query` (title or body, case-insensitive), best first. */
  search(query: string, limit?: number): Promise<NotebookNote[]>
  /** The cached note for `id`, or null when this catalog never saw it. */
  peek(id: string): NotebookNote | null
  /** Read one note: throws on a real read failure, null when it no longer exists. */
  read(id: string): Promise<NotebookNote | null>
  /** Forget the fetched list (after a save or a delete). */
  invalidate(): void
}

/** Longest snippet shown under a candidate's title. */
const SNIPPET_LIMIT = 60

/** First line of the body, markers dropped, collapsed to one short line. */
export function noteSnippet(note: NotebookNote): string {
  const text = buildBodyText(note).replace(/\s+/g, ' ').trim()
  return text.length > SNIPPET_LIMIT ? `${text.slice(0, SNIPPET_LIMIT)}…` : text
}

/** The chip label of a note: its title, or the untitled placeholder. */
export function noteLabel(note: NotebookNote): string {
  const title = typeof note?.title === 'string' ? note.title.trim() : ''
  return title.length > 0 ? title : t('untitled')
}

/** Case-insensitive "does this note match the typed query" test. */
function matches(note: NotebookNote, query: string): boolean {
  if (query.length === 0) return true
  const title = typeof note?.title === 'string' ? note.title.toLowerCase() : ''
  if (title.includes(query)) return true
  const body = typeof note?.body === 'string' ? note.body.toLowerCase() : ''
  return body.includes(query)
}

export function createNoteCatalog(api: NotebookApiClient, options?: { ttlMs?: number }): NoteCatalog {
  const ttl = typeof options?.ttlMs === 'number' && Number.isFinite(options.ttlMs) ? options.ttlMs : NOTE_CACHE_TTL_MS
  const known = new Map<string, NotebookNote>()
  let cached: NotebookNote[] | null = null
  let fetchedAt = 0
  let inflight: Promise<NotebookNote[]> | null = null

  const remember = (notes: NotebookNote[]): NotebookNote[] => {
    for (const note of notes) {
      if (note && typeof note.id === 'string' && note.id.length > 0) known.set(note.id, note)
    }
    return notes
  }

  const load = async (): Promise<NotebookNote[]> => {
    const now = Date.now()
    if (cached !== null && now - fetchedAt < ttl) return cached
    if (inflight !== null) return inflight
    inflight = Promise.resolve()
      .then(() => api.getState())
      .then((state) => {
        const notes = Array.isArray(state?.doc?.notes) ? state.doc.notes : []
        cached = remember(notes)
        fetchedAt = Date.now()
        return cached
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  return {
    async search(query, limit) {
      const needle = String(query ?? '').trim().toLowerCase()
      const notes = await load()
      // Newest edit first, whatever order the host returned.
      const found = [...notes]
        .filter((note) => matches(note, needle))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      return typeof limit === 'number' && limit > 0 ? found.slice(0, limit) : found
    },

    peek(id) {
      return known.get(String(id ?? '')) ?? null
    },

    async read(id) {
      const key = String(id ?? '')
      if (key.length === 0) return null
      const notes = await load()
      const found = notes.find((note) => note.id === key)
      if (found !== undefined) return found
      // A note created after the last fetch: one forced re-read before giving up.
      cached = null
      const refreshed = await load()
      return refreshed.find((note) => note.id === key) ?? null
    },

    invalidate() {
      cached = null
      fetchedAt = 0
    },
  }
}

/**
 * Register the `@` source. Waits for the trigger service (`ctx.inject`), so a
 * composition that mounts it late still gets the menu, and a composition that
 * never mounts it simply keeps the notebook's other affordances.
 *
 * @returns the disposer (also removes the source from live session menus).
 */
export function registerNoteReferenceSource(ctx: ClientContext, catalog: NoteCatalog): () => void {
  const source: InputTriggerSourceLike = {
    trigger: '@',
    name: NOTE_REFERENCE_SOURCE,
    order: NOTE_SOURCE_ORDER,
    showGroupTitle: false,

    async candidates(_session, request) {
      const signal = request?.signal
      try {
        const notes = await catalog.search(typeof request?.query === 'string' ? request.query : '', NOTE_CANDIDATE_LIMIT)
        if (signal?.aborted === true) return []
        return notes.map((note) => {
          const snippet = noteSnippet(note)
          return {
            name: noteLabel(note),
            ...(snippet.length > 0 ? { description: snippet } : {}),
            icon: 'file' as const,
            section: t('refSection'),
            value: note.id,
          }
        })
      } catch (error) {
        // A failed domain yields no rows (the pipeline's own rule) rather than
        // breaking the menu that also lists files and sessions.
        console.warn('[dsh-notebook] @ candidate lookup failed:', error)
        return []
      }
    },

    onPick(pick) {
      const id = typeof pick?.candidate?.value === 'string' ? pick.candidate.value : ''
      const note = catalog.peek(id)
      if (note === null) return undefined
      return { insert: noteReferenceInsert(note, t('untitled')) }
    },

    codec: {
      clipboardText: (ref) => {
        const note = catalog.peek(ref)
        return noteMention(ref, note === null ? '' : noteLabel(note))
      },

      /**
       * Model serialization, invoked once per chip occurrence by the submit
       * attempt. The attempt's `signal` is honoured before the read: an
       * already-cancelled send must not drive a document fetch (the notebook's
       * HTTP client has no cancellation of its own, so the check is up front
       * rather than mid-flight).
       */
      async serialize(ref, signal) {
        if (signal?.aborted === true) return ''
        const note = await catalog.read(ref)
        // Deleted note: contribute nothing rather than blocking the send on a
        // reference that no longer has content. A real read failure propagates.
        if (note === null) return ''
        return buildReferenceText(note)
      },
    },
  }

  const fiber = ctx.inject(['inputTriggers'], (inputCtx) => {
    const service = lookupService<InputTriggersLike>(inputCtx, 'inputTriggers')
    if (service === undefined || typeof service.registerSource !== 'function') return
    try {
      inputCtx.effect(
        () => {
          // A duplicate name (the previous activation has not unloaded yet
          // during HMR) is retried instead of dropped: the source name is the
          // serialization routing key, so it cannot be made unique, and a
          // missing `@` group is invisible to the user.
          let timer: ReturnType<typeof globalThis.setTimeout> | null = null
          let unsubscribe: (() => void) | null = null
          let attempts = 0

          const register = (): void => {
            timer = null
            try {
              unsubscribe = service.registerSource(source)
            } catch (error) {
              attempts += 1
              if (attempts > REFERENCE_RETRY_LIMIT) {
                console.warn('[dsh-notebook] registering the @ reference source failed:', error)
                return
              }
              timer = globalThis.setTimeout(register, REFERENCE_RETRY_MS)
            }
          }

          register()
          return () => {
            if (timer !== null) globalThis.clearTimeout(timer)
            const off = unsubscribe
            unsubscribe = null
            if (off !== null) {
              try {
                off()
              } catch {
                // an already-removed source is fine
              }
            }
          }
        },
        'dsh-notebook:@ reference source',
      )
    } catch (error) {
      console.warn('[dsh-notebook] arming the @ reference source failed:', error)
    }
  })

  return () => {
    const dispose = (fiber as { dispose?: () => void } | undefined)?.dispose
    if (typeof dispose === 'function') {
      try {
        dispose.call(fiber)
      } catch (error) {
        console.warn('[dsh-notebook] disposing the @ reference source failed:', error)
      }
    }
    // The catalog is per activation: drop its cache with the source.
    catalog.invalidate()
  }
}
