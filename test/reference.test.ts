// @vitest-environment node
/**
 * The `@` reference source: candidate discovery, the pick path, and the model
 * serialization the submit attempt calls per chip.
 *
 * The fake mirrors the published `ctx.inputTriggers` face (a `registerSource`
 * registry reached through `ctx.inject`) and a minimal notebook API, so the
 * source object itself is driven exactly as the trigger pipeline drives it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NOTE_CANDIDATE_LIMIT,
  REFERENCE_RETRY_LIMIT,
  createNoteCatalog,
  noteLabel,
  noteSnippet,
  registerNoteReferenceSource,
} from '../src/client/reference'
import type { InputTriggerCandidateLike, InputTriggerSourceLike } from '../src/client/reference'
import type { NotebookApiClient } from '../src/client/api'
import type { ClientContext } from '../src/client/hosts/types'
import type { NotebookNote } from '../src/shared/types'

function note(over: Partial<NotebookNote> = {}): NotebookNote {
  return {
    id: 'note-1',
    title: '标题',
    body: '正文',
    attachments: [],
    createdAt: 1,
    updatedAt: 2,
    ...over,
  }
}

/** A notebook API whose `getState` can be inspected and made to fail. */
function createFakeApi(notes: NotebookNote[]) {
  const calls = { getState: 0 }
  const api = {
    getState: async () => {
      calls.getState += 1
      return {
        doc: { version: 1 as const, notes: notes.map((entry) => ({ ...entry })), prefs: {} as never },
        degraded: false,
      }
    },
  } as unknown as NotebookApiClient
  return { api, calls }
}

/** A context that hands `inputTriggers` to the first `inject([...])`. */
function createFakeContext() {
  const sources: InputTriggerSourceLike[] = []
  const effects: Array<() => void> = []
  const ctx = {
    slots: { register: () => () => {}, inject: () => () => {} },
    locale: { register: () => () => {}, get: () => 'zh' },
    effect(callback: () => (() => void) | void) {
      const off = callback()
      const dispose = () => {
        if (typeof off === 'function') off()
      }
      effects.push(dispose)
      return dispose
    },
    get: () => undefined,
    inject(deps: readonly string[], callback: (inner: ClientContext) => unknown) {
      const inner = {
        ...ctx,
        get: (name: string) => (name === 'inputTriggers' ? service : undefined),
      } as unknown as ClientContext
      if (deps.includes('inputTriggers')) callback(inner)
      return { dispose: () => effects.splice(0).forEach((off) => off()) }
    },
  } as unknown as ClientContext
  const service = {
    registerSource: vi.fn((source: InputTriggerSourceLike) => {
      sources.push(source)
      return () => {
        const index = sources.indexOf(source)
        if (index >= 0) sources.splice(index, 1)
      }
    }),
  }
  return { ctx, service, sources }
}

const request = (query = '', signal?: AbortSignal) => ({ query, signal })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2024-05-01T00:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ── catalog ─────────────────────────────────────────────────────────────────

describe('createNoteCatalog', () => {
  it('filters by title and body, newest first, bounded by the limit', async () => {
    const { api } = createFakeApi([
      note({ id: 'a', title: 'Alpha', updatedAt: 10 }),
      note({ id: 'b', title: 'Beta', body: 'alpha in the body', updatedAt: 30 }),
      note({ id: 'c', title: 'Gamma', updatedAt: 20 }),
    ])
    const catalog = createNoteCatalog(api)

    expect((await catalog.search('')).map((entry) => entry.id)).toEqual(['b', 'c', 'a'])
    expect((await catalog.search('alpha')).map((entry) => entry.id)).toEqual(['b', 'a'])
    expect((await catalog.search('ALPHA')).map((entry) => entry.id)).toEqual(['b', 'a'])
    expect((await catalog.search('', 1)).map((entry) => entry.id)).toEqual(['b'])
  })

  it('serves menu hits from the cache inside the TTL and re-reads after it', async () => {
    const { api, calls } = createFakeApi([note()])
    const catalog = createNoteCatalog(api, { ttlMs: 1000 })

    await catalog.search('')
    await catalog.search('')
    expect(calls.getState).toBe(1)

    vi.advanceTimersByTime(1200)
    await catalog.search('')
    expect(calls.getState).toBe(2)
  })

  it('shares one in-flight read between concurrent hits', async () => {
    const { api, calls } = createFakeApi([note()])
    const catalog = createNoteCatalog(api, { ttlMs: 0 })
    await Promise.all([catalog.search(''), catalog.search('')])
    expect(calls.getState).toBe(1)
  })

  it('remembers every note it saw so a pick can label itself synchronously', async () => {
    const { api } = createFakeApi([note({ id: 'n9', title: '记住我' })])
    const catalog = createNoteCatalog(api)
    await catalog.search('')
    expect(catalog.peek('n9')?.title).toBe('记住我')
    expect(catalog.peek('missing')).toBeNull()
  })

  it('re-reads once before declaring a note gone, and reports a real failure loudly', async () => {
    const held = [note({ id: 'n1' })]
    const { api, calls } = createFakeApi(held)
    const catalog = createNoteCatalog(api, { ttlMs: 60_000 })
    await catalog.search('')
    held.push(note({ id: 'n2', title: '新条目' }))
    expect((await catalog.read('n2'))?.title).toBe('新条目')
    expect(calls.getState).toBe(2)
    expect(await catalog.read('nope')).toBeNull()

    const failing = {
      getState: async () => {
        throw new Error('boom')
      },
    } as unknown as NotebookApiClient
    await expect(createNoteCatalog(failing).read('n1')).rejects.toThrow('boom')
  })

  it('invalidate drops the fetched list but keeps the labels', async () => {
    const { api, calls } = createFakeApi([note({ id: 'n1' })])
    const catalog = createNoteCatalog(api, { ttlMs: 60_000 })
    await catalog.search('')
    catalog.invalidate()
    expect(catalog.peek('n1')).not.toBeNull()
    await catalog.search('')
    expect(calls.getState).toBe(2)
  })
})

// ── pure display helpers ────────────────────────────────────────────────────

describe('note display helpers', () => {
  it('snippets the body without markers and truncates', () => {
    const long = 'x'.repeat(200)
    const target = note({ body: `第一行\n\n![cover.png](attachment:a1)\n${long}`, attachments: [] })
    expect(noteSnippet(target).startsWith('第一行')).toBe(true)
    expect(noteSnippet(target)).not.toContain('attachment:')
    expect(noteSnippet(target).length).toBeLessThanOrEqual(61)
  })

  it('falls back to the localized untitled label', () => {
    // No locale service is attached in this suite: the plugin's primary
    // dictionary (zh) answers, exactly as it does before `attachLocale` runs.
    expect(noteLabel(note({ title: '   ' }))).toBe('无标题')
    expect(noteLabel(note({ title: '真实标题' }))).toBe('真实标题')
  })
})

// ── the registered source ───────────────────────────────────────────────────

describe('registerNoteReferenceSource', () => {
  it('registers exactly one @ source and disposes it again', async () => {
    const { api } = createFakeApi([note()])
    const fake = createFakeContext()
    const dispose = registerNoteReferenceSource(fake.ctx, createNoteCatalog(api))

    expect(fake.service.registerSource).toHaveBeenCalledTimes(1)
    const source = fake.sources[0]!
    expect(source.trigger).toBe('@')
    expect(source.name).toBe('dsh-notebook')
    expect(source.showGroupTitle).toBe(false)

    dispose()
    expect(fake.sources).toHaveLength(0)
  })

  it('lists notes as sectioned candidates carrying the note id', async () => {
    const { api } = createFakeApi([
      note({ id: 'n1', title: '会议纪要', body: '讨论了发布计划' }),
      note({ id: 'n2', title: '灵感', body: '别的' }),
    ])
    const fake = createFakeContext()
    registerNoteReferenceSource(fake.ctx, createNoteCatalog(api))
    const source = fake.sources[0]!

    const all = await source.candidates({ sessionId: 's1' }, request(''))
    expect(all).toHaveLength(2)
    expect(all[0]).toMatchObject({ name: expect.any(String), icon: 'file', section: expect.any(String) })
    expect(all.map((entry) => entry.value)).toEqual(['n1', 'n2'])

    const filtered = await source.candidates({ sessionId: 's1' }, request('发布'))
    expect(filtered.map((entry) => entry.value)).toEqual(['n1'])
  })

  it('returns no rows when the query is aborted or the read fails', async () => {
    const { api } = createFakeApi([note()])
    const fake = createFakeContext()
    registerNoteReferenceSource(fake.ctx, createNoteCatalog(api))
    const source = fake.sources[0]!

    const controller = new AbortController()
    controller.abort()
    expect(await source.candidates({ sessionId: 's1' }, request('', controller.signal))).toEqual([])

    const failing = createFakeContext()
    const brokenApi = {
      getState: async () => {
        throw new Error('offline')
      },
    } as unknown as NotebookApiClient
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerNoteReferenceSource(failing.ctx, createNoteCatalog(brokenApi))
    expect(await failing.sources[0]!.candidates({ sessionId: 's1' }, request(''))).toEqual([])
  })

  it('caps the candidate list', async () => {
    const notes = Array.from({ length: NOTE_CANDIDATE_LIMIT + 5 }, (_value, index) =>
      note({ id: `n${index}`, title: `条目 ${index}`, updatedAt: index }),
    )
    const { api } = createFakeApi(notes)
    const fake = createFakeContext()
    registerNoteReferenceSource(fake.ctx, createNoteCatalog(api))
    const candidates = await fake.sources[0]!.candidates({ sessionId: 's1' }, request(''))
    expect(candidates).toHaveLength(NOTE_CANDIDATE_LIMIT)
  })

  it('picks a note into an atomic chip whose clipboard form is the canonical mention', async () => {
    const { api } = createFakeApi([note({ id: 'n1', title: '会议纪要' })])
    const fake = createFakeContext()
    registerNoteReferenceSource(fake.ctx, createNoteCatalog(api))
    const source = fake.sources[0]!

    const candidates = await source.candidates({ sessionId: 's1' }, request(''))
    const outcome = source.onPick({ candidate: candidates[0] as InputTriggerCandidateLike })
    expect(outcome?.insert).toEqual({
      source: 'dsh-notebook',
      ref: 'n1',
      label: '会议纪要',
      appearance: 'file',
      clipboardText: '@[会议纪要](dsh-notebook:n1)',
    })
  })

  it('serializes a referenced note to its BODY — never the title', async () => {
    const { api } = createFakeApi([
      note({
        id: 'n1',
        title: '不该出现的标题',
        body: `正文\n\n![cover.png](attachment:a1)`,
      }),
    ])
    const fake = createFakeContext()
    registerNoteReferenceSource(fake.ctx, createNoteCatalog(api))
    const source = fake.sources[0]!

    const text = await source.codec.serialize('n1', new AbortController().signal)
    expect(text).toContain('正文')
    expect(text).toContain('[图片: cover.png]')
    expect(text).not.toContain('attachment:')
    expect(text).not.toContain('不该出现的标题')
  })

  it('contributes nothing for a deleted note, and propagates a real read failure', async () => {
    const { api } = createFakeApi([note({ id: 'n1' })])
    const fake = createFakeContext()
    registerNoteReferenceSource(fake.ctx, createNoteCatalog(api))
    const source = fake.sources[0]!
    expect(await source.codec.serialize('gone', new AbortController().signal)).toBe('')

    const failing = createFakeContext()
    const brokenApi = {
      getState: async () => {
        throw new Error('offline')
      },
    } as unknown as NotebookApiClient
    registerNoteReferenceSource(failing.ctx, createNoteCatalog(brokenApi))
    await expect(
      failing.sources[0]!.codec.serialize('n1', new AbortController().signal),
    ).rejects.toThrow('offline')
  })

  it('retries a refused registration instead of leaving the @ group missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { api } = createFakeApi([note()])
    const fake = createFakeContext()
    let attempts = 0
    const real = fake.service.registerSource
    const retrying = vi.fn((source: InputTriggerSourceLike) => {
      attempts += 1
      if (attempts <= 2) throw new Error('slash source "@dsh-notebook" is already registered')
      return real(source)
    })
    fake.service.registerSource = retrying

    const dispose = registerNoteReferenceSource(fake.ctx, createNoteCatalog(api))
    expect(retrying).toHaveBeenCalledTimes(1)
    expect(fake.sources).toHaveLength(0)

    // the stale activation unloads, the retry lands
    vi.advanceTimersByTime(500)
    expect(retrying).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(500)
    expect(fake.sources).toHaveLength(1)

    dispose()
    expect(fake.sources).toHaveLength(0)
    warn.mockRestore()
  })

  it('gives up after the retry budget and reports it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { api } = createFakeApi([note()])
    const fake = createFakeContext()
    fake.service.registerSource = vi.fn(() => {
      throw new Error('already registered')
    })
    const dispose = registerNoteReferenceSource(fake.ctx, createNoteCatalog(api))
    vi.advanceTimersByTime(500 * (REFERENCE_RETRY_LIMIT + 2))
    expect(fake.service.registerSource).toHaveBeenCalledTimes(REFERENCE_RETRY_LIMIT + 1)
    expect(warn).toHaveBeenCalled()
    expect(() => dispose()).not.toThrow()
    warn.mockRestore()
  })
})
