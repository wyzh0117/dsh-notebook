/**
 * The two slot registrations of the capture features (v0.2.0), in one place
 * because they share a lifetime and a failure policy.
 *
 * Both are TIER-INDEPENDENT: unlike the sidebar (which is a three-tier probe),
 * these surfaces belong to the shell, so they are registered once per activation
 * no matter which carrier won — exactly like the `@` reference source.
 *
 * Failure policy, mirroring `reference.ts`: a slot nobody declared is a silent
 * no-op (`slots.inject` simply never fires), and a registration that throws is
 * logged and dropped. Neither may take the notebook's other affordances down.
 *
 * Purity: no `node:*`, no `@deepseek-ai/*` value imports — React only.
 */
import { createElement, useSyncExternalStore } from 'react'
import { CaptureOverlay } from './CaptureOverlay'
import {
  ANSWER_ACTION_ID,
  ANSWER_ACTION_ORDER,
  ASSISTANT_ACTIONS_SLOT,
  createAnswerActionComponent,
  type AnswerActionInjected,
} from './NotebookAnswerAction'
import { disposeOf } from './hosts/detect'
import { captureEnabled, type NotebookCapture } from './capture'
import type { SelectionTracker } from './selectionAction'
import type { ClientContext, NotebookRuntime } from './hosts/types'
import type { NotebookPrefs } from '../shared/types'

/** The frame-wide overlay layer this plugin's floating surfaces live in. */
export const OVERLAY_SLOT = 'shell.overlay'

/** Our overlay entry id: a fresh id, so we are ADDED beside the shipped entries. */
export const OVERLAY_ID = 'dsh-notebook-capture'

/** Order within `shell.overlay` (above the tier-3 shell entry, which sits at 5). */
export const OVERLAY_ORDER = 20

/** Everything both registrations need. */
export interface CaptureSlotOptions {
  capture: NotebookCapture
  tracker: SelectionTracker
  /** The activation runtime: prefs are read live, never snapshotted. */
  runtime: NotebookRuntime
}

/** The live prefs read both surfaces gate on. */
function prefsSource(runtime: NotebookRuntime): Pick<AnswerActionInjected, 'getPrefs' | 'subscribe'> {
  return {
    getPrefs: (): NotebookPrefs => runtime.getPrefs(),
    subscribe: (listener: () => void): (() => void) => runtime.subscribe(listener),
  }
}

/**
 * The overlay entry component.
 *
 * The selection gate is read through a LIVE subscription rather than a
 * registration-time boolean: turning the feature off in settings must take
 * effect on the next render, not on the next plugin reload.
 */
function createOverlayComponent(options: CaptureSlotOptions): () => unknown {
  const { capture, tracker } = options
  const { getPrefs, subscribe } = prefsSource(options.runtime)
  return function NotebookCaptureOverlay(): unknown {
    const prefs = useSyncExternalStore(subscribe, getPrefs, getPrefs)
    return createElement(CaptureOverlay, {
      tracker,
      capture,
      enabled: captureEnabled(prefs, 'selection'),
    })
  }
}

/**
 * Register the floating selection action + the shared toast surface.
 *
 * One registration for both surfaces, so they can never land in different
 * layers.
 */
function registerOverlay(ctx: ClientContext, options: CaptureSlotOptions): () => void {
  return disposeOf(
    ctx.slots.inject(OVERLAY_SLOT, () =>
      ctx.slots.register(
        { name: OVERLAY_SLOT, id: OVERLAY_ID, order: OVERLAY_ORDER },
        createOverlayComponent(options),
      ),
    ),
  )
}

/**
 * Register the "save to notebook" action under every finalized answer.
 *
 * The pref gate lives INSIDE the component (it reads the live prefs), so
 * flipping the setting never has to re-register the slot entry.
 */
function registerAnswerAction(ctx: ClientContext, options: CaptureSlotOptions): () => void {
  const { capture } = options
  // The component is built once per registration and closes over its business
  // face; the same face is also published through `inject`, so the entry shows
  // up in the slot ledger with the capabilities it actually uses.
  const injected: AnswerActionInjected = { capture, ...prefsSource(options.runtime) }
  const component = createAnswerActionComponent(injected)
  return disposeOf(
    ctx.slots.inject(ASSISTANT_ACTIONS_SLOT, () =>
      ctx.slots.register(
        {
          name: ASSISTANT_ACTIONS_SLOT,
          id: ANSWER_ACTION_ID,
          order: ANSWER_ACTION_ORDER,
          inject: () => ({ ...injected }),
        },
        component,
      ),
    ),
  )
}

/**
 * Register both capture surfaces.
 *
 * @returns the disposer (a safe no-op wherever the slots are not declared).
 */
export function registerCaptureSlots(ctx: ClientContext, options: CaptureSlotOptions): () => void {
  const disposers: Array<() => void> = []
  const attempt = (label: string, register: () => () => void): void => {
    try {
      disposers.push(register())
    } catch (error) {
      console.warn(`[dsh-notebook] ${label} registration failed:`, error)
    }
  }

  attempt('selection overlay', () => registerOverlay(ctx, options))
  attempt('answer action', () => registerAnswerAction(ctx, options))

  let released = false
  return () => {
    if (released) return
    released = true
    for (const off of disposers.reverse()) {
      try {
        off()
      } catch (error) {
        console.warn('[dsh-notebook] capture slot dispose failed:', error)
      }
    }
  }
}
