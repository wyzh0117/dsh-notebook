// @vitest-environment jsdom
/**
 * The note list's conversation actions, through the real component:
 *
 * - clicking a title hands an image note to the composer (images attached, body
 *   text into the draft) and keeps the clipboard path for every other note;
 * - the `对话引用` action inserts the atomic `@` reference, and reports honestly
 *   when there is no composer to insert into.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NotebookView } from '../src/client/NotebookView'
import { buildBodyText } from '../src/client/clipboard'
import { t } from '../src/client/locales'
import { DEFAULT_PREFS } from '../src/shared/types'
import type { NotebookNote } from '../src/shared/types'
import type { NotebookApiClient } from '../src/client/api'
import type { AttachImagesResult, NotebookComposer } from '../src/client/composer'

function note(over: Partial<NotebookNote> = {}): NotebookNote {
  return {
    id: 'note-1',
    title: '会议纪要',
    body: '第一行\n第二行',
    attachments: [],
    createdAt: 1,
    updatedAt: 2,
    ...over,
  }
}

function imageNote(): NotebookNote {
  return note({
    body: `正文\n\n![cover.png](attachment:att-1)`,
    attachments: [
      {
        id: 'att-1',
        name: 'cover.png',
        mime: 'image/png',
        size: 10,
        relPath: 'note-1/att-1.png',
        createdAt: 1,
      },
    ],
  })
}

function createApi(notes: NotebookNote[]): NotebookApiClient {
  return {
    getState: async () => ({ doc: { version: 1, notes, prefs: { ...DEFAULT_PREFS } }, degraded: false }),
    createNote: async () => note(),
    updateNote: async () => note(),
    deleteNote: async () => {},
    updatePrefs: async () => ({ ...DEFAULT_PREFS }),
    attachmentUrl: (noteId, relPath) => `/notebook/api/attachments/${noteId}/${relPath}`,
  }
}

function createComposer(over: Partial<NotebookComposer> = {}): NotebookComposer {
  return {
    available: () => true,
    sessionId: () => 'session-1',
    attachImages: vi.fn(async (): Promise<AttachImagesResult> => ({ ok: true, inserted: 1, skipped: 0, failed: 0 })),
    appendText: vi.fn(() => true),
    reference: vi.fn(() => true),
    ...over,
  }
}

let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderView(notes: NotebookNote[], composer?: NotebookComposer | null): void {
  render(
    <NotebookView
      api={createApi(notes)}
      prefs={{ ...DEFAULT_PREFS }}
      onPrefsChange={() => {}}
      visible
      {...(composer === undefined ? {} : { composer })}
    />,
  )
}

describe('the title action', () => {
  /**
   * Product decision (2026-09-15): clicking a title is a PURE clipboard copy.
   * It must never write into the conversation composer, even when the note has
   * images and a composer is reachable — the attachment path in the bridge
   * waits for an explicit action of its own.
   */
  it('copies an image note and leaves the composer completely alone', async () => {
    const composer = createComposer()
    renderView([imageNote()], composer)

    fireEvent.click(await screen.findByTestId('notebook-note-title'))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('正文\n\n[图片: cover.png]'))
    expect(composer.attachImages).not.toHaveBeenCalled()
    expect(composer.appendText).not.toHaveBeenCalled()
    expect(composer.reference).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.getByTestId('notebook-toast').textContent).toBe(t('copied', { n: '正文\n\n[图片: cover.png]'.length })),
    )
  })

  it('keeps the clipboard path for a note without images', async () => {
    const composer = createComposer()
    renderView([note()], composer)

    fireEvent.click(await screen.findByTestId('notebook-note-title'))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('第一行\n第二行'))
    expect(composer.attachImages).not.toHaveBeenCalled()
    expect(composer.appendText).not.toHaveBeenCalled()
  })

  it('copies even when the composer would have refused attachments', async () => {
    const composer = createComposer({
      attachImages: vi.fn(async (): Promise<AttachImagesResult> => ({
        ok: false,
        inserted: 0,
        skipped: 0,
        failed: 0,
        reason: 'refused',
      })),
    })
    renderView([imageNote()], composer)

    fireEvent.click(await screen.findByTestId('notebook-note-title'))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('正文\n\n[图片: cover.png]'))
    expect(composer.attachImages).not.toHaveBeenCalled()
  })

  it('copies when no composer bridge exists at all', async () => {
    renderView([imageNote()], null)
    fireEvent.click(await screen.findByTestId('notebook-note-title'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('正文\n\n[图片: cover.png]'))
  })
})

describe('the reference action', () => {
  it('inserts the note as a reference and confirms it', async () => {
    const composer = createComposer()
    renderView([note()], composer)

    const button = await screen.findByTestId('notebook-note-reference')
    expect(button.getAttribute('title')).toBe(t('referenceHint'))
    fireEvent.click(button)

    expect(composer.reference).toHaveBeenCalledWith(expect.objectContaining({ id: 'note-1' }), '第一行\n第二行')
    await waitFor(() => expect(screen.getByTestId('notebook-toast').textContent).toBe(t('referenced', { title: '会议纪要' })))
  })

  it('reports an unavailable composer instead of pretending', async () => {
    const composer = createComposer({ available: () => false })
    renderView([note()], composer)

    fireEvent.click(await screen.findByTestId('notebook-note-reference'))

    expect(composer.reference).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('notebook-toast').textContent).toBe(t('refUnavailable')))
  })

  it('is not rendered without a composer bridge', async () => {
    renderView([note()], null)
    await screen.findByTestId('notebook-note-edit')
    expect(screen.queryByTestId('notebook-note-reference')).toBeNull()
  })
})
