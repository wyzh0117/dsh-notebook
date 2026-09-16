/**
 * Capture core (v0.2.0): the one path that turns arbitrary text into a new note.
 *
 * Two features feed it — the floating "进记事本" action on a text selection
 * (`selectionAction.ts`) and the "save to notebook" action under a finalized
 * answer (`answerAction.ts`). Both must behave identically in the parts the
 * user can observe, so the shared behaviour lives here and NOT in either UI:
 *
 * - **title**: an explicit title wins (an answer is stored under its session
 *   title); otherwise the next free numbered default `未命名n` is minted from
 *   the notes the host currently holds — see {@link nextUntitledTitle}.
 * - **numbering is reserved before the write**: two captures in flight never
 *   pick the same number, because a title chosen here is held until its request
 *   settles (the host's own list is only re-read at the START of a capture).
 * - **saves are serialized**: each capture waits for the previous one, so the
 *   read-modify-write of the title number cannot interleave.
 * - **listeners**: a successful capture notifies every subscriber, which is how
 *   an open Notebook panel refreshes immediately instead of waiting for its poll.
 *
 * Purity: no `node:*`, no `@deepseek-ai/*` value imports — only `import type`.
 */
import { nextUntitledTitle, type NotebookNote } from '../shared/types'
import type { NotebookApiClient } from './api'

/** Where a captured note came from (drives nothing but the caller's copy). */
export type CaptureSource = 'selection' | 'answer'

/** One capture request. `title` empty/absent ⇒ a numbered default is minted. */
export interface CaptureRequest {
  text: string
  title?: string
  source: CaptureSource
}

/** A stored note plus the title actually used (which the caller may not know). */
export interface CaptureResult {
  note: NotebookNote
  /** The title the note ended up with — explicit, or the minted `未命名n`. */
  title: string
}

/** One transient message for the plugin's toast surface. */
export interface CaptureToast {
  id: number
  message: string
  tone: 'ok' | 'error'
}

/** Outcome of {@link NotebookCapture.save}: `null` means "nothing to save". */
export type CaptureOutcome = CaptureResult | null

/**
 * The capture seam both features call. Deliberately tiny: no UI, no DSH
 * services, so it is fully unit-testable against a fake {@link NotebookApiClient}.
 */
export interface NotebookCapture {
  /**
   * Store `request.text` as a new note.
   *
   * @returns the created note and its title, or `null` when the text holds
   *   nothing but whitespace (an empty capture is a no-op, never an error).
   * @throws whatever {@link NotebookApiClient.createNote} throws — the caller
   *   owns the user-facing message.
   */
  save(request: CaptureRequest): Promise<CaptureOutcome>
  /** Notified after every successful save (the sidebar list refreshes on it). */
  subscribe(listener: () => void): () => void
  /** The toast surface: `useSyncExternalStore`-compatible snapshot + subscribe. */
  toasts(): readonly CaptureToast[]
  subscribeToasts(listener: () => void): () => void
  /** Push one transient message onto the toast surface. */
  notify(message: string, tone?: 'ok' | 'error'): void
  /** Drop one toast (the surface calls this when its timer fires). */
  dismissToast(id: number): void
  /**
   * Release every timer and listener. Called with the activation: a pending
   * toast timer must not outlive the surfaces that would draw it (HMR reloads
   * the client half while the page stays open).
   */
  dispose(): void
}

/** How long a plugin toast stays up. */
export const TOAST_TTL_MS = 2600

/** Options for {@link createNotebookCapture} (every one of them a test seam). */
export interface NotebookCaptureOptions {
  api: NotebookApiClient
  /**
   * Read the titles the notebook currently holds. Defaults to a fresh
   * `GET /state` read; a test can inject a fixed list.
   */
  readTitles?: () => Promise<readonly string[]>
  /** Toast auto-dismiss delay; `0` disables the timer (tests drive it). */
  toastTtlMs?: number
}

/** Default title-list reader: the host document is the only source of truth. */
async function readHostTitles(api: NotebookApiClient): Promise<readonly string[]> {
  const state = await api.getState()
  const notes = Array.isArray(state?.doc?.notes) ? state.doc.notes : []
  return notes.map((note) => (typeof note?.title === 'string' ? note.title : ''))
}

/**
 * Build the capture service for one plugin activation.
 *
 * The service is intentionally stateful (the in-flight title reservations, the
 * save queue, the toast list) but holds NO module-level state: two activations
 * share nothing.
 */
export function createNotebookCapture(options: NotebookCaptureOptions): NotebookCapture {
  const { api } = options
  const readTitles = options.readTitles ?? (() => readHostTitles(api))
  const ttl = typeof options.toastTtlMs === 'number' && options.toastTtlMs >= 0 ? options.toastTtlMs : TOAST_TTL_MS

  const listeners = new Set<() => void>()
  const toastListeners = new Set<() => void>()
  let toastList: CaptureToast[] = []
  let toastSeq = 0
  const timers = new Map<number, ReturnType<typeof globalThis.setTimeout>>()

  /**
   * Titles minted by captures that have not settled yet. Held for the whole
   * request so a second capture cannot mint the same number while the first is
   * still in flight — the host list does not know about it yet.
   */
  const pending = new Set<string>()

  /**
   * Titles this activation minted AND successfully wrote. Kept for the life of
   * the activation (a failure releases its number) because the numbering has to
   * survive a stale or failed list read: without it, two captures in a row
   * during a read outage would both land on `未命名1`.
   */
  const written = new Set<string>()

  /** Tail of the save queue; every capture chains onto it. */
  let queue: Promise<unknown> = Promise.resolve()

  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const notifyToasts = (): void => {
    for (const listener of [...toastListeners]) listener()
  }

  const dismiss = (id: number): void => {
    const timer = timers.get(id)
    if (timer !== undefined) {
      globalThis.clearTimeout(timer)
      timers.delete(id)
    }
    const next = toastList.filter((toast) => toast.id !== id)
    if (next.length === toastList.length) return
    toastList = next
    notifyToasts()
  }

  const notifyToast = (message: string, tone: 'ok' | 'error'): void => {
    toastSeq += 1
    const id = toastSeq
    toastList = [...toastList, { id, message, tone }]
    notifyToasts()
    if (ttl > 0) {
      const timer = globalThis.setTimeout(() => dismiss(id), ttl)
      timers.set(id, timer)
    }
  }

  /** Chain `task` onto the queue, keeping the queue alive on failure. */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function mintTitle(): Promise<string> {
    let existing: readonly string[] = []
    try {
      existing = await readTitles()
    } catch (error) {
      // A failed read must not block the capture: the title only has to be
      // *plausible*, and the sets below still keep this activation's own
      // captures apart.
      console.warn('[dsh-notebook] reading notes for the default title failed:', error)
    }
    const title = nextUntitledTitle([...existing, ...written, ...pending])
    pending.add(title)
    return title
  }

  return {
    async save(request: CaptureRequest): Promise<CaptureOutcome> {
      const text = typeof request?.text === 'string' ? request.text : ''
      if (text.trim().length === 0) return null
      const requested = typeof request?.title === 'string' ? request.title.trim() : ''

      return enqueue(async () => {
        let title = requested
        let mintedHere = false
        if (title.length === 0) {
          title = await mintTitle()
          mintedHere = true
        }
        try {
          const note = await api.createNote({ title, body: text, attachments: [] })
          // A written title stays claimed: the host list may be unreadable on
          // the next capture, and reusing the number is worse than a gap.
          if (mintedHere) {
            pending.delete(title)
            written.add(title)
          }
          notify()
          return { note, title: typeof note.title === 'string' && note.title.length > 0 ? note.title : title }
        } catch (error) {
          // The write failed, so nothing holds the number: a retry must be able
          // to mint it again instead of skipping to the next one.
          if (mintedHere) pending.delete(title)
          throw error
        }
      })
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    toasts(): readonly CaptureToast[] {
      return toastList
    },

    subscribeToasts(listener: () => void): () => void {
      toastListeners.add(listener)
      return () => {
        toastListeners.delete(listener)
      }
    },

    notify(message: string, tone: 'ok' | 'error' = 'ok'): void {
      const text = typeof message === 'string' ? message : ''
      if (text.length === 0) return
      notifyToast(text, tone)
    },

    dismissToast(id: number): void {
      dismiss(id)
    },

    dispose(): void {
      for (const timer of timers.values()) globalThis.clearTimeout(timer)
      timers.clear()
      // Release the subscribers without a final notification: dispose runs
      // while the surfaces are being torn down.
      listeners.clear()
      toastListeners.clear()
      toastList = []
    },
  }
}

/** True when the preference gates a capture feature on (v0.2.0 defaults: on). */
export function captureEnabled(
  prefs: { selectionToNotebook?: boolean; messageToNotebook?: boolean } | null | undefined,
  feature: CaptureSource,
): boolean {
  if (feature === 'selection') return prefs?.selectionToNotebook !== false
  return prefs?.messageToNotebook !== false
}
