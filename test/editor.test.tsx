// @vitest-environment jsdom
/**
 * G3–G8 end-to-end through the real UI against an in-memory
 * {@link NotebookApiClient}: new note → image paste (and video refusal) →
 * "done" → listed by title → title click copies the body → "edit" reopens the
 * SAME single container with the note filled back in.
 *
 * The fake host mirrors the real one's contract: it assigns note/attachment ids
 * and stores `body` verbatim, which is what forces the editor's placeholder
 * markers to be resolved back into real ids.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NotebookView } from '../src/client/NotebookView'
import { NotebookSettingsPanel } from '../src/client/NotebookSettingsPanel'
import { buildClipboardText } from '../src/client/clipboard'
import { MAX_IMAGE_BYTES, MAX_IMAGE_MB } from '../src/client/image'
import { t } from '../src/client/locales'
import { DEFAULT_PREFS } from '../src/shared/types'
import type { NotebookAttachment, NotebookNote, NotebookPrefs } from '../src/shared/types'
import type { NewAttachmentInput, NotebookApiClient } from '../src/client/api'

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

interface FakeApi extends NotebookApiClient {
  state: { notes: NotebookNote[]; prefs: NotebookPrefs; degraded: boolean }
  calls: string[]
}

function createFakeApi(seed?: { prefs?: Partial<NotebookPrefs>; notes?: NotebookNote[] }): FakeApi {
  const state = {
    notes: seed?.notes ? [...seed.notes] : [],
    prefs: { ...DEFAULT_PREFS, ...(seed?.prefs ?? {}) },
    degraded: false,
  }
  let counter = 0
  const nextId = (prefix: string): string => {
    counter += 1
    return `${prefix}-${counter}`
  }
  const clone = (note: NotebookNote): NotebookNote => ({
    ...note,
    attachments: note.attachments.map((attachment) => ({ ...attachment })),
  })

  const api: FakeApi = {
    state,
    calls: [],

    async getState() {
      api.calls.push('getState')
      return { doc: { version: 1 as const, notes: state.notes.map(clone), prefs: { ...state.prefs } }, degraded: state.degraded }
    },

    async createNote(input: { title: string; body: string; attachments: NewAttachmentInput[] }) {
      api.calls.push('createNote')
      const noteId = nextId('note')
      const now = Date.now()
      const attachments: NotebookAttachment[] = input.attachments.map((item) => {
        const attachmentId = nextId('att')
        const extension = EXT[item.mime] ?? 'png'
        return {
          id: attachmentId,
          name: item.name,
          mime: item.mime,
          size: item.size,
          relPath: `${noteId}/${attachmentId}.${extension}`,
          createdAt: now,
        }
      })
      const note: NotebookNote = {
        id: noteId,
        title: input.title,
        body: input.body,
        attachments,
        createdAt: now,
        updatedAt: now,
      }
      state.notes = [note, ...state.notes]
      return clone(note)
    },

    async updateNote(id, patch) {
      api.calls.push('updateNote')
      const index = state.notes.findIndex((note) => note.id === id)
      if (index < 0) throw new Error(`note ${id} not found`)
      const current = state.notes[index]
      let attachments = current.attachments
      if (patch.attachments) {
        const now = Date.now()
        attachments = patch.attachments.map((item) => {
          const attachmentId = nextId('att')
          return {
            id: attachmentId,
            name: item.name,
            mime: item.mime,
            size: item.size,
            relPath: `${id}/${attachmentId}.${EXT[item.mime] ?? 'png'}`,
            createdAt: now,
          }
        })
      }
      const next: NotebookNote = {
        ...current,
        title: patch.title ?? current.title,
        body: patch.body ?? current.body,
        attachments,
        updatedAt: Date.now(),
      }
      state.notes = state.notes.map((note, position) => (position === index ? next : note))
      return clone(next)
    },

    async deleteNote(id) {
      api.calls.push('deleteNote')
      state.notes = state.notes.filter((note) => note.id !== id)
    },

    async updatePrefs(patch) {
      api.calls.push('updatePrefs')
      state.prefs = { ...state.prefs, ...patch }
      return { ...state.prefs }
    },

    attachmentUrl(noteId, relPath) {
      const name = relPath.split('/').pop() ?? ''
      return `/notebook/api/attachments/${noteId}/${name}`
    },
  }

  return api
}

function png(name = 'cover.png'): File {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: 'image/png' })
}

function mp4(name = 'clip.mp4'): File {
  return new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], name, { type: 'video/mp4' })
}

function seedNote(over: Partial<NotebookNote> = {}): NotebookNote {
  return {
    id: 'note-seed',
    title: '待删除',
    body: '正文',
    attachments: [],
    createdAt: 1,
    updatedAt: 2,
    ...over,
  }
}

type RenderOptions = { prefs?: Partial<NotebookPrefs>; visible?: boolean; api?: FakeApi }

function renderView(options: RenderOptions = {}) {
  const api = options.api ?? createFakeApi()
  const prefs: NotebookPrefs = { ...DEFAULT_PREFS, ...(options.prefs ?? {}) }
  const onPrefsChange = vi.fn()
  const view = render(
    <NotebookView
      api={api}
      prefs={prefs}
      onPrefsChange={onPrefsChange}
      visible={options.visible ?? true}
    />,
  )
  return { api, prefs, onPrefsChange, view }
}

/** A paste event carrying files, as the browser builds it. */
function pasteFiles(element: Element, files: File[]): void {
  fireEvent.paste(element, { clipboardData: { files, items: [] } })
}

function dropFiles(element: Element, files: File[]): void {
  fireEvent.drop(element, { dataTransfer: { files, items: [] } })
}

let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  })
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:mock-preview'), configurable: true, writable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('NotebookView', () => {
  it('walks G3 → G8 against the in-memory host', async () => {
    const { api, prefs } = renderView()

    // Initial load: no notes yet.
    await screen.findByTestId('notebook-empty')

    // ── G3: the ＋ button opens the editing container ────────────────────
    fireEvent.click(screen.getByTestId('notebook-new'))
    await screen.findByTestId('notebook-editor')
    expect(screen.getAllByTestId('notebook-editor').length).toBe(1)

    // "done" is disabled while the note is empty.
    expect((screen.getByTestId('notebook-done') as HTMLButtonElement).disabled).toBe(true)

    // ── G5: title + body ─────────────────────────────────────────────────
    fireEvent.change(screen.getByTestId('notebook-title'), { target: { value: '会议纪要' } })
    fireEvent.change(screen.getByTestId('notebook-body'), { target: { value: '第一行\n第二行' } })
    expect((screen.getByTestId('notebook-done') as HTMLButtonElement).disabled).toBe(false)

    // ── G4: paste an image → thumbnail ───────────────────────────────────
    pasteFiles(screen.getByTestId('notebook-body'), [png()])
    await waitFor(() => expect(screen.getAllByTestId('notebook-image').length).toBe(1))
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)

    // ── G4: a video is refused, with a visible reason ────────────────────
    pasteFiles(screen.getByTestId('notebook-body'), [mp4()])
    await screen.findByText('不支持视频文件')
    expect(screen.getAllByTestId('notebook-image').length).toBe(1)

    // ── G6: "done" saves, closes the container, lists the title ──────────
    fireEvent.click(screen.getByTestId('notebook-done'))
    await waitFor(() => expect(screen.queryByTestId('notebook-editor')).toBeNull())

    const titleButton = await screen.findByRole('button', { name: '会议纪要' })
    expect(api.state.notes.length).toBe(1)

    const stored = api.state.notes[0]
    expect(stored.title).toBe('会议纪要')
    expect(stored.attachments.length).toBe(1)
    expect(stored.body).toBe(`第一行\n第二行\n\n![cover.png](attachment:${stored.attachments[0].id})`)
    expect(api.calls).toContain('createNote')

    // ── G7: clicking the title copies the BODY (never the title) ─────────
    fireEvent.click(titleButton)
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))

    const expected = buildClipboardText(api.state.notes[0], prefs)
    expect(writeText).toHaveBeenCalledWith(expected)
    expect(expected).toContain('第一行')
    expect(expected).toContain('[图片: cover.png]')
    expect(expected).not.toContain('会议纪要')

    const toast = await screen.findByTestId('notebook-toast')
    expect(toast.textContent).toBe(t('copied', { n: expected.length }))

    // ── G8: "edit" reopens the SAME container, filled back in ────────────
    fireEvent.click(screen.getByTestId('notebook-note-edit'))
    await screen.findByTestId('notebook-editor')
    expect(screen.getAllByTestId('notebook-editor').length).toBe(1)
    expect((screen.getByTestId('notebook-title') as HTMLInputElement).value).toBe('会议纪要')
    expect((screen.getByTestId('notebook-body') as HTMLTextAreaElement).value).toBe('第一行\n第二行')
    await waitFor(() => expect(screen.getAllByTestId('notebook-image').length).toBe(1))

    // Editing the text and finishing must not re-upload unchanged images.
    const attachmentIds = api.state.notes[0].attachments.map((attachment) => attachment.id)
    fireEvent.change(screen.getByTestId('notebook-title'), { target: { value: '会议纪要 v2' } })
    fireEvent.click(screen.getByTestId('notebook-done'))

    await waitFor(() => expect(screen.queryByTestId('notebook-editor')).toBeNull())
    await waitFor(() => expect(api.state.notes[0].title).toBe('会议纪要 v2'))
    expect(api.state.notes[0].attachments.map((attachment) => attachment.id)).toEqual(attachmentIds)
    expect(api.state.notes[0].body).toBe(`第一行\n第二行\n\n![cover.png](attachment:${attachmentIds[0]})`)
  })

  it('accepts a dropped image, refuses a dropped video and enforces the per-note limit', async () => {
    const { api } = renderView({ prefs: { maxImagesPerNote: 1 } })

    await screen.findByTestId('notebook-empty')
    fireEvent.click(screen.getByTestId('notebook-new'))
    const body = await screen.findByTestId('notebook-body')

    dropFiles(body, [png('dropped.png')])
    await waitFor(() => expect(screen.getAllByTestId('notebook-image').length).toBe(1))

    // Dropped video: refused, still one image.
    dropFiles(body, [mp4('dropped.mp4')])
    await screen.findByText('不支持视频文件')
    expect(screen.getAllByTestId('notebook-image').length).toBe(1)

    // An oversized image is refused by size before the count rule fires.
    const huge = new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'huge.png', { type: 'image/png' })
    dropFiles(body, [huge])
    await screen.findByText(t('errTooLarge', { max: MAX_IMAGE_MB }))
    expect(screen.getAllByTestId('notebook-image').length).toBe(1)

    // Second image exceeds maxImagesPerNote = 1.
    dropFiles(body, [png('second.png')])
    await screen.findByText(t('errTooMany', { max: 1 }))
    expect(screen.getAllByTestId('notebook-image').length).toBe(1)

    // A non-image, non-video file is rejected with its own message.
    dropFiles(body, [new File([new Uint8Array([1, 2, 3])], 'notes.txt', { type: 'text/plain' })])
    await screen.findByText(t('errNotImage'))

    // Saving stores exactly one attachment.
    fireEvent.change(screen.getByTestId('notebook-title'), { target: { value: '带图记事' } })
    fireEvent.click(screen.getByTestId('notebook-done'))
    await waitFor(() => expect(screen.queryByTestId('notebook-editor')).toBeNull())
    await waitFor(() => expect(api.state.notes.length).toBe(1))
    expect(api.state.notes[0].attachments.length).toBe(1)
    expect(api.state.notes[0].attachments[0].name).toBe('dropped.png')
  })

  it('takes images from the file picker too', async () => {
    renderView()
    await screen.findByTestId('notebook-empty')
    fireEvent.click(screen.getByTestId('notebook-new'))
    await screen.findByTestId('notebook-editor')

    const input = screen.getByTestId('notebook-file-input') as HTMLInputElement
    expect(input.accept).toBe('image/*')
    expect(input.multiple).toBe(true)

    Object.defineProperty(input, 'files', { value: [png('picked.png')], configurable: true })
    fireEvent.change(input)

    await waitFor(() => expect(screen.getAllByTestId('notebook-image').length).toBe(1))
    expect(screen.getByText('picked.png')).toBeTruthy()
  })

  it('never fetches while the panel is hidden, and loads when it is revealed', async () => {
    const api = createFakeApi()
    const { view } = renderView({ api, visible: false })

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(api.calls).toEqual([])
    expect(screen.queryByTestId('notebook-list')).toBeNull()
    expect(screen.queryByTestId('notebook-empty')).toBeNull()

    view.rerender(
      <NotebookView
        api={api}
        prefs={{ ...DEFAULT_PREFS }}
        onPrefsChange={vi.fn()}
        visible
      />,
    )
    await screen.findByTestId('notebook-empty')
    expect(api.calls).toContain('getState')
  })

  it('supports Cmd/Ctrl+Enter to finish and Esc to cancel', async () => {
    const { api } = renderView()
    await screen.findByTestId('notebook-empty')

    fireEvent.click(screen.getByTestId('notebook-new'))
    const body = await screen.findByTestId('notebook-body')
    fireEvent.change(screen.getByTestId('notebook-title'), { target: { value: '快捷键记事' } })
    fireEvent.keyDown(body, { key: 'Enter', ctrlKey: true })

    await waitFor(() => expect(screen.queryByTestId('notebook-editor')).toBeNull())
    await waitFor(() => expect(api.state.notes.length).toBe(1))
    expect(api.state.notes[0].title).toBe('快捷键记事')

    // Esc on a pristine draft cancels without a confirmation prompt.
    fireEvent.click(screen.getByTestId('notebook-new'))
    await screen.findByTestId('notebook-editor')
    fireEvent.keyDown(screen.getByTestId('notebook-body'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('notebook-editor')).toBeNull())
    expect(api.state.notes.length).toBe(1)
  })

  it('shrinks the editor list back to zero when it is cancelled', async () => {
    renderView()
    await screen.findByTestId('notebook-empty')
    fireEvent.click(screen.getByTestId('notebook-new'))
    await screen.findByTestId('notebook-editor')

    fireEvent.click(screen.getByTestId('notebook-cancel'))
    await waitFor(() => expect(screen.queryByTestId('notebook-editor')).toBeNull())
    expect(screen.queryAllByTestId('notebook-editor').length).toBe(0)
    expect(screen.getByTestId('notebook-empty')).toBeTruthy()
  })
  it('asks before deleting when confirmDelete is on, then removes the row', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const api = createFakeApi({ notes: [seedNote()] })
    renderView({ api })

    await screen.findByRole('button', { name: '待删除' })
    fireEvent.click(screen.getByTestId('notebook-note-delete'))

    await waitFor(() => expect(api.calls).toContain('deleteNote'))
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy.mock.calls[0][0]).toContain('待删除')
    await waitFor(() => expect(screen.queryByTestId('notebook-note')).toBeNull())
    expect(api.state.notes.length).toBe(0)
    expect(await screen.findByTestId('notebook-empty')).toBeTruthy()
  })

  it('deletes without asking when confirmDelete is off, and keeps the note when refused', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const api = createFakeApi({ notes: [seedNote()], prefs: { confirmDelete: true } })
    renderView({ api })

    await screen.findByRole('button', { name: '待删除' })
    // Refused confirmation: nothing is deleted, nothing is fetched.
    fireEvent.click(screen.getByTestId('notebook-note-delete'))
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1))
    expect(api.calls).not.toContain('deleteNote')
    expect(api.state.notes.length).toBe(1)

    // With the preference off there is no prompt at all (fresh render).
    cleanup()
    const quietApi = createFakeApi({ notes: [seedNote()] })
    renderView({ api: quietApi, prefs: { confirmDelete: false } })
    await screen.findByRole('button', { name: '待删除' })
    fireEvent.click(screen.getByTestId('notebook-note-delete'))
    await waitFor(() => expect(quietApi.calls).toContain('deleteNote'))
    expect(confirmSpy).toHaveBeenCalledTimes(1)
  })
})

describe('NotebookSettingsPanel', () => {
  it('reports every preference as a patch (all five fields, spec §5)', () => {
    const onChange = vi.fn()
    render(<NotebookSettingsPanel prefs={{ ...DEFAULT_PREFS }} onChange={onChange} />)

    fireEvent.change(screen.getByTestId('notebook-setting-sortOrder'), { target: { value: 'title' } })
    expect(onChange).toHaveBeenCalledWith({ sortOrder: 'title' })

    fireEvent.click(screen.getByTestId('notebook-setting-copyImagesAsName'))
    expect(onChange).toHaveBeenCalledWith({ copyImagesAsName: false })

    fireEvent.change(screen.getByTestId('notebook-setting-maxImagesPerNote'), { target: { value: '500' } })
    expect(onChange).toHaveBeenCalledWith({ maxImagesPerNote: 100 })

    fireEvent.click(screen.getByTestId('notebook-setting-confirmDelete'))
    expect(onChange).toHaveBeenCalledWith({ confirmDelete: false })

    fireEvent.click(screen.getByTestId('notebook-setting-openOnStart'))
    expect(onChange).toHaveBeenCalledWith({ openOnStart: true })

    expect(onChange).toHaveBeenCalledTimes(5)
  })
})
