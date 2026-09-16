/**
 * The plugin's frame-wide surfaces (v0.2.0), both mounted in `shell.overlay`:
 *
 * 1. the **floating "进记事本" action** that appears beside a text selection in
 *    the session. It is an entry of a click-through overlay layer, so only the
 *    button itself opts back into pointer events — the app underneath keeps
 *    every click that is not ours.
 * 2. the **toast surface** both capture features report through. It lives here
 *    rather than inside the sidebar panel because a capture can happen while
 *    the panel is closed (and in a tier whose panel may not even be mounted),
 *    and the user still has to see that the note was written.
 *
 * Purity: no `node:*`, no `@deepseek-ai/*` value imports — React only.
 */
import { createElement, useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { NotebookGlyph, uiTokens } from './icons'
import { t } from './locales'
import { apiErrorMessage } from './api'
import { placeAction, type SelectionTracker } from './selectionAction'
import type { NotebookCapture } from './capture'

export interface CaptureOverlayProps {
  /** The live selection tracker (owned by the activation, not by this component). */
  tracker: SelectionTracker
  /** The capture service both features write through. */
  capture: NotebookCapture
  /** `prefs.selectionToNotebook !== false`: hides the floating action when off. */
  enabled: boolean
}

/** Read the viewport box (jsdom always has one; a detached window reports 0). */
function viewportSize(): { width: number; height: number } {
  const width = typeof window === 'undefined' ? 0 : window.innerWidth || 0
  const height = typeof window === 'undefined' ? 0 : window.innerHeight || 0
  return { width: width > 0 ? width : 1024, height: height > 0 ? height : 768 }
}

/**
 * The floating selection action.
 *
 * A click must NOT blur the selection before it is read — `mousedown` therefore
 * prevents the default focus change, and the text is captured from the
 * tracker's snapshot (taken before the click) rather than re-read afterwards.
 */
function SelectionAction(props: { tracker: SelectionTracker; capture: NotebookCapture }): JSX.Element | null {
  const { tracker, capture } = props
  const candidate = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot, tracker.getSnapshot)
  const [saving, setSaving] = useState(false)

  const save = useCallback(() => {
    if (candidate === null || saving) return
    const text = candidate.text
    setSaving(true)
    // Hide the offer immediately: the selection is about to be the note, and a
    // button left floating over text that is already saved reads as "did it work?".
    tracker.clear()
    void Promise.resolve()
      .then(() => capture.save({ text, source: 'selection' }))
      .then((result) => {
        if (result === null) {
          capture.notify(t('selectionEmpty'), 'error')
          return
        }
        capture.notify(t('selectionSaved', { title: result.title }))
      })
      .catch((error: unknown) => {
        capture.notify(t('captureFailed', { message: apiErrorMessage(error) }), 'error')
      })
      .finally(() => {
        setSaving(false)
      })
  }, [candidate, capture, saving, tracker])

  if (!candidate) return null
  const viewport = viewportSize()
  const { top, centerX } = placeAction(candidate.rect, viewport)

  return createElement(
    'div',
    {
      'data-dsh-notebook': 'selection-action',
      style: { position: 'fixed', top, left: centerX, transform: 'translateX(-50%)', zIndex: 60 },
    },
    createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'notebook-selection-action',
        'aria-label': t('selectionHint'),
        title: t('selectionHint'),
        disabled: saving,
        // Keep the selection alive: without this the click would collapse it
        // before the browser fires it, and the text would already be gone.
        onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault(),
        onClick: save,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          height: 28,
          padding: '0 10px',
          border: `1px solid ${uiTokens.borderStrong}`,
          borderRadius: 999,
          background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
          color: uiTokens.text,
          boxShadow: 'var(--dsw-shadow-lv2, 0 4px 12px rgba(0, 0, 0, 0.25))',
          font: 'inherit',
          fontSize: 12,
          lineHeight: '16px',
          whiteSpace: 'nowrap',
          // `shell.overlay` (and this root) are click-through: the button is the
          // only node here that may take a click.
          pointerEvents: 'auto',
          cursor: saving ? 'default' : 'pointer',
          opacity: saving ? 0.7 : 1,
        },
      },
      createElement(NotebookGlyph, { size: 13 }),
      createElement('span', null, t('selectionAction')),
    ),
  )
}

/** The toast stack: one message per capture, auto-dismissed by the service. */
function CaptureToasts(props: { capture: NotebookCapture }): JSX.Element | null {
  const { capture } = props
  const toasts = useSyncExternalStore(capture.subscribeToasts, capture.toasts, capture.toasts)
  if (toasts.length === 0) return null
  return createElement(
    'div',
    {
      'data-dsh-notebook': 'toasts',
      style: {
        position: 'fixed',
        left: '50%',
        bottom: 24,
        transform: 'translateX(-50%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        zIndex: 61,
      },
    },
    toasts.map((toast) =>
      createElement(
        'div',
        {
          key: toast.id,
          'data-testid': 'notebook-capture-toast',
          role: 'status',
          onClick: () => capture.dismissToast(toast.id),
          style: {
            maxWidth: 'min(520px, 80vw)',
            padding: '5px 12px',
            borderRadius: 999,
            border: `1px solid ${toast.tone === 'error' ? uiTokens.danger : uiTokens.border}`,
            background: 'var(--dsw-alias-bg-layer-2, #ffffff)',
            color: toast.tone === 'error' ? uiTokens.danger : uiTokens.text,
            boxShadow: 'var(--dsw-shadow-lv2, 0 4px 12px rgba(0, 0, 0, 0.25))',
            fontSize: 12,
            lineHeight: '16px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            pointerEvents: 'auto',
          },
        },
        toast.message,
      ),
    ),
  )
}

/**
 * The complete overlay entry: the floating selection action plus the toast
 * stack. Rendered as ONE `shell.overlay` registration so the two surfaces can
 * never be mounted in different layers.
 */
export function CaptureOverlay(props: CaptureOverlayProps): JSX.Element {
  const { tracker, capture, enabled } = props
  // The tracker re-measures on resize, but an unchanged rect would publish an
  // equal snapshot; re-rendering here keeps the placement clamp correct when
  // only the viewport box changed.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onResize = (): void => setTick((value) => value + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return createElement(
    'div',
    { 'data-dsh-notebook': 'capture-overlay', style: { pointerEvents: 'none' } },
    enabled ? createElement(SelectionAction, { tracker, capture }) : null,
    createElement(CaptureToasts, { capture }),
  )
}
