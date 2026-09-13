// @vitest-environment jsdom
/**
 * Scratch-only behavioural test of the tier-3 shell (kept outside the repo:
 * `test/tier-detect.test.ts` is the committed file owned by this brief).
 * Run: cp to <repo>/test/ and `vitest run`.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'

// The shell is what this file tests, not the page: stub the page so the
// assertions read the `visible` flag the shell hands down, without dragging in
// the list/store/API machinery (which `test/editor.test.tsx` already covers).
vi.mock('../src/client/NotebookView', () => ({
  NotebookView: (props: { visible?: boolean }) =>
    createElement('div', {
      'data-testid': 'stub-notebook-view',
      'data-visible': String(props.visible ?? false),
    }),
}))
import { createStandaloneHost, PANEL_DEFAULT, PANEL_MAX, clampPanelWidth } from '../src/client/hosts/standalone'
import { DEFAULT_PREFS } from '../src/shared/types'
import type { ClientContext, NotebookRuntime } from '../src/client/hosts/types'

afterEach(() => { cleanup(); document.head.innerHTML = ''; document.body.innerHTML = ''; localStorage.clear() })

function collect() {
  const registered: Array<{ name: string; id: string; component: any }> = []
  const ctx = {
    slots: {
      register: (o: any, c: any) => { registered.push({ name: o.name, id: o.id, component: c }); return () => {} },
      inject: (_k: string, cb: () => () => void) => { cb(); return () => {} },
    },
    locale: { register: () => () => {}, get: () => 'zh' },
    effect: (cb: () => any) => { const off = cb(); return () => off?.() },
    get: () => undefined,
    inject: () => ({ dispose() {} }),
  } as unknown as ClientContext
  const stablePrefs = { ...DEFAULT_PREFS }
  const runtime: NotebookRuntime = {
    api: { getState: async () => ({ doc: { version: 1, notes: [], prefs: stablePrefs }, degraded: false }) } as any,
    getPrefs: () => stablePrefs,
    setPrefs: () => {},
    subscribe: () => () => {},
  }
  return { ctx, runtime, registered }
}

it('tier 3 shell mounts, toggles, drags, persists and cleans up', () => {
  const { ctx, runtime, registered } = collect()
  const host = createStandaloneHost(ctx)
  const dispose = host.register(runtime)

  expect(document.head.querySelector('style[data-dsh-notebook-layout]')).not.toBeNull()
  // before the shell mounts the variable is unset, so the CSS fallback (`0px`) applies
  expect(document.documentElement.style.getPropertyValue('--dsh-notebook-width')).toBe('')

  const shell = registered.find(r => r.name === 'shell.overlay')
  expect(shell).toBeTruthy()
  expect(registered.some(r => r.name === 'settings.section' && r.id === 'dsh-notebook')).toBe(true)
  render(createElement(shell!.component))

  const toggle = screen.getByLabelText('展开记事本')
  const panel = document.querySelector('[data-dsh-notebook="panel"]') as HTMLElement
  expect(panel).toBeTruthy()
  expect(document.documentElement.style.getPropertyValue('--dsh-notebook-width')).toBe('0px')
  expect(document.body.hasAttribute('data-dsh-notebook-collapsed')).toBe(true)
  expect(panel.getAttribute('aria-hidden')).toBe('true')
  expect(panel.style.transform).toBe('translateX(102%)')
  expect(panel.style.visibility).toBe('hidden')
  expect(panel.style.width).toBe(`${PANEL_DEFAULT}px`)
  expect(screen.getByTestId('stub-notebook-view').getAttribute('data-visible')).toBe('false')

  // host.reveal() is the user-activation path (tier 2/3). It fires outside a
  // React event, so the store update needs an explicit act() flush.
  act(() => { host.reveal() })
  expect(panel.getAttribute('aria-hidden')).toBeNull()
  expect(panel.style.transform).toBe('translateX(0)')
  expect(panel.style.visibility).toBe('visible')
  expect(document.body.hasAttribute('data-dsh-notebook-collapsed')).toBe(false)
  expect(document.documentElement.style.getPropertyValue('--dsh-notebook-width')).toBe('400px')
  expect(localStorage.getItem('dsh-notebook:open')).toBe('1')
  expect(screen.getByTestId('stub-notebook-view').getAttribute('data-visible')).toBe('true')

  // collapse from the corner cluster, then expand again by click
  fireEvent.click(toggle)
  expect(panel.getAttribute('aria-hidden')).toBe('true')
  expect(localStorage.getItem('dsh-notebook:open')).toBe('0')
  fireEvent.click(toggle)
  expect(panel.getAttribute('aria-hidden')).toBeNull()

  expect(document.querySelector('[data-dsh-notebook="header"]')!.textContent).toContain('Notebook')

  const strip = document.querySelector('[data-dsh-notebook="resize"]') as HTMLElement
  expect(strip).toBeTruthy()
  fireEvent.pointerDown(strip, { clientX: 600, pointerId: 1 })
  fireEvent.pointerMove(strip, { clientX: 500, pointerId: 1 })
  expect(panel.style.width).toBe('500px')
  expect(document.documentElement.style.getPropertyValue('--dsh-notebook-width')).toBe('500px')
  fireEvent.pointerUp(strip, { clientX: 500, pointerId: 1 })
  expect(localStorage.getItem('dsh-notebook:width')).toBe('500')

  fireEvent.pointerDown(strip, { clientX: 0, pointerId: 2 })
  fireEvent.pointerMove(strip, { clientX: -5000, pointerId: 2 })
  expect(panel.style.width).toBe(`${clampPanelWidth(PANEL_MAX)}px`)
  fireEvent.pointerUp(strip, { clientX: -5000, pointerId: 2 })

  const widthSpy = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(500)
  fireEvent(window, new Event('resize'))
  expect(panel.style.width).toBe('100vw')
  expect(document.querySelector('[data-dsh-notebook="resize"]')).toBeNull()
  expect(document.documentElement.style.getPropertyValue('--dsh-notebook-width')).toBe('0px')
  widthSpy.mockRestore()
  fireEvent(window, new Event('resize'))

  expect(screen.getAllByLabelText('收起记事本')).toHaveLength(2)
  fireEvent.click(document.querySelector('[data-dsh-notebook="header"] button') as HTMLElement)
  expect(panel.getAttribute('aria-hidden')).toBe('true')

  dispose()
  expect(document.head.querySelector('style[data-dsh-notebook-layout]')).toBeNull()
  expect(document.body.hasAttribute('data-dsh-notebook-collapsed')).toBe(false)
  expect(document.documentElement.style.getPropertyValue('--dsh-notebook-width')).toBe('0px')
})
