// @vitest-environment jsdom
/**
 * The native tab body's visibility contract.
 *
 * A hidden tab must not talk to the host: `NotebookView` skips loading and
 * polling while `visible === false`. On DSH 0.1.5-rc.2 the seat renders a tab
 * with an EMPTY owner share (`renderSlot(seat, {}, …)`), so visibility arrives
 * only through the slot's injected `useTabInfo` hook — the plain `props.tab`
 * shape an earlier version could rely on never appears. This suite pins both
 * branches, so a regression to "always visible" (invisible background polling)
 * fails here instead of in the browser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'
import { createNativeHost } from '../src/client/hosts/native'
import { DEFAULT_PREFS } from '../src/shared/types'
import type { ClientContext, NotebookRuntime } from '../src/client/hosts/types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** The tab body as React sees it (the registration hands back a plain function). */
type TabBodyComponent = ComponentType<{
  useTabInfo?: () => { tab?: { visible?: unknown } } | undefined
  visible?: unknown
}>

interface Captured {
  options: { name: string; key?: string; id?: string }
  component: (props: unknown) => unknown
}

/** A context whose slot registrations are captured instead of dispatched. */
function collectNativeBody() {
  const captured: Captured[] = []
  const ctx = {
    slots: {
      register: (options: Captured['options'], component: Captured['component']) => {
        captured.push({ options, component })
        return () => {}
      },
      inject: (_key: string, callback: () => () => void) => {
        const off = callback()
        return () => {
          if (typeof off === 'function') off()
        }
      },
    },
    locale: { register: () => () => {}, get: () => 'zh' },
    effect: (callback: () => (() => void) | void) => {
      const off = callback()
      return () => {
        if (typeof off === 'function') off()
      }
    },
    get: () => undefined,
    inject: () => ({ dispose: () => {} }),
  } as unknown as ClientContext

  const getState = vi.fn(async () => ({
    doc: { version: 1 as const, notes: [], prefs: { ...DEFAULT_PREFS } },
    degraded: false,
  }))
  const stablePrefs = { ...DEFAULT_PREFS }
  const runtime: NotebookRuntime = {
    api: { getState, attachmentUrl: (id: string, rel: string) => `/x/${id}/${rel}` } as never,
    composer: {
      available: () => false,
      sessionId: () => null,
      attachImages: async () => ({ ok: false, inserted: 0, skipped: 0, failed: 0, reason: 'no-target' }),
      appendText: () => false,
      reference: () => false,
    },
    getPrefs: () => stablePrefs,
    setPrefs: () => {},
    subscribe: () => () => {},
  }

  const host = createNativeHost(ctx, {
    tabs: { register: () => () => {} },
    right: { openTab: () => {} },
  })
  host.register(runtime)

  const body = captured.find((entry) => entry.options.name === 'sidebar.right.pane.tab')
  if (body === undefined) throw new Error('the native tab body was never registered')
  return { body: body.component, getState }
}

describe('native tab body visibility', () => {
  it('reads visibility from the injected useTabInfo hook and stays quiet while hidden', async () => {
    const { body, getState } = collectNativeBody()
    const TabBody = body as unknown as TabBodyComponent

    const view = render(
      <TabBody useTabInfo={() => ({ tab: { visible: false } })} />,
    )

    // No fetch at all while hidden (the panel keeps rendering its placeholder,
    // which nobody sees because the tab is not on screen).
    expect(getState).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-testid="notebook-view"]')).not.toBeNull()
    expect(view.container.querySelector('[data-testid="notebook-list"]')).toBeNull()
  })

  it('loads once the hook reports the tab visible', async () => {
    const { body, getState } = collectNativeBody()
    const TabBody = body as unknown as TabBodyComponent

    render(<TabBody useTabInfo={() => ({ tab: { visible: true } })} />)

    await waitFor(() => expect(getState).toHaveBeenCalledTimes(1))
  })

  it('still honours the plain-props shape of older hosts', async () => {
    const { body, getState } = collectNativeBody()
    const TabBody = body as unknown as TabBodyComponent

    render(<TabBody visible={false} />)
    expect(getState).not.toHaveBeenCalled()

    cleanup()
    render(<TabBody visible />)
    await waitFor(() => expect(getState).toHaveBeenCalledTimes(1))
  })
})
