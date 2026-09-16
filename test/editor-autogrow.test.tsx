// @vitest-environment jsdom
/**
 * v0.2.1 body auto-grow, the DOM half.
 *
 * `test/auto-grow.test.ts` pins the arithmetic; this file drives the real
 * `<NotebookEditor>` `<textarea>` and asserts the wiring around it: measure on
 * mount (so an edited note opens at its own height), measure on every change,
 * re-measure when the box is re-wrapped by a panel resize, and tear the observer
 * down with the editor.
 *
 * jsdom has no layout engine — `scrollHeight` is always 0 and `ResizeObserver`
 * does not exist — so the file supplies both: a `scrollHeight` getter derived
 * from the element's own value (line height 20, padding 12, matching
 * `fieldStyle`) and a `StubResizeObserver` that records its subscription and can
 * deliver a width change on demand. The viewport is pinned to 400px, so the cap
 * under test is `400 × 0.6 = 240`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NotebookView } from '../src/client/NotebookView'
import { BODY_MIN_HEIGHT } from '../src/client/autoGrow'
import { DEFAULT_PREFS } from '../src/shared/types'
import type { NotebookNote } from '../src/shared/types'
import type { NotebookApiClient } from '../src/client/api'

/** One 13px/20px row plus the field's 6px top and bottom padding. */
const LINE_HEIGHT = 20
const PADDING = 12
const VIEWPORT = 400
const CAP = VIEWPORT * 0.6

interface Metrics {
  /** Simulated characters that fit on one visual line. */
  charsPerLine: number
  /** Emulate a runtime that cannot measure (jsdom's own behaviour). */
  unmeasurable: boolean
  /** How many times the getter was read — the re-measure probe. */
  reads: number
}

const metrics: Metrics = { charsPerLine: 1000, unmeasurable: false, reads: 0 }

/** Visual rows for `text` under the current {@link Metrics}. */
function visualRows(text: string): number {
  const perLine = Math.max(1, Math.floor(metrics.charsPerLine))
  let rows = 0
  for (const logical of text.split('\n')) {
    rows += Math.max(1, Math.ceil(logical.length / perLine))
  }
  return Math.max(1, rows)
}

interface StubEntry {
  contentRect: { width: number; height: number }
}

class StubResizeObserver {
  static instances: StubResizeObserver[] = []

  readonly callback: (entries: StubEntry[]) => void
  observed: Element[] = []
  disconnected = false

  constructor(callback: (entries: StubEntry[]) => void) {
    this.callback = callback
    StubResizeObserver.instances.push(this)
  }

  observe(element: Element): void {
    this.observed.push(element)
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true
  }

  /** Deliver a width change the way the browser would after a panel resize. */
  emit(width: number): void {
    this.callback([{ contentRect: { width, height: 0 } }])
  }
}

function createApi(seed: NotebookNote[] = []): NotebookApiClient {
  let notes = seed.map((note) => ({ ...note }))
  return {
    async getState() {
      return { doc: { version: 1 as const, notes: notes.map((note) => ({ ...note })), prefs: { ...DEFAULT_PREFS } }, degraded: false }
    },
    async createNote(input) {
      const note: NotebookNote = {
        id: `note-${notes.length + 1}`,
        title: input.title,
        body: input.body,
        attachments: [],
        createdAt: 1,
        updatedAt: 1,
      }
      notes = [note, ...notes]
      return { ...note }
    },
    async updateNote(id, patch) {
      const index = notes.findIndex((note) => note.id === id)
      if (index < 0) throw new Error(`note ${id} not found`)
      // This fake never receives attachment uploads: the auto-grow tests attach
      // no images, so the stored attachment list is carried over untouched.
      const current = notes[index]
      const next: NotebookNote = {
        ...current,
        title: patch.title ?? current.title,
        body: patch.body ?? current.body,
        updatedAt: 2,
      }
      notes = notes.map((note, position) => (position === index ? next : note))
      return { ...next }
    },
    async deleteNote(id) {
      notes = notes.filter((note) => note.id !== id)
    },
    async updatePrefs(patch) {
      return { ...DEFAULT_PREFS, ...patch }
    },
    attachmentUrl(noteId, relPath) {
      return `/notebook/api/attachments/${noteId}/${relPath.split('/').pop() ?? ''}`
    },
  }
}

function renderView(seed: NotebookNote[] = []) {
  return render(
    <NotebookView api={createApi(seed)} prefs={{ ...DEFAULT_PREFS }} onPrefsChange={vi.fn()} visible />,
  )
}

/** Open the create editor and hand back its body box. */
async function openEditor(): Promise<HTMLTextAreaElement> {
  await screen.findByTestId('notebook-empty')
  fireEvent.click(screen.getByTestId('notebook-new'))
  return (await screen.findByTestId('notebook-body')) as HTMLTextAreaElement
}

function type(body: HTMLTextAreaElement, value: string): void {
  fireEvent.change(body, { target: { value } })
}

function lines(count: number, label = '行'): string {
  return Array.from({ length: count }, (_, index) => `${label}${index + 1}`).join('\n')
}

function seedNote(body: string): NotebookNote {
  return { id: 'note-seed', title: '已存在的记事', body, attachments: [], createdAt: 1, updatedAt: 2 }
}

/** Pin the viewport height the cap is derived from. */
function setViewport(height: number): void {
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true })
}

beforeEach(() => {
  metrics.charsPerLine = 1000
  metrics.unmeasurable = false
  metrics.reads = 0
  StubResizeObserver.instances = []

  setViewport(VIEWPORT)
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      metrics.reads += 1
      if (metrics.unmeasurable) return 0
      return visualRows(this.value) * LINE_HEIGHT + PADDING
    },
  })
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('NotebookEditor — content-sized body box (v0.2.1)', () => {
  it('grows while typing, stops at the cap, and shrinks back when text is deleted', async () => {
    renderView()
    const body = await openEditor()

    // Empty draft: the 120 px floor, no cap breached, no inner scrollbar.
    expect(body.style.height).toBe(`${BODY_MIN_HEIGHT}px`)
    expect(body.style.maxHeight).toBe(`${CAP}px`)
    expect(body.style.overflowY).toBe('hidden')
    // The manual drag handle is gone: it would fight the measurement.
    expect(body.style.resize).toBe('none')

    // 7 rows = 152px: taller than the floor, still under the cap.
    type(body, lines(7))
    expect(body.style.height).toBe(`${7 * LINE_HEIGHT + PADDING}px`)
    expect(body.style.overflowY).toBe('hidden')

    // 20 rows = 412px of content: clamped to the cap and scrollable inside.
    type(body, lines(20))
    expect(body.style.height).toBe(`${CAP}px`)
    expect(body.style.overflowY).toBe('auto')
    expect(body.style.maxHeight).toBe(`${CAP}px`)

    // Deleting it all puts the small box back.
    type(body, '')
    expect(body.style.height).toBe(`${BODY_MIN_HEIGHT}px`)
    expect(body.style.overflowY).toBe('hidden')

    // Two rows is still under the floor — the box does not chase every newline.
    type(body, lines(2))
    expect(body.style.height).toBe(`${BODY_MIN_HEIGHT}px`)
  })

  it('opens an existing note already sized to its body, without typing', async () => {
    renderView([seedNote(lines(7))])
    await screen.findByRole('button', { name: '已存在的记事' })
    fireEvent.click(screen.getByTestId('notebook-note-edit'))

    const body = (await screen.findByTestId('notebook-body')) as HTMLTextAreaElement
    expect(body.value).toBe(lines(7))
    expect(body.style.height).toBe(`${7 * LINE_HEIGHT + PADDING}px`)
  })

  it('re-measures when the box is re-wrapped by a narrower panel', async () => {
    renderView()
    const body = await openEditor()
    type(body, lines(7))
    expect(body.style.height).toBe(`${7 * LINE_HEIGHT + PADDING}px`)

    expect(StubResizeObserver.instances.length).toBe(1)
    const observer = StubResizeObserver.instances[0]
    expect(observer.observed).toEqual([body])

    // The panel narrows: every logical line now wraps into two visual rows.
    metrics.charsPerLine = 1
    const before = metrics.reads
    observer.emit(180)
    expect(metrics.reads).toBeGreaterThan(before)
    const wrapped = visualRows(lines(7)) * LINE_HEIGHT + PADDING
    expect(wrapped).toBeGreaterThan(CAP)
    expect(body.style.height).toBe(`${CAP}px`)
    expect(body.style.overflowY).toBe('auto')

    // A height-only notification is our own resize echoing back: the width did
    // not change, so the box must not be measured again (the loop guard).
    const settled = metrics.reads
    observer.emit(180)
    expect(metrics.reads).toBe(settled)
    expect(body.style.height).toBe(`${CAP}px`)
  })

  it('re-clamps when the viewport height changes, with ResizeObserver present', async () => {
    renderView()
    const body = await openEditor()
    type(body, lines(20))
    expect(body.style.height).toBe(`${CAP}px`)
    expect(body.style.overflowY).toBe('auto')
    expect(StubResizeObserver.instances.length).toBe(1)

    // A taller window raises the cap, and the same 412px of content now fits.
    // The box itself does not resize here, so the viewport has to be watched
    // directly — the observer alone would never fire.
    setViewport(800)
    fireEvent(window, new Event('resize'))
    expect(body.style.maxHeight).toBe('480px')
    expect(body.style.height).toBe(`${20 * LINE_HEIGHT + PADDING}px`)
    expect(body.style.overflowY).toBe('hidden')

    // Shrinking the window back re-clamps it to the smaller cap.
    setViewport(VIEWPORT)
    fireEvent(window, new Event('resize'))
    expect(body.style.maxHeight).toBe(`${CAP}px`)
    expect(body.style.height).toBe(`${CAP}px`)
    expect(body.style.overflowY).toBe('auto')
  })

  it('still sizes correctly without ResizeObserver, via the window fallback', async () => {
    vi.stubGlobal('ResizeObserver', undefined)
    renderView()
    const body = await openEditor()
    type(body, lines(7))
    expect(body.style.height).toBe(`${7 * LINE_HEIGHT + PADDING}px`)
    expect(StubResizeObserver.instances.length).toBe(0)

    metrics.charsPerLine = 1
    fireEvent(window, new Event('resize'))
    expect(body.style.height).toBe(`${CAP}px`)
  })

  it('keeps the floor and never throws when the box cannot be measured', async () => {
    metrics.unmeasurable = true
    renderView()
    const body = await openEditor()
    type(body, lines(40))
    expect(body.style.height).toBe(`${BODY_MIN_HEIGHT}px`)
    expect(body.style.overflowY).toBe('hidden')

    // The box becomes measurable (panel shown / real browser): the next edit
    // reports the content height instead of the floor.
    metrics.unmeasurable = false
    type(body, lines(7))
    expect(body.style.height).toBe(`${7 * LINE_HEIGHT + PADDING}px`)
  })

  it('disconnects the observer when the editor closes', async () => {
    renderView()
    const body = await openEditor()
    const observer = StubResizeObserver.instances[0]
    expect(observer.disconnected).toBe(false)

    fireEvent.click(screen.getByTestId('notebook-cancel'))
    await waitFor(() => expect(screen.queryByTestId('notebook-editor')).toBeNull())
    expect(observer.disconnected).toBe(true)
    expect(body.isConnected).toBe(false)
  })

  it('does not resize the title field: only the multi-line body scales', async () => {
    renderView()
    const body = await openEditor()
    const title = screen.getByTestId('notebook-title') as HTMLInputElement
    fireEvent.change(title, { target: { value: '一个相当长的标题'.repeat(20) } })
    expect(title.style.height).toBe('')
    expect(body.style.height).toBe(`${BODY_MIN_HEIGHT}px`)
  })
})
