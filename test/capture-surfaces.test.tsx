// @vitest-environment jsdom
/**
 * The two capture surfaces, through the real React components:
 *
 * - the floating "进记事本" action over a text selection (and its pref gate);
 * - the "save to notebook" action under an assistant answer (answer text from
 *   the chat snapshot, title from the session projection, its own pref gate);
 * - the shared toast surface both report through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, Fragment, useRef } from 'react'
import { CaptureOverlay } from '../src/client/CaptureOverlay'
import { createAnswerActionComponent, type AnswerActionInjected } from '../src/client/NotebookAnswerAction'
import { createNotebookCapture } from '../src/client/capture'
import { createSelectionTracker, type SelectionRect } from '../src/client/selectionAction'
import { attachLocale, t } from '../src/client/locales'
import { DEFAULT_PREFS, type NotebookNote, type NotebookPrefs } from '../src/shared/types'
import type { NotebookApiClient } from '../src/client/api'

const RECT: SelectionRect = { top: 200, left: 60, right: 260, bottom: 220, width: 200, height: 20 }

function note(over: Partial<NotebookNote> = {}): NotebookNote {
  return { id: 'note-1', title: '未命名1', body: '', attachments: [], createdAt: 1, updatedAt: 2, ...over }
}

function createApi(options: { existing?: NotebookNote[]; failWith?: Error } = {}): {
  api: NotebookApiClient
  created: Array<{ title: string; body: string }>
} {
  const created: Array<{ title: string; body: string }> = []
  const api: NotebookApiClient = {
    getState: async () => ({
      doc: { version: 1, notes: options.existing ?? [], prefs: { ...DEFAULT_PREFS } },
      degraded: false,
    }),
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

/** Select the text of `#p` and give it a measurable rect. */
function selectInTranscript(text: string): void {
  document.body.innerHTML = `<div data-chat-flow><p id="p">${text}</p></div>`
  const target = document.getElementById('p')!
  const range = document.createRange()
  range.setStart(target.firstChild!, 0)
  range.setEnd(target.firstChild!, text.length)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

/** A fake runtime the surfaces subscribe to (prefs are live, not snapshotted). */
function createPrefsStore(initial: Partial<NotebookPrefs> = {}): {
  getPrefs(): NotebookPrefs
  subscribe(listener: () => void): () => void
  set(patch: Partial<NotebookPrefs>): void
} {
  let prefs: NotebookPrefs = { ...DEFAULT_PREFS, ...initial }
  const listeners = new Set<() => void>()
  return {
    getPrefs: () => prefs,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(patch) {
      prefs = { ...prefs, ...patch }
      for (const listener of [...listeners]) listener()
    },
  }
}

afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('the floating selection action', () => {
  function renderOverlay(options: {
    prefs?: Partial<NotebookPrefs>
    existing?: NotebookNote[]
    failWith?: Error
  } = {}): { created: Array<{ title: string; body: string }>; prefs: ReturnType<typeof createPrefsStore> } {
    const { api, created } = createApi({ existing: options.existing, failWith: options.failWith })
    const capture = createNotebookCapture({ api, toastTtlMs: 0 })
    const tracker = createSelectionTracker({ env: { win: window, doc: document }, measure: () => RECT })
    const prefs = createPrefsStore(options.prefs)
    render(
      createElement(CaptureOverlay, {
        tracker,
        capture,
        enabled: prefs.getPrefs().selectionToNotebook !== false,
      }),
    )
    return { created, prefs }
  }

  it('offers the action over a transcript selection and saves the exact text', async () => {
    selectInTranscript('选中的一段话')
    const { created } = renderOverlay()

    const button = screen.getByTestId('notebook-selection-action')
    expect(button.textContent).toContain(t('selectionAction'))
    fireEvent.click(button)

    await waitFor(() => expect(created).toHaveLength(1))
    expect(created[0]).toEqual({ title: '未命名1', body: '选中的一段话' })
    await waitFor(() =>
      expect(screen.getByTestId('notebook-capture-toast').textContent).toBe(
        t('selectionSaved', { title: '未命名1' }),
      ),
    )
  })

  it('numbers the default title from the notes the notebook already holds', async () => {
    selectInTranscript('第二条')
    const { created } = renderOverlay({ existing: [note({ id: 'a', title: '未命名1' })] })

    fireEvent.click(screen.getByTestId('notebook-selection-action'))

    await waitFor(() => expect(created[0]?.title).toBe('未命名2'))
  })

  it('hides the action, but keeps the toast surface, when the feature is off', () => {
    selectInTranscript('选中的一段话')
    const { prefs } = renderOverlay({ prefs: { selectionToNotebook: false } })

    expect(screen.queryByTestId('notebook-selection-action')).toBeNull()
    // The toast surface belongs to both features, so it must stay mounted.
    expect(document.querySelector('[data-dsh-notebook="capture-overlay"]')).not.toBeNull()
    expect(prefs.getPrefs().selectionToNotebook).toBe(false)
  })

  it('reports a failed save and keeps the plugin alive', async () => {
    selectInTranscript('选中的一段话')
    renderOverlay({ failWith: new Error('disk on fire') })

    fireEvent.click(screen.getByTestId('notebook-selection-action'))

    await waitFor(() =>
      expect(screen.getByTestId('notebook-capture-toast').textContent).toBe(
        t('captureFailed', { message: 'disk on fire' }),
      ),
    )
  })

  it('offers nothing when the selection disappears', async () => {
    selectInTranscript('选中的一段话')
    renderOverlay()
    expect(screen.getByTestId('notebook-selection-action')).not.toBeNull()

    window.getSelection()?.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))

    await waitFor(() => expect(screen.queryByTestId('notebook-selection-action')).toBeNull())
  })

  it('files exactly one note when the transcript re-emits selectionchange after a save', async () => {
    selectInTranscript('选中的一段话')
    const { created } = renderOverlay()

    fireEvent.click(screen.getByTestId('notebook-selection-action'))
    await waitFor(() => expect(created).toHaveLength(1))

    // The selection is still in the DOM and the shell keeps re-emitting the
    // event (an answer is streaming): the offer must stay dismissed, so there is
    // no second button to click and no duplicate note.
    document.dispatchEvent(new Event('selectionchange'))
    document.dispatchEvent(new Event('mouseup'))
    await waitFor(() => expect(screen.queryByTestId('notebook-selection-action')).toBeNull())
    expect(created).toHaveLength(1)
  })

  it('takes the click without collapsing the selection first', async () => {
    selectInTranscript('选中的一段话')
    const { created } = renderOverlay()
    const button = screen.getByTestId('notebook-selection-action')

    const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    button.dispatchEvent(mousedown)
    expect(mousedown.defaultPrevented).toBe(true)

    // The point of preventing the default: the click that follows still sees
    // the selection, so the note holds the selected text.
    fireEvent.click(button)
    await waitFor(() => expect(created).toEqual([{ title: '未命名1', body: '选中的一段话' }]))
  })
})

describe('the answer action', () => {
  /** A chat snapshot with one finalized answer. */
  function chatWith(messageId: string, text: string): { nodes: { values: () => unknown[] } } {
    return {
      nodes: {
        values: () => [
          { kind: 'user' },
          { kind: 'assistant-step', data: { finalNode: { messageId }, blocks: [{ kind: 'text', text }] } },
        ],
      },
    }
  }

  function renderAction(options: {
    messageId?: string
    answer?: string
    sessionTitle?: string | null
    prefs?: Partial<NotebookPrefs>
    existing?: NotebookNote[]
    failWith?: Error
    useChat?: boolean
    /** Override the snapshot the reader sees (version-skew cases). */
    snapshot?: unknown
  } = {}): {
    created: Array<{ title: string; body: string }>
    prefs: ReturnType<typeof createPrefsStore>
    /** How many times the component asked for the session title. */
    projectionCalls: () => number
  } {
    const { api, created } = createApi({ existing: options.existing, failWith: options.failWith })
    const capture = createNotebookCapture({ api, toastTtlMs: 0 })
    const prefs = createPrefsStore(options.prefs)
    const injected: AnswerActionInjected = {
      capture,
      getPrefs: prefs.getPrefs,
      subscribe: prefs.subscribe,
    }
    const Component = createAnswerActionComponent(injected)
    // `?? ` would swallow an intentional `null` snapshot, which is itself one of
    // the version-skew cases under test.
    const snapshot =
      options.snapshot !== undefined ? options.snapshot : chatWith(options.messageId ?? 'm1', options.answer ?? '完整的回复正文')
    let projectionCalls = 0
    const props: Record<string, unknown> = {
      messageId: options.messageId ?? 'm1',
      capture,
      getPrefs: prefs.getPrefs,
      subscribe: prefs.subscribe,
    }
    if (options.useChat !== false) {
      // Hook-SHAPED fakes: in the shell `useChat` and `useProjection` are real
      // hooks (`useSyncExternalStoreWithSelector` under the bonnet), so the
      // doubles must participate in hook order too — a plain function would
      // silently swallow the rules-of-hooks regression these tests exist to
      // catch.
      props.useChat = (selector: (value: unknown) => unknown) => {
        useRef(null)
        return selector(snapshot)
      }
      props.useProjection = () => {
        useRef(null)
        projectionCalls += 1
        return options.sessionTitle === undefined ? '会话标题' : options.sessionTitle
      }
    }
    // Mount the answer action together with the overlay, exactly as the plugin
    // composes them: the toast both features report through lives there.
    render(
      createElement(
        Fragment,
        null,
        createElement(CaptureOverlay, {
          tracker: createSelectionTracker({ env: { win: window, doc: document }, measure: () => RECT }),
          capture,
          enabled: true,
        }),
        createElement(Component as never, props),
      ),
    )
    return { created, prefs, projectionCalls: () => projectionCalls }
  }

  it('saves the whole answer under the session title', async () => {
    const { created } = renderAction({ answer: '第一段\n\n第二段', sessionTitle: '重构计划' })

    fireEvent.click(screen.getByTestId('notebook-answer-action'))

    await waitFor(() => expect(created).toHaveLength(1))
    expect(created[0]).toEqual({ title: '重构计划', body: '第一段\n\n第二段' })
    await waitFor(() =>
      expect(screen.getByTestId('notebook-capture-toast').textContent).toBe(
        t('answerSaved', { title: '重构计划' }),
      ),
    )
  })

  it('falls back to the numbered default when the session has no title yet', async () => {
    const { created } = renderAction({ sessionTitle: null, existing: [note({ id: 'a', title: '未命名1' })] })

    fireEvent.click(screen.getByTestId('notebook-answer-action'))

    await waitFor(() => expect(created[0]?.title).toBe('未命名2'))
  })

  it('reports an empty body when the message id no longer resolves', async () => {
    // A stale transcript row (its id is not in the snapshot) still renders the
    // action — the row's own existence is the slot's decision — but a click
    // must say there is nothing to save instead of writing an empty note.
    const { api, created } = createApi()
    const capture = createNotebookCapture({ api, toastTtlMs: 0 })
    const prefs = createPrefsStore()
    const Component = createAnswerActionComponent({ capture, getPrefs: prefs.getPrefs, subscribe: prefs.subscribe })
    render(
      createElement(
        Fragment,
        null,
        createElement(CaptureOverlay, {
          tracker: createSelectionTracker({ env: { win: window, doc: document }, measure: () => RECT }),
          capture,
          enabled: true,
        }),
        createElement(Component as never, {
          messageId: 'gone',
          capture,
          getPrefs: prefs.getPrefs,
          subscribe: prefs.subscribe,
          useChat: (selector: (value: unknown) => unknown) => selector(chatWith('m1', 'other')),
          useProjection: () => '会话标题',
        }),
      ),
    )

    fireEvent.click(screen.getByTestId('notebook-answer-action'))

    expect(created).toEqual([])
    await waitFor(() =>
      expect(screen.getByTestId('notebook-capture-toast').textContent).toBe(t('answerEmpty')),
    )
  })

  /**
   * v0.2.2: the icon's accessible name and its hover hint are dictionary
   * entries, so they follow the ACTIVE locale. Before the fix the locale read
   * missed DSH's `LocaleRuntime` entirely and the hint stayed Chinese under an
   * English shell — the tooltip half of the 0.2.2 report.
   */
  it('labels the icon in the language the shell is showing', () => {
    // English shell.
    attachLocale({ register: () => () => {}, getLocale: () => ({ active: 'en' }) })
    renderAction({ answer: 'x', sessionTitle: 'Plan' })
    const english = screen.getByTestId('notebook-answer-action')
    expect(english.getAttribute('aria-label')).toBe('Save to notebook')
    expect(english.getAttribute('title')).toBe('Save this answer as a note')
    cleanup()

    // Chinese shell: the same component, the same entries, the other language.
    attachLocale({ register: () => () => {}, getLocale: () => ({ active: 'zh-CN' }) })
    renderAction({ answer: 'x', sessionTitle: 'Plan' })
    const chinese = screen.getByTestId('notebook-answer-action')
    expect(chinese.getAttribute('aria-label')).toBe('存入记事本')
    expect(chinese.getAttribute('title')).toBe('把这条回复存成一条记事')
    cleanup()

    // Leave the shared module state as the rest of this file expects it (no
    // readable locale ⇒ the plugin's own zh dictionaries).
    attachLocale({ register: () => () => {} })
  })

  it('hides the action when the answer feature is off', () => {
    const { projectionCalls } = renderAction({ prefs: { messageToNotebook: false } })
    expect(screen.queryByTestId('notebook-answer-action')).toBeNull()
    // The session-title read is a REAL hook in the shell. It must run on the
    // disabled render too: skipping it would change the hook order, and React
    // refuses to render a component that calls more hooks than the previous
    // render — precisely what happens when the user turns the feature back on.
    expect(projectionCalls()).toBeGreaterThan(0)
  })

  it('follows a live pref change without re-registering', async () => {
    const { prefs } = renderAction()
    expect(screen.getByTestId('notebook-answer-action')).not.toBeNull()

    prefs.set({ messageToNotebook: false })
    await waitFor(() => expect(screen.queryByTestId('notebook-answer-action')).toBeNull())

    prefs.set({ messageToNotebook: true })
    await waitFor(() => expect(screen.getByTestId('notebook-answer-action')).not.toBeNull())
  })

  it('reports a failed save through the shared toast surface', async () => {
    renderAction({ failWith: new Error('offline') })

    fireEvent.click(screen.getByTestId('notebook-answer-action'))

    await waitFor(() =>
      expect(screen.getByTestId('notebook-capture-toast').textContent).toBe(
        t('captureFailed', { message: 'offline' }),
      ),
    )
    // …and returns to idle so the user can retry.
    await waitFor(() => expect(screen.getByTestId('notebook-answer-action').dataset.state).toBe('idle'))
  })

  it('shows a saved state after a successful save', async () => {
    renderAction({ sessionTitle: '标题' })
    fireEvent.click(screen.getByTestId('notebook-answer-action'))
    await waitFor(() => expect(screen.getByTestId('notebook-answer-action').dataset.state).toBe('saved'))
    expect(screen.getByTestId('notebook-answer-action').getAttribute('aria-label')).toBe(
      t('answerSaved', { title: '标题' }),
    )
  })

  it('renders nothing without a snapshot reader to read the answer from', () => {
    renderAction({ useChat: false })
    expect(screen.queryByTestId('notebook-answer-action')).toBeNull()
  })

  /**
   * A version skew is not the same as an empty answer. When the CONTAINER is
   * not a shape the reader understands, every row would otherwise render a
   * button whose every click says “nothing to save” — a permanently dead
   * affordance. (A container that reads fine but holds no matching node stays
   * offered on purpose: that is indistinguishable from an answer whose prose is
   * genuinely absent, and reporting it is the honest behaviour — see the stale-id
   * test above.)
   */
  it('hides the action when the snapshot is a shape the reader cannot read', () => {
    const skewShapes: unknown[] = [
      { renamedNodes: [] },
      { nodes: {} },
      { nodes: { values: 'not a function' } },
      { nodes: { values: () => 'not an array' } },
      'not an object',
      null,
    ]
    for (const snapshot of skewShapes) {
      cleanup()
      renderAction({ snapshot })
      expect([snapshot, screen.queryByTestId('notebook-answer-action')]).toEqual([snapshot, null])
    }
  })

  it('hides the action when the row carries no usable message id', () => {
    // An interrupted answer has no `finalNode.messageId`: matching the empty id
    // would file that unrelated reply under the current session's title.
    for (const messageId of ['', '   ']) {
      cleanup()
      renderAction({ messageId })
      expect([messageId, screen.queryByTestId('notebook-answer-action')]).toEqual([messageId, null])
    }
  })

  it('uses the trajectory reader when the chat reader is absent', async () => {
    const { api, created } = createApi()
    const capture = createNotebookCapture({ api, toastTtlMs: 0 })
    const prefs = createPrefsStore()
    const Component = createAnswerActionComponent({ capture, getPrefs: prefs.getPrefs, subscribe: prefs.subscribe })
    render(
      createElement(Component as never, {
        messageId: 'm7',
        capture,
        getPrefs: prefs.getPrefs,
        subscribe: prefs.subscribe,
        useTrajectory: (selector: (value: unknown) => unknown) =>
          selector({
            eventNodes: [{ kind: 'assistant', messageId: 'm7', blocks: [{ kind: 'text', text: '轨迹里的回复' }] }],
          }),
        useProjection: () => '轨迹会话',
      }),
    )

    fireEvent.click(screen.getByTestId('notebook-answer-action'))
    await waitFor(() => expect(created).toEqual([{ title: '轨迹会话', body: '轨迹里的回复' }]))
  })
})