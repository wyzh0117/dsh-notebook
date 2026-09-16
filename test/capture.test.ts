/**
 * The capture core: title minting, save serialization, notifications, toasts.
 *
 * Everything here is driven against a fake {@link NotebookApiClient}, so the
 * feature's observable behaviour (what title a note gets, in what order writes
 * land, what the user is told) is pinned without a browser or a host.
 */
import { describe, expect, it, vi } from 'vitest'
import { createNotebookCapture, captureEnabled, type CaptureToast } from '../src/client/capture'
import { DEFAULT_PREFS, nextUntitledTitle, type NotebookNote } from '../src/shared/types'
import type { NotebookApiClient } from '../src/client/api'

function note(over: Partial<NotebookNote> = {}): NotebookNote {
  return {
    id: 'note-1',
    title: '未命名1',
    body: '',
    attachments: [],
    createdAt: 1,
    updatedAt: 2,
    ...over,
  }
}

/** A fake host that records every created note and can be told to fail. */
function createApi(
  existing: NotebookNote[] = [],
  options: { failWith?: Error } = {},
): { api: NotebookApiClient; created: Array<{ title: string; body: string }> } {
  const created: Array<{ title: string; body: string }> = []
  const api: NotebookApiClient = {
    getState: async () => ({ doc: { version: 1, notes: existing, prefs: { ...DEFAULT_PREFS } }, degraded: false }),
    createNote: async (input) => {
      if (options.failWith) throw options.failWith
      created.push({ title: input.title, body: input.body })
      return note({ id: `note-${created.length}`, title: input.title, body: input.body })
    },
    updateNote: async () => note(),
    deleteNote: async () => {},
    updatePrefs: async () => ({ ...DEFAULT_PREFS }),
    attachmentUrl: (noteId, relPath) => `/notebook/api/attachments/${noteId}/${relPath}`,
  }
  return { api, created }
}

describe('nextUntitledTitle', () => {
  it('starts at 未命名1 when nothing is taken', () => {
    expect(nextUntitledTitle([])).toBe('未命名1')
  })

  it('mints the smallest free number, not count + 1', () => {
    // 未命名2 was deleted: the next capture must reuse the slot.
    expect(nextUntitledTitle(['未命名1', '未命名3'])).toBe('未命名2')
  })

  it('ignores titles that are not numbered defaults', () => {
    expect(nextUntitledTitle(['会议纪要', '未命名', '未命名x', ' 未命名1'])).toBe('未命名1')
  })

  it('keeps climbing past a dense run', () => {
    expect(nextUntitledTitle(['未命名1', '未命名2', '未命名3'])).toBe('未命名4')
  })
})

describe('captureEnabled', () => {
  it('treats the two v0.2.0 features as ON unless explicitly disabled', () => {
    expect(captureEnabled(undefined, 'selection')).toBe(true)
    expect(captureEnabled({}, 'answer')).toBe(true)
    expect(captureEnabled({ selectionToNotebook: true, messageToNotebook: true }, 'selection')).toBe(true)
  })

  it('honours an explicit opt-out per feature', () => {
    expect(captureEnabled({ selectionToNotebook: false }, 'selection')).toBe(false)
    expect(captureEnabled({ selectionToNotebook: false }, 'answer')).toBe(true)
    expect(captureEnabled({ messageToNotebook: false }, 'answer')).toBe(false)
  })
})

describe('capture.save', () => {
  it('mints the next default title and stores the text verbatim', async () => {
    const { api, created } = createApi([note({ id: 'a', title: '未命名1' })])
    const capture = createNotebookCapture({ api })

    const result = await capture.save({ text: '选中的一段话\n带换行', source: 'selection' })

    expect(result).not.toBeNull()
    expect(result?.title).toBe('未命名2')
    expect(created).toEqual([{ title: '未命名2', body: '选中的一段话\n带换行' }])
  })

  it('uses an explicit title as-is (the answer feature stores the session title)', async () => {
    const { api, created } = createApi()
    const capture = createNotebookCapture({ api })

    const result = await capture.save({ text: '整条回复', title: '重构计划', source: 'answer' })

    expect(result?.title).toBe('重构计划')
    expect(created).toEqual([{ title: '重构计划', body: '整条回复' }])
  })

  it('falls back to the numbered default when the explicit title is blank', async () => {
    const { api, created } = createApi()
    const capture = createNotebookCapture({ api })

    await capture.save({ text: '正文', title: '   ', source: 'answer' })

    expect(created[0]?.title).toBe('未命名1')
  })

  it('is a no-op for whitespace-only text — no note, no error', async () => {
    const { api, created } = createApi()
    const capture = createNotebookCapture({ api })

    expect(await capture.save({ text: '   \n\t ', source: 'selection' })).toBeNull()
    expect(created).toEqual([])
  })

  /**
   * The body is the user's exact text. A future `.trim()` on the way in would
   * silently rewrite what they filed, so the padding is asserted here rather
   * than only on the DOM side.
   */
  it('stores padded text verbatim (no trim on the way in)', async () => {
    const { api, created } = createApi()
    const capture = createNotebookCapture({ api })

    await capture.save({ text: '  indented\n\n  block  ', source: 'selection' })

    expect(created[0]?.body).toBe('  indented\n\n  block  ')
  })

  it('never reuses a number across consecutive captures, even with a stale title list', async () => {
    const { api } = createApi()
    // The host list never grows in this fake: exactly what a read outage (or a
    // lagging write) looks like to the service. The activation's own record of
    // what it wrote is the only thing that keeps the numbers apart.
    const capture = createNotebookCapture({ api })

    const first = await capture.save({ text: 'a', source: 'selection' })
    const second = await capture.save({ text: 'b', source: 'selection' })
    const third = await capture.save({ text: 'c', source: 'selection' })

    expect([first?.title, second?.title, third?.title]).toEqual(['未命名1', '未命名2', '未命名3'])
  })

  it('serializes writes in call order', async () => {
    const { api } = createApi()
    const order: string[] = []
    const ordered: NotebookApiClient = {
      ...api,
      createNote: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, input.body === 'first' ? 20 : 0))
        order.push(input.body)
        return note({ title: input.title, body: input.body })
      },
    }
    const capture = createNotebookCapture({ api: ordered })

    await Promise.all([
      capture.save({ text: 'first', source: 'selection' }),
      capture.save({ text: 'second', source: 'selection' }),
    ])

    expect(order).toEqual(['first', 'second'])
  })

  /**
   * The retry runs on the SAME service instance: a fresh one would prove
   * nothing about the released number, because a fresh service has nothing
   * reserved in the first place.
   */
  it('propagates a host failure and releases the reserved number for a retry', async () => {
    let failing = true
    const created: Array<{ title: string; body: string }> = []
    const flaky: NotebookApiClient = {
      getState: async () => ({ doc: { version: 1, notes: [], prefs: { ...DEFAULT_PREFS } }, degraded: false }),
      createNote: async (input) => {
        if (failing) throw new Error('disk on fire')
        created.push({ title: input.title, body: input.body })
        return note({ id: `note-${created.length}`, title: input.title, body: input.body })
      },
      updateNote: async () => note(),
      deleteNote: async () => {},
      updatePrefs: async () => ({ ...DEFAULT_PREFS }),
      attachmentUrl: (noteId, relPath) => `/notebook/api/attachments/${noteId}/${relPath}`,
    }
    const capture = createNotebookCapture({ api: flaky })

    await expect(capture.save({ text: 'x', source: 'selection' })).rejects.toThrow('disk on fire')

    failing = false
    // The number became free again: the retry mints 未命名1, not 未命名2.
    expect((await capture.save({ text: 'x', source: 'selection' }))?.title).toBe('未命名1')
    expect(created).toEqual([{ title: '未命名1', body: 'x' }])
  })

  it('tolerates a failed title read instead of blocking the capture', async () => {
    const { api, created } = createApi()
    const broken: NotebookApiClient = {
      ...api,
      getState: async () => {
        throw new Error('offline')
      },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const capture = createNotebookCapture({ api: broken })

    const result = await capture.save({ text: '还是存下来', source: 'selection' })

    expect(result?.title).toBe('未命名1')
    expect(created).toHaveLength(1)
    warn.mockRestore()
  })

  it('notifies subscribers only after a successful write', async () => {
    const { api } = createApi()
    const capture = createNotebookCapture({ api })
    const listener = vi.fn()
    capture.subscribe(listener)

    await capture.save({ text: '   ', source: 'selection' })
    expect(listener).not.toHaveBeenCalled()

    await capture.save({ text: '正文', source: 'selection' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('stops notifying an unsubscribed listener', async () => {
    const { api } = createApi()
    const capture = createNotebookCapture({ api })
    const listener = vi.fn()
    capture.subscribe(listener)()

    await capture.save({ text: '正文', source: 'selection' })
    expect(listener).not.toHaveBeenCalled()
  })

  it('exposes the titles it holds to the host reader', async () => {
    const { api } = createApi()
    const titles = vi.fn(async () => ['未命名1', '未命名2'])
    const capture = createNotebookCapture({ api, readTitles: titles })

    const result = await capture.save({ text: '正文', source: 'selection' })

    expect(titles).toHaveBeenCalledTimes(1)
    expect(result?.title).toBe('未命名3')
  })
})

describe('capture toasts', () => {
  it('pushes a toast, notifies, and drops it on dismiss', () => {
    const { api } = createApi()
    const capture = createNotebookCapture({ api, toastTtlMs: 0 })
    const listener = vi.fn()
    capture.subscribeToasts(listener)

    expect(capture.toasts()).toEqual([])
    capture.notify('已存入记事本「未命名1」')
    const list = capture.toasts() as CaptureToast[]
    expect(list).toHaveLength(1)
    expect(list[0]?.message).toBe('已存入记事本「未命名1」')
    expect(list[0]?.tone).toBe('ok')
    expect(listener).toHaveBeenCalledTimes(1)

    capture.dismissToast(list[0]!.id)
    expect(capture.toasts()).toEqual([])
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('keeps the tone of an error toast', () => {
    const { api } = createApi()
    const capture = createNotebookCapture({ api, toastTtlMs: 0 })
    capture.notify('存入记事本失败：offline', 'error')
    expect(capture.toasts()[0]?.tone).toBe('error')
  })

  it('ignores an empty message', () => {
    const { api } = createApi()
    const capture = createNotebookCapture({ api, toastTtlMs: 0 })
    capture.notify('')
    expect(capture.toasts()).toEqual([])
  })
})
