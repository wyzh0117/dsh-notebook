// @vitest-environment jsdom
/**
 * The select-to-notebook DOM half: which selections are offered, where the
 * action lands, and how the tracker behaves across gestures.
 *
 * jsdom implements the Selection API but NOT `Range.getBoundingClientRect`, so
 * every geometry assertion goes through the tracker's injectable `measure`
 * seam — the same seam the browser default uses, with the range's own rects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACTION_HALF_WIDTH,
  ACTION_HEIGHT,
  CONVERSATION_SCOPE_SELECTORS,
  createSelectionTracker,
  isInsideEditable,
  isInsideOwnUi,
  placeAction,
  readSelection,
  resolveScopeElement,
  type SelectionRect,
} from '../src/client/selectionAction'

/** Viewport-space rect used by every test (jsdom reports zeros on its own). */
const RECT: SelectionRect = { top: 100, left: 40, right: 240, bottom: 120, width: 200, height: 20 }

function measure(): SelectionRect {
  return RECT
}

/** Put `html` in the body and select the text of the first matching element. */
function selectText(html: string, selector: string, chars?: number): Range {
  document.body.innerHTML = html
  const target = document.querySelector(selector)
  if (target === null || target.firstChild === null) throw new Error(`no text node in ${selector}`)
  const end = chars ?? (target.textContent ?? '').length
  const range = document.createRange()
  range.setStart(target.firstChild, 0)
  range.setEnd(target.firstChild, Math.min(end, (target.firstChild.textContent ?? '').length))
  const selection = window.getSelection()
  if (selection === null) throw new Error('jsdom has no selection')
  selection.removeAllRanges()
  selection.addRange(range)
  return range
}

function clearSelection(): void {
  window.getSelection()?.removeAllRanges()
}

const env = { win: window, doc: document }

afterEach(() => {
  clearSelection()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('resolveScopeElement', () => {
  it('prefers the transcript column, then the conversation scroll body', () => {
    document.body.innerHTML = '<div data-conversation-scroll><div data-chat-flow></div></div>'
    expect(resolveScopeElement(document)?.getAttribute('data-chat-flow')).toBe('')
  })

  it('falls back through the candidate list in order', () => {
    document.body.innerHTML = '<div data-slot="conversation.view"></div>'
    expect(resolveScopeElement(document)?.getAttribute('data-slot')).toBe('conversation.view')
  })

  it('reports null when the document has none of the known containers', () => {
    document.body.innerHTML = '<div class="renamed-shell"></div>'
    expect(resolveScopeElement(document)).toBeNull()
  })

  it('skips an invalid selector in a caller-supplied list instead of throwing', () => {
    document.body.innerHTML = '<div data-chat-flow></div>'
    expect(resolveScopeElement(document, ['(((', '[data-chat-flow]'])?.getAttribute('data-chat-flow')).toBe('')
  })

  it('lists the transcript hooks the shell actually stamps', () => {
    expect(CONVERSATION_SCOPE_SELECTORS[0]).toBe('[data-chat-flow]')
  })
})

describe('isInsideEditable / isInsideOwnUi', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div data-chat-flow><p id="prose">hello</p>' +
      '<textarea id="ta">draft</textarea>' +
      '<div data-composer-card><div contenteditable="true" id="ce">prompt</div></div>' +
      '<div data-dsh-notebook><p id="own">note</p></div></div>'
  })

  it('detects the composer and generic editable hosts', () => {
    expect(isInsideEditable(document.getElementById('ta')!.firstChild)).toBe(true)
    expect(isInsideEditable(document.getElementById('ce')!.firstChild)).toBe(true)
    // The composer card itself counts even outside the editor node.
    expect(isInsideEditable(document.querySelector('[data-composer-card]'))).toBe(true)
    expect(isInsideEditable(document.getElementById('prose')!.firstChild)).toBe(false)
    expect(isInsideEditable(null)).toBe(false)
  })

  it('detects this plugin’s own subtree', () => {
    expect(isInsideOwnUi(document.getElementById('own')!.firstChild)).toBe(true)
    expect(isInsideOwnUi(document.getElementById('prose')!.firstChild)).toBe(false)
  })
})

describe('readSelection', () => {
  it('offers a plain transcript selection', () => {
    selectText('<div data-chat-flow><p id="p">hello world</p></div>', '#p')
    const candidate = readSelection(env, { scope: resolveScopeElement(document), measure })
    expect(candidate?.text).toBe('hello world')
    expect(candidate?.rect).toEqual(RECT)
  })

  it('trims nothing from the stored text (the exact selection is the note)', () => {
    selectText('<div data-chat-flow><p id="p">  padded  </p></div>', '#p')
    expect(readSelection(env, { measure })?.text).toBe('  padded  ')
  })

  it('refuses a whitespace-only selection', () => {
    selectText('<div data-chat-flow><p id="p">   </p></div>', '#p')
    expect(readSelection(env, { measure })).toBeNull()
  })

  it('refuses a collapsed selection', () => {
    selectText('<div data-chat-flow><p id="p">hello</p></div>', '#p', 0)
    expect(readSelection(env, { measure })).toBeNull()
  })

  it('refuses the composer draft', () => {
    selectText('<div data-chat-flow><div data-composer-card><div contenteditable="true" id="ce">prompt text</div></div></div>', '#ce')
    expect(readSelection(env, { measure })).toBeNull()
  })

  it('refuses a selection inside the notebook’s own panel', () => {
    selectText('<div data-chat-flow><div data-dsh-notebook><p id="own">note body</p></div></div>', '#own')
    expect(readSelection(env, { measure })).toBeNull()
  })

  it('refuses a selection outside the conversation scope', () => {
    selectText('<div data-chat-flow><p id="p">inside</p></div><aside id="side">sidebar</aside>', '#side')
    expect(readSelection(env, { scope: resolveScopeElement(document), measure })).toBeNull()
  })

  it('accepts anywhere once the shell has no known scope element (version skew)', () => {
    selectText('<div class="renamed"><p id="p">inside</p></div>', '#p')
    expect(resolveScopeElement(document)).toBeNull()
    // The caller passes the resolved scope through; null means "no scope known".
    expect(readSelection(env, { scope: resolveScopeElement(document), measure })?.text).toBe('inside')
  })

  it('refuses a selection whose geometry cannot be measured', () => {
    selectText('<div data-chat-flow><p id="p">hello</p></div>', '#p')
    expect(readSelection(env, { measure: () => null })).toBeNull()
  })

  it('lets a caller refuse a candidate outright', () => {
    selectText('<div data-chat-flow><p id="p">hello</p></div>', '#p')
    expect(readSelection(env, { measure, accept: () => false })).toBeNull()
    expect(readSelection(env, { measure, accept: (candidate) => candidate.text === 'hello' })?.text).toBe('hello')
  })

  it('uses the range’s own rects when no measure seam is given', () => {
    selectText('<div data-chat-flow><p id="p">hello</p></div>', '#p')
    // jsdom's Range has no getBoundingClientRect at all, so the browser path is
    // exercised by installing one on the prototype: this is the measurement the
    // real page uses, and it must be what places the action.
    const proto = Object.getPrototypeOf(document.createRange()) as { getBoundingClientRect?: unknown }
    const had = 'getBoundingClientRect' in proto
    const previous = proto.getBoundingClientRect
    proto.getBoundingClientRect = () => ({ ...RECT, toJSON: () => RECT })
    try {
      expect(readSelection(env, {})?.rect).toEqual(RECT)
    } finally {
      if (had) proto.getBoundingClientRect = previous
      else delete proto.getBoundingClientRect
    }
  })

  it('reports nothing measurable when the platform has no rect API at all', () => {
    selectText('<div data-chat-flow><p id="p">hello</p></div>', '#p')
    // No measure seam and no platform rect (jsdom as shipped): the reader must
    // report "nothing measurable", never crash.
    expect(readSelection(env, {})).toBeNull()
  })
})

describe('placeAction', () => {
  const viewport = { width: 1000, height: 800 }

  it('sits above the selection when there is room', () => {
    expect(placeAction(RECT, viewport)).toEqual({ top: RECT.top - 8 - ACTION_HEIGHT, centerX: 140 })
  })

  it('flips below when the selection is against the top edge', () => {
    const nearTop: SelectionRect = { ...RECT, top: 4, bottom: 24 }
    expect(placeAction(nearTop, viewport)).toEqual({ top: 24 + 8, centerX: 140 })
  })

  it('stays inside the viewport when the selection is against the bottom edge', () => {
    const nearBottom: SelectionRect = { ...RECT, top: 780, bottom: 800 }
    const placed = placeAction(nearBottom, viewport)
    expect(placed.top).toBeLessThanOrEqual(viewport.height - ACTION_HEIGHT - 4)
    expect(placed.top).toBeGreaterThanOrEqual(4)
  })

  /**
   * The regression case: the tracker re-measures while the user scrolls, so a
   * live selection can end up entirely BELOW the viewport bottom. The "above"
   * branch must be clamped too, or the action is placed off-screen where it can
   * never be clicked (the doc comment promises "never leaves the viewport").
   */
  it('keeps the action reachable when the selection sits below the viewport', () => {
    for (const top of [800, 810, 850, 900, 5000]) {
      const placed = placeAction({ ...RECT, top, bottom: top + 20 }, viewport)
      expect([top, placed.top >= 4, placed.top + ACTION_HEIGHT <= viewport.height - 4]).toEqual([top, true, true])
    }
  })

  it('keeps the action reachable for a selection above the viewport too', () => {
    for (const top of [-400, -20, 0]) {
      const placed = placeAction({ ...RECT, top, bottom: top + 20 }, viewport)
      expect([top, placed.top >= 4, placed.top + ACTION_HEIGHT <= viewport.height - 4]).toEqual([top, true, true])
    }
  })

  it('centres on the selection and clamps to the horizontal margins', () => {
    expect(placeAction(RECT, viewport).centerX).toBe(140)
    const atLeft: SelectionRect = { ...RECT, left: 0, right: 10 }
    expect(placeAction(atLeft, viewport).centerX).toBe(ACTION_HALF_WIDTH + 4)
    const atRight: SelectionRect = { ...RECT, left: 995, right: 1000 }
    expect(placeAction(atRight, viewport).centerX).toBe(viewport.width - ACTION_HALF_WIDTH - 4)
  })
})

describe('createSelectionTracker', () => {
  it('is inert when the environment has no usable DOM', () => {
    const tracker = createSelectionTracker({ env: { win: {} as Window, doc: {} as Document } })
    expect(tracker.getSnapshot()).toBeNull()
    expect(() => tracker.refresh()).not.toThrow()
    expect(() => tracker.clear()).not.toThrow()
    expect(typeof tracker.subscribe(() => {})).toBe('function')
    expect(() => tracker.dispose()).not.toThrow()
  })

  it('publishes a selection and clears it when the selection goes away', () => {
    selectText('<div data-chat-flow><p id="p">hello</p></div>', '#p')
    const tracker = createSelectionTracker({ env, measure })
    expect(tracker.getSnapshot()?.text).toBe('hello')

    const listener = vi.fn()
    tracker.subscribe(listener)

    clearSelection()
    tracker.refresh()
    expect(tracker.getSnapshot()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1)

    tracker.dispose()
  })

  it('re-reads on selectionchange without any manual refresh', () => {
    document.body.innerHTML = '<div data-chat-flow><p id="p">hello</p></div>'
    const tracker = createSelectionTracker({ env, measure })
    expect(tracker.getSnapshot()).toBeNull()

    selectText('<div data-chat-flow><p id="p">hello</p></div>', '#p')
    document.dispatchEvent(new Event('selectionchange'))

    expect(tracker.getSnapshot()?.text).toBe('hello')
    tracker.dispose()
  })

  it('notifies only when the offer actually changed', () => {
    selectText('<div data-chat-flow><p id="p">hello</p></div>', '#p')
    const tracker = createSelectionTracker({ env, measure })
    const listener = vi.fn()
    tracker.subscribe(listener)

    tracker.refresh()
    tracker.refresh()
    expect(listener).not.toHaveBeenCalled()
    tracker.dispose()
  })

  it('stop-notifies after the subscription is released', () => {
    selectText('<div data-chat-flow><p id="p">hello</p></div>', '#p')
    const tracker = createSelectionTracker({ env, measure })
    const listener = vi.fn()
    tracker.subscribe(listener)()
    clearSelection()
    tracker.refresh()
    expect(listener).not.toHaveBeenCalled()
    tracker.dispose()
  })

  it('hides the dismissed offer but re-offers the same text after a real re-selection', () => {
    selectText('<div data-chat-flow><p id="p">hello</p></div>', '#p')
    const tracker = createSelectionTracker({ env, measure })
    tracker.clear()
    expect(tracker.getSnapshot()).toBeNull()

    // Same text, re-selected: a gesture that actually cleared the selection
    // first resets the suppression, so the user can save the same passage twice.
    clearSelection()
    document.dispatchEvent(new Event('selectionchange'))
    selectText('<div data-chat-flow><p id="p">hello</p></div>', '#p')
    document.dispatchEvent(new Event('selectionchange'))
    expect(tracker.getSnapshot()?.text).toBe('hello')
    tracker.dispose()
  })

  /**
   * Regression: the suppression used to be dropped on ANY `selectionchange`,
   * so a saved selection re-offered its button the moment the transcript
   * re-emitted the event (it does, while an answer streams) — and a second
   * click filed a duplicate note.
   */
  it('keeps the saved selection suppressed while the DOM keeps re-emitting selectionchange', () => {
    selectText('<div data-chat-flow><p id="p">hello</p></div>', '#p')
    const tracker = createSelectionTracker({ env, measure })
    expect(tracker.getSnapshot()?.text).toBe('hello')

    tracker.clear()
    expect(tracker.getSnapshot()).toBeNull()

    // The selection is still there (only the offer was dismissed).
    for (let i = 0; i < 3; i += 1) {
      document.dispatchEvent(new Event('selectionchange'))
      expect([i, tracker.getSnapshot()]).toEqual([i, null])
    }
    // A mouseup on the unchanged selection must not resurrect it either.
    document.dispatchEvent(new Event('mouseup'))
    expect(tracker.getSnapshot()).toBeNull()

    // Clearing the selection re-arms the offer for the same text.
    clearSelection()
    document.dispatchEvent(new Event('selectionchange'))
    selectText('<div data-chat-flow><p id="p">hello</p></div>', '#p')
    document.dispatchEvent(new Event('selectionchange'))
    expect(tracker.getSnapshot()?.text).toBe('hello')
    tracker.dispose()
  })

  it('does not re-query the scope while its element is still connected', () => {
    selectText('<div data-chat-flow><p id="p">hello</p></div>', '#p')
    const tracker = createSelectionTracker({ env, measure })
    // The constructor resolved the scope once; selectionchange fires
    // continuously while dragging, so the hot path must not query again.
    const spy = vi.spyOn(document, 'querySelector')
    tracker.refresh()
    tracker.refresh()
    expect(spy).not.toHaveBeenCalled()
    tracker.dispose()
  })

  it('re-resolves the scope once the shell mounts the transcript', () => {
    selectText('<div class="renamed"><p id="p">early</p></div>', '#p')
    const tracker = createSelectionTracker({ env, measure })
    // No known container yet: the offer is unscoped (the version-skew path).
    expect(tracker.getSnapshot()?.text).toBe('early')

    // The conversation mounts, with unrelated chrome beside it.
    document.body.innerHTML = '<div data-chat-flow><p id="p">in transcript</p></div><aside id="side">sidebar</aside>'
    const selection = window.getSelection()!
    const sideRange = document.createRange()
    sideRange.selectNodeContents(document.getElementById('side')!)
    selection.removeAllRanges()
    selection.addRange(sideRange)
    document.dispatchEvent(new Event('selectionchange'))

    // The scope is known now, so a selection outside it is refused…
    expect(tracker.getSnapshot()).toBeNull()

    // …while one inside the transcript is offered.
    const insideRange = document.createRange()
    insideRange.selectNodeContents(document.getElementById('p')!)
    selection.removeAllRanges()
    selection.addRange(insideRange)
    document.dispatchEvent(new Event('selectionchange'))
    expect(tracker.getSnapshot()?.text).toBe('in transcript')

    tracker.dispose()
  })

  it('unbinds every listener on dispose, once', () => {    selectText('<div data-chat-flow><p id="p">hello</p></div>', '#p')
    const tracker = createSelectionTracker({ env, measure })
    const removeDoc = vi.spyOn(document, 'removeEventListener')
    const removeWin = vi.spyOn(window, 'removeEventListener')

    tracker.dispose()

    const docEvents = removeDoc.mock.calls.map((call) => call[0]).sort()
    expect(docEvents).toEqual(['keyup', 'mouseup', 'scroll', 'selectionchange'])
    expect(removeWin.mock.calls.map((call) => call[0])).toEqual(['resize'])

    // A selection change after dispose must not resurrect the offer.
    tracker.dispose()
    selectText('<div data-chat-flow><p id="p">hello</p></div>', '#p')
    document.dispatchEvent(new Event('selectionchange'))
    expect(tracker.getSnapshot()).toBeNull()
  })
})
