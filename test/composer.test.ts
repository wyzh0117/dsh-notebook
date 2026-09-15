// @vitest-environment node
/**
 * The composer bridge: the duck-typed seams that turn a notebook entry into
 * composer state.
 *
 * These tests drive the module with a fake `ctx.sessions` / `ctx.conversation`
 * pair shaped exactly like DSH 0.1.5-rc.2's published faces (an observable
 * session list, `scope(id)`, `createDrafts`, the per-session input facade and
 * the scoped `bail` dispatch), and assert the *calls* — the real composer is
 * covered live, not here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendComposerText,
  createNotebookComposer,
  endOfDraftSpan,
  fetchAttachmentFile,
  insertComposerReference,
  isComposerImageMime,
  noteMention,
  noteReferenceInsert,
  readComposerState,
  resolveComposerTarget,
} from '../src/client/composer'
import type { DshSessionInputLike } from '../src/client/composer'
import type { ClientContext } from '../src/client/hosts/types'
import type { NotebookAttachment, NotebookNote } from '../src/shared/types'

// ── fakes ───────────────────────────────────────────────────────────────────

interface FakeComposerOptions {
  current?: string | null
  phase?: string
  draft?: string
  draftRev?: number
  chipClipboardLength?: number
  bailResult?: boolean
  acceptAttachments?: boolean
  noScope?: boolean
  onBail?: (name: string, payload: unknown) => void
}

/** One fake of everything `resolveComposerTarget` walks through. */
function createFakeComposer(options: FakeComposerOptions = {}) {
  const current = options.current === undefined ? 'session-1' : options.current
  const occurrences =
    options.chipClipboardLength === undefined
      ? []
      : [{ offset: 0, length: options.chipClipboardLength, label: 'chip', clipboardText: 'x' }]
  const state = {
    draft: options.draft ?? '',
    draftRev: options.draftRev ?? 3,
    phase: options.phase ?? 'plain',
    occurrences,
  }

  const bail = vi.fn((_thisArg: unknown, name: string, payload: unknown): unknown => {
    options.onBail?.(name, payload)
    return options.bailResult === false ? undefined : true
  })
  const actx = { bail }

  interface FakeInput {
    state: { getSnapshot(): typeof state }
    addAttachments: ReturnType<typeof vi.fn>
    setDraft: ReturnType<typeof vi.fn>
    insertText?: ReturnType<typeof vi.fn>
    insertReference?: ReturnType<typeof vi.fn>
  }
  const input: FakeInput = {
    state: { getSnapshot: () => state },
    addAttachments: vi.fn(() => options.acceptAttachments !== false),
    setDraft: vi.fn(),
    insertText: vi.fn(() => false),
    insertReference: vi.fn(() => false),
  }

  const created: File[][] = []
  const released: unknown[] = []
  const conversation = {
    createDrafts: vi.fn((_sessionId: string, files: readonly File[]) => {
      created.push([...files])
      return files.map((file, index) => ({ id: `draft-${index}`, kind: 'image', file }))
    }),
    releaseDraftAttachments: vi.fn((drafts: readonly unknown[]) => {
      released.push(drafts)
    }),
    input: { for: vi.fn(() => input as unknown as DshSessionInputLike) },
  }

  const sessions = {
    list: { getSnapshot: () => ({ current }) },
    scope: vi.fn(() => (options.noScope === true ? undefined : actx)),
  }

  const ctx = {
    get: (name: string) =>
      name === 'sessions' ? sessions : name === 'conversation' ? conversation : undefined,
  } as unknown as ClientContext

  return { ctx, sessions, conversation, input, actx, bail, created, released, state }
}

function attachment(over: Partial<NotebookAttachment> = {}): NotebookAttachment {
  return {
    id: 'att-1',
    name: 'cover.png',
    mime: 'image/png',
    size: 12,
    relPath: 'note-1/att-1.png',
    createdAt: 1,
    ...over,
  }
}

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

const urlFor = (noteId: string, relPath: string): string => `/notebook/api/attachments/${noteId}/${relPath}`

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ── target resolution ───────────────────────────────────────────────────────

describe('resolveComposerTarget', () => {
  it('resolves the current session, its scope and its input facade', () => {
    const fake = createFakeComposer()
    const target = resolveComposerTarget(fake.ctx)
    expect(target?.sessionId).toBe('session-1')
    expect(fake.sessions.scope).toHaveBeenCalledWith('session-1')
    expect(fake.conversation.input.for).toHaveBeenCalledWith(fake.actx)
    expect(target?.input).toBe(fake.input)
  })

  it('is inert without the conversation service, without a session, or without a scope', () => {
    expect(resolveComposerTarget(undefined)).toBeNull()
    expect(resolveComposerTarget({ get: () => undefined } as unknown as ClientContext)).toBeNull()

    const noSession = createFakeComposer({ current: null })
    expect(resolveComposerTarget(noSession.ctx)).toBeNull()

    const noScope = createFakeComposer({ noScope: true })
    const target = resolveComposerTarget(noScope.ctx)
    // the session is still addressable — only the facade is missing
    expect(target?.sessionId).toBe('session-1')
    expect(target?.input).toBeUndefined()
  })
})

// ── state / span math ───────────────────────────────────────────────────────

describe('readComposerState + endOfDraftSpan', () => {
  it('normalizes the published state', () => {
    const fake = createFakeComposer({ draft: 'hello', draftRev: 7, phase: 'claimed' })
    const state = readComposerState(fake.input as unknown as DshSessionInputLike)
    expect(state).toEqual({ draft: 'hello', draftRev: 7, phase: 'claimed', occurrences: [] })
  })

  it('returns null when the facade publishes nothing', () => {
    expect(readComposerState(undefined)).toBeNull()
    expect(readComposerState({} as DshSessionInputLike)).toBeNull()
  })

  it('normalizes malformed occurrences instead of trusting them', () => {
    const input = {
      state: {
        getSnapshot: () => ({
          draft: 'abc',
          draftRev: 4,
          phase: 'plain',
          occurrences: [null, 'nope', {}, { offset: -3, length: Number.NaN }, { offset: '2', length: '7' }],
        }),
      },
    } as unknown as DshSessionInputLike
    expect(readComposerState(input)).toEqual({
      draft: 'abc',
      draftRev: 4,
      phase: 'plain',
      // null and 'nope' are not objects and are dropped; the three object
      // entries are kept with numeric, non-negative fields.
      occurrences: [
        { offset: 0, length: 0 },
        { offset: 0, length: 0 },
        { offset: 0, length: 0 },
      ],
    })
  })

  it('maps a chip-free draft end one-to-one', () => {
    expect(endOfDraftSpan({ draft: 'abc', draftRev: 2, phase: 'plain', occurrences: [] })).toEqual({
      start: 3,
      end: 3,
      draftRev: 2,
    })
  })

  it('shrinks the end by every chip: one detect character per chip clipboard text', () => {
    // clipboard form is 26 characters long, detect form is exactly one
    const chip = '@[标题](dsh-notebook:n1)'
    const draft = `看 ${chip}`
    const span = endOfDraftSpan({
      draft,
      draftRev: 5,
      phase: 'plain',
      occurrences: [{ offset: 2, length: chip.length }],
    })
    expect(span).toEqual({ start: draft.length - (chip.length - 1), end: draft.length - (chip.length - 1), draftRev: 5 })
  })

  it('stays exact for several chips and for a chip with empty clipboard text', () => {
    // Two chips, one of them expanding to nothing: detect = 2 characters while
    // the clipboard projection contributes the first chip's text only.
    const chip = '@[标题](dsh-notebook:n1)'
    const draft = `a${chip}b`
    const span = endOfDraftSpan({
      draft,
      draftRev: 9,
      phase: 'plain',
      occurrences: [
        { offset: 1, length: chip.length },
        { offset: 1 + chip.length + 1, length: 0 },
      ],
    })
    // 'a' + chip(1 detect) + 'b' + empty chip(1 detect) = 4 detect characters,
    // while the clipboard projection is 1 + 26 + 1 + 0 = 28.
    expect(span).toEqual({ start: 4, end: 4, draftRev: 9 })
    expect(draft.length + 2 - chip.length).toBe(4)
  })
})

// ── text insertion ──────────────────────────────────────────────────────────

describe('appendComposerText', () => {
  it('dispatches the scoped insert-text event with an end span', () => {
    const fake = createFakeComposer({ draft: '已有草稿' })
    const target = resolveComposerTarget(fake.ctx)!
    expect(appendComposerText(target, '正文')).toBe(true)

    expect(fake.bail).toHaveBeenCalledTimes(1)
    const [thisArg, name, payload] = fake.bail.mock.calls[0]!
    expect(thisArg).toBe(fake.actx)
    expect(name).toBe('slash/input-insert-text')
    expect(payload).toEqual({
      text: '\n正文',
      span: { start: 4, end: 4, draftRev: 3 },
    })
    expect(fake.input.setDraft).not.toHaveBeenCalled()
  })

  it('does not prepend a newline into an empty draft', () => {
    const fake = createFakeComposer({ draft: '' })
    const target = resolveComposerTarget(fake.ctx)!
    appendComposerText(target, '正文')
    expect((fake.bail.mock.calls[0]![2] as { text: string }).text).toBe('正文')
  })

  it('falls back to the facade insertText, then to a draft rebuild', () => {
    const fallback = createFakeComposer({ bailResult: false, draft: 'draft' })
    fallback.input.insertText = vi.fn(() => true)
    const target = resolveComposerTarget(fallback.ctx)!
    expect(appendComposerText(target, 'x')).toBe(true)
    expect(fallback.input.insertText).toHaveBeenCalledTimes(1)
    expect(fallback.input.setDraft).not.toHaveBeenCalled()

    const last = createFakeComposer({ bailResult: false, draft: 'draft' })
    last.input.insertText = undefined
    const lastTarget = resolveComposerTarget(last.ctx)!
    expect(appendComposerText(lastTarget, 'x')).toBe(true)
    expect(last.input.setDraft).toHaveBeenCalledWith('draft\nx')
  })

  it('appends past an existing chip using detect coordinates', () => {
    // `看 ` is two characters, the chip is one detect character but 26 clipboard
    // ones: the insertion must land at detect offset 3, not at draft.length.
    const chip = '@[标题](dsh-notebook:n1)'
    const fake = createFakeComposer({ draft: `看 ${chip}`, chipClipboardLength: chip.length })
    const target = resolveComposerTarget(fake.ctx)!
    expect(appendComposerText(target, '正文')).toBe(true)

    const [, name, payload] = fake.bail.mock.calls[0]!
    expect(name).toBe('slash/input-insert-text')
    expect(payload).toEqual({ text: '\n正文', span: { start: 3, end: 3, draftRev: 3 } })
  })

  it('refuses to write while a submission is in flight', () => {
    const fake = createFakeComposer({ phase: 'submitting' })
    const target = resolveComposerTarget(fake.ctx)!
    expect(appendComposerText(target, 'x')).toBe(false)
    expect(fake.bail).not.toHaveBeenCalled()
    expect(fake.input.setDraft).not.toHaveBeenCalled()
  })
})

describe('insertComposerReference', () => {
  it('dispatches the scoped insert-reference event with the note chip', () => {
    const fake = createFakeComposer({ draft: '' })
    const target = resolveComposerTarget(fake.ctx)!
    const reference = noteReferenceInsert(note())
    expect(insertComposerReference(target, reference)).toBe(true)

    const [, name, payload] = fake.bail.mock.calls[0]!
    expect(name).toBe('slash/input-insert-reference')
    expect(payload).toEqual({ reference, span: { start: 0, end: 0, draftRev: 3 } })
    expect(reference.source).toBe('dsh-notebook')
    expect(reference.clipboardText).toBe('@[标题](dsh-notebook:note-1)')
  })

  it('inserts a second chip after an existing one (detect span, never inside it)', () => {
    const chip = '@[标题](dsh-notebook:n1)'
    const fake = createFakeComposer({ draft: chip, chipClipboardLength: chip.length })
    const target = resolveComposerTarget(fake.ctx)!
    expect(insertComposerReference(target, noteReferenceInsert(note()))).toBe(true)

    const [, name, payload] = fake.bail.mock.calls[0]!
    expect(name).toBe('slash/input-insert-reference')
    expect((payload as { span: unknown }).span).toEqual({ start: 1, end: 1, draftRev: 3 })
  })

  it('reports failure when neither the event nor the facade accepts the chip', () => {
    const fake = createFakeComposer({ bailResult: false })
    fake.input.insertReference = undefined
    const target = resolveComposerTarget(fake.ctx)!
    expect(insertComposerReference(target, noteReferenceInsert(note()))).toBe(false)
  })
})

// ── attachments ─────────────────────────────────────────────────────────────

describe('fetchAttachmentFile', () => {
  it('re-reads a stored image as a File with its stored name and type', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, blob: async () => blob }))
    vi.stubGlobal('fetch', fetchMock)

    const file = await fetchAttachmentFile(attachment(), urlFor('note-1', 'note-1/att-1.png'))
    expect(fetchMock).toHaveBeenCalledWith(urlFor('note-1', 'note-1/att-1.png'), {
      cache: 'no-store',
      credentials: 'same-origin',
    })
    expect(file.name).toBe('cover.png')
    expect(file.type).toBe('image/png')
    expect(file.size).toBe(3)
  })

  it('rejects a failed read and names a nameless file after its type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, blob: async () => new Blob([]) })),
    )
    await expect(fetchAttachmentFile(attachment(), '/x')).rejects.toThrow('404')

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob([], { type: 'image/webp' }) })),
    )
    const file = await fetchAttachmentFile(attachment({ name: '', mime: 'image/webp' }), '/x')
    expect(file.name).toBe('image.webp')
  })
})

describe('attachImages', () => {
  function stubFetch(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        blob: async () => new Blob([new Uint8Array([1])], { type: url.endsWith('.svg') ? 'image/svg+xml' : 'image/png' }),
      })),
    )
  }

  it('registers every supported image as a draft attachment', async () => {
    stubFetch()
    const fake = createFakeComposer()
    const composer = createNotebookComposer(fake.ctx, urlFor)

    const result = await composer.attachImages(
      note({ attachments: [attachment(), attachment({ id: 'att-2', name: 'b.png', relPath: 'note-1/att-2.png' })] }),
    )

    expect(result).toEqual({ ok: true, inserted: 2, skipped: 0, failed: 0 })
    expect(fake.conversation.createDrafts).toHaveBeenCalledWith('session-1', expect.any(Array))
    expect(fake.input.addAttachments).toHaveBeenCalledWith(['draft-0', 'draft-1'])
    expect(fake.released).toHaveLength(0)
  })

  it('skips formats the composer cannot take (SVG) and still inserts the rest', async () => {
    stubFetch()
    const fake = createFakeComposer()
    const composer = createNotebookComposer(fake.ctx, urlFor)

    const result = await composer.attachImages(
      note({
        attachments: [
          attachment({ id: 'att-svg', name: 'logo.svg', mime: 'image/svg+xml', relPath: 'note-1/att-svg.svg' }),
          attachment(),
        ],
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.inserted).toBe(1)
    expect(result.skipped).toBe(1)
    expect((fake.created[0] ?? []).map((file) => file.name)).toEqual(['cover.png'])
  })

  it('honours the image cap', async () => {
    stubFetch()
    const fake = createFakeComposer()
    const composer = createNotebookComposer(fake.ctx, urlFor)
    const result = await composer.attachImages(
      note({
        attachments: [
          attachment({ id: 'a', name: 'a.png', relPath: 'n/a.png' }),
          attachment({ id: 'b', name: 'b.png', relPath: 'n/b.png' }),
        ],
      }),
      { max: 1 },
    )
    expect(result.inserted).toBe(1)
  })

  it('reports a read failure as fetch-failed, not as nothing-to-insert', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, blob: async () => new Blob([]) })),
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = createFakeComposer()
    const composer = createNotebookComposer(fake.ctx, urlFor)

    const result = await composer.attachImages(note({ attachments: [attachment()] }))
    expect(result).toEqual({ ok: false, inserted: 0, skipped: 0, failed: 1, reason: 'fetch-failed' })
    expect(fake.conversation.createDrafts).not.toHaveBeenCalled()
  })

  it('is no-target when the conversation cannot mint drafts or the session has no facade', async () => {
    stubFetch()
    const noDrafts = createFakeComposer()
    ;(noDrafts.conversation as { createDrafts?: unknown }).createDrafts = undefined
    expect(await createNotebookComposer(noDrafts.ctx, urlFor).attachImages(note({ attachments: [attachment()] })))
      .toEqual({ ok: false, inserted: 0, skipped: 0, failed: 0, reason: 'no-target' })

    const noInput = createFakeComposer({ noScope: true })
    expect(await createNotebookComposer(noInput.ctx, urlFor).attachImages(note({ attachments: [attachment()] })))
      .toEqual({ ok: false, inserted: 0, skipped: 0, failed: 0, reason: 'no-target' })
    expect(noInput.conversation.createDrafts).not.toHaveBeenCalled()
  })

  it('gives the drafts back when the rail refuses them', async () => {
    stubFetch()
    const fake = createFakeComposer({ acceptAttachments: false })
    const composer = createNotebookComposer(fake.ctx, urlFor)
    const result = await composer.attachImages(note({ attachments: [attachment()] }))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('refused')
    expect(fake.conversation.releaseDraftAttachments).toHaveBeenCalledTimes(1)
  })

  it('reports no-target / no-images without inventing success', async () => {
    stubFetch()
    const unreachable = createNotebookComposer(
      { get: () => undefined } as unknown as ClientContext,
      urlFor,
    )
    expect(await unreachable.attachImages(note({ attachments: [attachment()] }))).toEqual({
      ok: false,
      inserted: 0,
      skipped: 0,
      failed: 0,
      reason: 'no-target',
    })

    const fake = createFakeComposer()
    const composer = createNotebookComposer(fake.ctx, urlFor)
    const empty = await composer.attachImages(note({ attachments: [] }))
    expect(empty.ok).toBe(false)
    expect(empty.reason).toBe('no-images')
    expect(fake.conversation.createDrafts).not.toHaveBeenCalled()
  })
})

// ── the whole bridge ────────────────────────────────────────────────────────

describe('createNotebookComposer', () => {
  it('references a note as an atomic chip and keeps the title out of the model text', () => {
    const fake = createFakeComposer()
    const composer = createNotebookComposer(fake.ctx, urlFor)

    expect(composer.available()).toBe(true)
    expect(composer.sessionId()).toBe('session-1')
    expect(composer.reference(note(), '正文')).toBe(true)
    expect(fake.bail).toHaveBeenCalledWith(
      fake.actx,
      'slash/input-insert-reference',
      expect.objectContaining({ reference: expect.objectContaining({ ref: 'note-1', label: '标题' }) }),
    )
    // no text fallback: the chip carries the reference
    expect(fake.bail).toHaveBeenCalledTimes(1)
  })

  it('falls back to plain text when the composition has no chip path', () => {
    const fake = createFakeComposer({ bailResult: false })
    fake.input.insertReference = undefined
    const composer = createNotebookComposer(fake.ctx, urlFor)
    expect(composer.reference(note(), '正文')).toBe(true)
    expect(fake.input.setDraft).toHaveBeenCalledWith('正文')
  })

  it('is inert (and never throws) without a composer target', async () => {
    const composer = createNotebookComposer({ get: () => undefined } as unknown as ClientContext, urlFor)
    expect(composer.available()).toBe(false)
    expect(composer.sessionId()).toBeNull()
    expect(composer.appendText('x')).toBe(false)
    expect(composer.reference(note(), '正文')).toBe(false)
  })
})

// ── pure helpers ────────────────────────────────────────────────────────────

describe('image mime + mention helpers', () => {
  it('accepts only the four composer image types', () => {
    expect(isComposerImageMime('image/png')).toBe(true)
    expect(isComposerImageMime('image/jpg')).toBe(true) // normalized alias
    expect(isComposerImageMime('image/svg+xml')).toBe(false)
    expect(isComposerImageMime(undefined)).toBe(false)
  })

  it('escapes brackets out of the mention label', () => {
    expect(noteMention('n1', 'a[b]c')).toBe('@[abc](dsh-notebook:n1)')
  })

  it('uses the untitled fallback label when a note has no title', () => {
    expect(noteReferenceInsert(note({ title: '  ' }), '无标题').label).toBe('无标题')
    expect(noteReferenceInsert(note({ title: 'T' }), '无标题').label).toBe('T')
  })
})
