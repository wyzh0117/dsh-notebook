/**
 * The browser-side HTTP client (the only module that talks to the host API).
 *
 * This layer is thin, which is exactly why it needs its own tests: it is where a
 * response is turned back into `NotebookPrefs`, and a key dropped here would
 * silently revert a user's setting to its default on the next save (the server
 * response is merged over the optimistic local value). `fetch` is stubbed, so
 * every case is about the shaping rules, not about the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_API_BASE, NotebookApiError, apiErrorMessage, createNotebookApi } from '../src/client/api'
import { DEFAULT_PREFS } from '../src/shared/types'

/** One captured request, plus the response the stub will answer it with. */
interface Call {
  url: string
  method: string
  body: unknown
}

let calls: Call[] = []

/** Install a fetch stub answering `responder`; returns the recorded calls. */
function stubFetch(responder: (call: Call) => { status?: number; json?: unknown; text?: string }): void {
  const impl = async (url: string, init?: { method?: string; body?: string }) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    }
    calls.push(call)
    const result = responder(call)
    const status = result.status ?? 200
    const text = result.text ?? JSON.stringify(result.json ?? {})
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      text: async () => text,
    }
  }
  vi.stubGlobal('fetch', impl)
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createNotebookApi — reads', () => {
  it('normalizes a document, keeping both v0.2.0 preferences', async () => {
    stubFetch(() => ({
      json: {
        doc: {
          version: 1,
          notes: [{ id: 'n1', title: 't', body: 'b', attachments: [], createdAt: 1, updatedAt: 2 }],
          prefs: { ...DEFAULT_PREFS, selectionToNotebook: false, messageToNotebook: false },
        },
        degraded: false,
      },
    }))
    const api = createNotebookApi()

    const state = await api.getState()

    expect(calls[0]).toEqual({ url: `${DEFAULT_API_BASE}/state`, method: 'GET', body: undefined })
    expect(state.doc.notes).toHaveLength(1)
    expect(state.doc.prefs.selectionToNotebook).toBe(false)
    expect(state.doc.prefs.messageToNotebook).toBe(false)
    expect(state.degraded).toBe(false)
  })

  it('defaults a MISSING preference to ON instead of dropping it (an older host)', async () => {
    // The shape a host from before v0.2.0 answers with.
    stubFetch(() => ({ json: { doc: { version: 1, notes: [], prefs: { sortOrder: 'title' } }, degraded: true } }))
    const api = createNotebookApi()

    const state = await api.getState()

    expect(state.doc.prefs.sortOrder).toBe('title')
    expect(state.doc.prefs.selectionToNotebook).toBe(true)
    expect(state.doc.prefs.messageToNotebook).toBe(true)
    expect(state.degraded).toBe(true)
  })

  it('repairs a malformed document rather than trusting it', async () => {
    stubFetch(() => ({ json: { doc: { notes: 'nope', prefs: { maxImagesPerNote: -5, sortOrder: 'nonsense' } } } }))
    const api = createNotebookApi()

    const state = await api.getState()

    expect(state.doc.notes).toEqual([])
    expect(state.doc.prefs.maxImagesPerNote).toBe(DEFAULT_PREFS.maxImagesPerNote)
    expect(state.doc.prefs.sortOrder).toBe(DEFAULT_PREFS.sortOrder)
  })
})

describe('createNotebookApi — writes', () => {
  it('sends a pref patch and returns the server’s normalized prefs', async () => {
    stubFetch(() => ({ json: { prefs: { ...DEFAULT_PREFS, selectionToNotebook: false, messageToNotebook: true } } }))
    const api = createNotebookApi()

    const prefs = await api.updatePrefs({ selectionToNotebook: false })

    expect(calls[0]).toEqual({
      url: `${DEFAULT_API_BASE}/prefs`,
      method: 'PATCH',
      body: { selectionToNotebook: false },
    })
    expect(prefs.selectionToNotebook).toBe(false)
    expect(prefs.messageToNotebook).toBe(true)
  })

  it('posts a note with its attachments and normalizes the answer', async () => {
    stubFetch(() => ({ json: { note: { id: 'n9', title: '未命名1', body: 'x' } } }))
    const api = createNotebookApi()

    const note = await api.createNote({ title: '未命名1', body: 'x', attachments: [] })

    expect(calls[0]).toEqual({
      url: `${DEFAULT_API_BASE}/notes`,
      method: 'POST',
      body: { title: '未命名1', body: 'x', attachments: [] },
    })
    expect(note.id).toBe('n9')
    expect(note.attachments).toEqual([])
    expect(typeof note.createdAt).toBe('number')
  })

  it('percent-encodes the note id in every path', async () => {
    stubFetch(() => ({ json: { note: { id: 'a/b c' } } }))
    const api = createNotebookApi()

    await api.updateNote('a/b c', { title: 't' })
    await api.deleteNote('a/b c')

    expect(calls[0]?.url).toBe(`${DEFAULT_API_BASE}/notes/a%2Fb%20c`)
    expect(calls[1]).toEqual({ url: `${DEFAULT_API_BASE}/notes/a%2Fb%20c`, method: 'DELETE', body: undefined })
  })

  it('builds an attachment URL from the last relPath segment only', () => {
    const api = createNotebookApi({ base: '/notebook/api/' })
    expect(api.attachmentUrl('n1', 'n1/../../etc/passwd')).toBe('/notebook/api/attachments/n1/passwd')
    expect(api.attachmentUrl('n 1', 'n 1/a b.png')).toBe('/notebook/api/attachments/n%201/a%20b.png')
  })
})

describe('createNotebookApi — failures', () => {
  it('surfaces the host’s own error envelope', async () => {
    stubFetch(() => ({ status: 400, json: { error: { code: 'BAD_REQUEST', message: 'prefs.x must be a boolean' } } }))
    const api = createNotebookApi()

    await expect(api.updatePrefs({ selectionToNotebook: false })).rejects.toThrowError(
      new NotebookApiError('BAD_REQUEST', 400, 'prefs.x must be a boolean'),
    )
  })

  it('names a transport failure instead of reporting success', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline')
    })
    const api = createNotebookApi()

    const error = await api.getState().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(NotebookApiError)
    expect((error as NotebookApiError).code).toBe('network')
    expect((error as NotebookApiError).status).toBe(0)
  })

  it('refuses a non-JSON success response', async () => {
    stubFetch(() => ({ text: '<html>not json</html>' }))
    const api = createNotebookApi()

    const error = await api.getState().catch((caught: unknown) => caught)
    expect((error as NotebookApiError).code).toBe('bad_response')
  })

  it('reports a missing fetch (a DOM-less harness) as a normal error', async () => {
    vi.stubGlobal('fetch', undefined)
    const api = createNotebookApi()

    const error = await api.getState().catch((caught: unknown) => caught)
    expect((error as NotebookApiError).code).toBe('no_fetch')
  })
})

describe('apiErrorMessage', () => {
  it('always produces a non-empty message', () => {
    expect(apiErrorMessage(new NotebookApiError('NOT_FOUND', 404, 'note "x" was not found'))).toBe(
      'note "x" was not found',
    )
    expect(apiErrorMessage(new NotebookApiError('NOT_FOUND', 404))).toBe('NOT_FOUND')
    expect(apiErrorMessage(new Error('boom'))).toBe('boom')
    expect(apiErrorMessage('plain string')).toBe('plain string')
    expect(apiErrorMessage(undefined)).toBe('unknown error')
  })
})
