/**
 * v0.2.1 body auto-grow, the arithmetic half (node project, no DOM).
 *
 * {@link applyBodyHeight} is the one place the numbers live, so this file pins
 * the two rules the whole feature rests on:
 *
 * 1. measurement happens against `height: auto` — otherwise a textarea can never
 *    report less than its own client height and would grow forever;
 * 2. the result never leaves `[BODY_MIN_HEIGHT, cap]`, with the cap reported as
 *    `maxHeight` and internal scrolling switched on exactly when content
 *    overflows it.
 *
 * The real `<textarea>` behaviour (typing, pasting, re-wrapping) is covered in
 * `test/editor-autogrow.test.tsx`.
 */
import { describe, expect, it } from 'vitest'
import {
  BODY_MAX_FALLBACK,
  BODY_MAX_VIEWPORT_RATIO,
  BODY_MIN_HEIGHT,
  applyBodyHeight,
  bodyMaxHeight,
  viewportHeight,
} from '../src/client/autoGrow'
import type { GrowTarget } from '../src/client/autoGrow'

interface FakeTarget extends GrowTarget {
  /** Every `style.height` write, in order, so the `auto` reset is observable. */
  heights: string[]
  /** Mutable content height: lets a test shrink the content again. */
  scrollHeight: number
}

function makeTarget(
  scrollHeight: number,
  metrics: { offsetHeight?: number; clientHeight?: number } = {},
): FakeTarget {
  const heights: string[] = []
  let height = ''
  const target = {
    style: {
      get height() {
        return height
      },
      set height(value: string) {
        height = value
        heights.push(value)
      },
      maxHeight: '',
      overflowY: '',
    },
    scrollHeight,
    offsetHeight: metrics.offsetHeight ?? 0,
    clientHeight: metrics.clientHeight ?? 0,
    heights,
  }
  return target
}

describe('bodyMaxHeight', () => {
  it('scales with the viewport and falls back when there is nothing to measure', () => {
    expect(bodyMaxHeight(1000)).toBe(Math.round(1000 * BODY_MAX_VIEWPORT_RATIO))
    expect(bodyMaxHeight(768)).toBe(461)
    expect(bodyMaxHeight(0)).toBe(BODY_MAX_FALLBACK)
    expect(bodyMaxHeight(Number.NaN)).toBe(BODY_MAX_FALLBACK)
    expect(bodyMaxHeight(-40)).toBe(BODY_MAX_FALLBACK)
    // Never below the floor, however small the viewport claims to be.
    expect(bodyMaxHeight(120)).toBe(BODY_MIN_HEIGHT)
  })

  it('reports 0 for the viewport in a runtime without a window', () => {
    expect(viewportHeight()).toBe(0)
    expect(bodyMaxHeight(viewportHeight())).toBe(BODY_MAX_FALLBACK)
  })
})

describe('applyBodyHeight', () => {
  it('does nothing — without throwing — when there is no element', () => {
    expect(applyBodyHeight(null)).toBeNull()
    expect(applyBodyHeight(undefined)).toBeNull()
    expect(applyBodyHeight({} as GrowTarget)).toBeNull()
  })

  it('measures against height:auto and then pins the content height', () => {
    const target = makeTarget(152)
    expect(applyBodyHeight(target, 400)).toBe(152)
    // Rule 1: the reset comes first, so `scrollHeight` cannot report the
    // previously applied (larger) height.
    expect(target.heights).toEqual(['auto', '152px'])
    expect(target.style.maxHeight).toBe('400px')
    expect(target.style.overflowY).toBe('hidden')
  })

  it('shrinks back when the content shrinks', () => {
    const target = makeTarget(412)
    expect(applyBodyHeight(target, 600)).toBe(412)
    target.scrollHeight = 60
    expect(applyBodyHeight(target, 600)).toBe(BODY_MIN_HEIGHT)
    expect(target.heights).toEqual(['auto', '412px', 'auto', '120px'])
  })

  it('never collapses below the floor, even when measurement fails', () => {
    for (const scrollHeight of [0, Number.NaN, -10]) {
      const target = makeTarget(scrollHeight)
      expect(applyBodyHeight(target, 400)).toBe(BODY_MIN_HEIGHT)
      expect(target.style.height).toBe(`${BODY_MIN_HEIGHT}px`)
      expect(target.style.overflowY).toBe('hidden')
    }
  })

  it('stops at the cap and scrolls internally instead of growing further', () => {
    const target = makeTarget(900)
    expect(applyBodyHeight(target, 240)).toBe(240)
    expect(target.style.height).toBe('240px')
    expect(target.style.maxHeight).toBe('240px')
    expect(target.style.overflowY).toBe('auto')
  })

  it('treats content exactly at the cap as fitting (no scrollbar)', () => {
    const target = makeTarget(240)
    expect(applyBodyHeight(target, 240)).toBe(240)
    expect(target.style.overflowY).toBe('hidden')
  })

  it('adds the vertical border, which scrollHeight does not include', () => {
    const target = makeTarget(152, { offsetHeight: 154, clientHeight: 152 })
    expect(applyBodyHeight(target, 400)).toBe(154)
    // Nonsense metrics (jsdom reports 0) must not shift the result.
    expect(applyBodyHeight(makeTarget(152, { offsetHeight: 0, clientHeight: 0 }), 400)).toBe(152)
    expect(applyBodyHeight(makeTarget(152, { offsetHeight: 100, clientHeight: 152 }), 400)).toBe(152)
  })

  it('is idempotent, which is what lets the ResizeObserver re-sync without looping', () => {
    const target = makeTarget(200)
    const first = applyBodyHeight(target, 400)
    const second = applyBodyHeight(target, 400)
    expect(first).toBe(200)
    expect(second).toBe(200)
    expect(target.style).toMatchObject({ height: '200px', maxHeight: '400px', overflowY: 'hidden' })
  })

  it('keeps the floor as the ceiling when a caller asks for less than the floor', () => {
    const target = makeTarget(900)
    expect(applyBodyHeight(target, 10)).toBe(BODY_MIN_HEIGHT)
    expect(target.style.maxHeight).toBe(`${BODY_MIN_HEIGHT}px`)
    expect(target.style.overflowY).toBe('auto')
  })

  it('falls back to the fixed cap when the caller passes no usable max', () => {
    const target = makeTarget(600)
    expect(applyBodyHeight(target, Number.NaN)).toBe(BODY_MAX_FALLBACK)
    expect(target.style.maxHeight).toBe(`${BODY_MAX_FALLBACK}px`)
    expect(target.style.overflowY).toBe('auto')
    // In the node project there is no window, so the default is the fallback too.
    const defaulted = makeTarget(600)
    expect(applyBodyHeight(defaulted)).toBe(BODY_MAX_FALLBACK)
    expect(defaulted.style.maxHeight).toBe(`${BODY_MAX_FALLBACK}px`)
  })
})
