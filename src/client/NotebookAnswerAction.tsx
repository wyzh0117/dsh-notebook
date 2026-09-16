/**
 * Answer-to-notebook (v0.2.0): the "save to notebook" entry in a finalized
 * assistant message's action row.
 *
 * The DSH slot is `conversation.chat.assistant-actions` — a **list** slot whose
 * entries receive `{ messageId }` plus the session standard kit. Two facts about
 * it shape this file:
 *
 * 1. **The answer text never crosses the slot boundary.** The entry only gets
 *    the durable message id (`dsh-client-ui-message-feedback` works the same
 *    way: it posts the id to the host rather than reading content). The text is
 *    therefore read here, from the session kit's snapshot hooks, via the
 *    duck-typed readers in `answerAction.ts`.
 * 2. **Position is limited.** The slot list renders inside the `extraActions`
 *    band of `MessageIconActions`, i.e. between the hardcoded Copy button and
 *    the hardcoded Branch button (`dsh-client-ui-chat`, DSH 0.1.5-rc.2). An
 *    `order` above the shipped feedback entry (10) puts us at the END of that
 *    band — the closest thing to "after the other actions" the slot can express.
 *
 * The hook-selection structure mirrors `hosts/native.ts`: the composition
 * decides ONCE, outside React, which snapshot reader exists, and each variant
 * component then has a stable hook order of its own (calling a hook
 * conditionally inside one component is what that split avoids).
 *
 * Purity: no `node:*`, no `@deepseek-ai/*` value imports — React only.
 */
import { createElement, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { NotebookGlyph, uiTokens } from './icons'
import { t } from './locales'
import { apiErrorMessage } from './api'
import { answerTextFromChat, answerTextFromTrajectory, answerTitle } from './answerAction'
import type { NotebookCapture } from './capture'
import type { NotebookPrefs } from '../shared/types'

/** The slot key this module owns (declared by `dsh-client-ui-chat`). */
export const ASSISTANT_ACTIONS_SLOT = 'conversation.chat.assistant-actions'

/** Our entry id: fresh, so we are ADDED beside the shipped entries. */
export const ANSWER_ACTION_ID = 'dsh-notebook-save'

/** Order: above the shipped feedback pair (10), i.e. last in the band. */
export const ANSWER_ACTION_ORDER = 20

/** How long the button keeps its "saved" state before returning to idle. */
export const SAVED_BADGE_MS = 2000

/**
 * The session standard kit members this component reads. All optional: a
 * composition that lacks one simply takes the next reader (or hides the action).
 */
export interface AnswerActionSlotProps {
  messageId?: unknown
  /** `useChat(selector)` — the primary answer reader. */
  useChat?: ((selector: (snapshot: unknown) => unknown) => unknown) | undefined
  /** `useTrajectory(selector)` — the fallback answer reader. */
  useTrajectory?: ((selector: (snapshot: unknown) => unknown) => unknown) | undefined
  /** `useProjection('title')` — the session title. */
  useProjection?: ((key: string) => unknown) | undefined
}

/** What the registration hands the component (its `inject` face). */
export interface AnswerActionInjected {
  capture: NotebookCapture
  /** The activation runtime: prefs are read live through it, never snapshotted. */
  getPrefs(): NotebookPrefs
  subscribe(listener: () => void): () => void
}

/** Props as the slot delivers them: the owner share + kit + our inject face. */
export type AnswerActionProps = AnswerActionSlotProps & AnswerActionInjected

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function'
}

/** Message id of the row (the slot's only owner prop). */
function readMessageId(props: AnswerActionSlotProps): string {
  return typeof props.messageId === 'string' ? props.messageId : ''
}

/**
 * The action button.
 *
 * Idle → saving → saved/error, with the error surfaced through the shared toast
 * surface as well as the button's own title, so a click is never silent even
 * when the overlay layer is not mounted.
 */
function AnswerActionButton(props: {
  text: string | null
  title: string
  capture: NotebookCapture
}): JSX.Element {
  const { text, title, capture } = props
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [savedTitle, setSavedTitle] = useState('')
  const badgeTimer = useRef<number | null>(null)

  // A row can unmount between the save and its badge timer (a session switch
  // rebuilds the transcript): the timer must not outlive the component.
  useEffect(
    () => () => {
      if (badgeTimer.current !== null) window.clearTimeout(badgeTimer.current)
    },
    [],
  )

  const save = useCallback(() => {
    if (state === 'saving') return
    if (text === null || text.length === 0) {
      capture.notify(t('answerEmpty'), 'error')
      return
    }
    setState('saving')
    void Promise.resolve()
      .then(() => capture.save({ text, title, source: 'answer' }))
      .then((result) => {
        if (result === null) {
          capture.notify(t('answerEmpty'), 'error')
          setState('idle')
          return
        }
        capture.notify(t('answerSaved', { title: result.title }))
        setSavedTitle(result.title)
        setState('saved')
        badgeTimer.current = window.setTimeout(() => {
          badgeTimer.current = null
          setState('idle')
        }, SAVED_BADGE_MS)
      })
      .catch((error: unknown) => {
        capture.notify(t('captureFailed', { message: apiErrorMessage(error) }), 'error')
        setState('idle')
      })
  }, [capture, state, text, title])

  const label = state === 'saved' ? t('answerSaved', { title: savedTitle }) : t('answerAction')

  return createElement(
    'button',
    {
      type: 'button',
      'data-testid': 'notebook-answer-action',
      'data-state': state,
      'aria-label': label,
      title: state === 'saved' ? label : t('answerHint'),
      disabled: state === 'saving',
      onClick: save,
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        padding: 0,
        border: 'none',
        borderRadius: '50%',
        background: 'transparent',
        // The saved state is the only decoration: the row's other actions are
        // icon-only too, so the notebook glyph must not stand out until it has
        // something to say.
        color: state === 'saved' ? uiTokens.accent : uiTokens.textSecondary,
        cursor: state === 'saving' ? 'default' : 'pointer',
        opacity: state === 'saving' ? 0.6 : 1,
      },
    },
    createElement(NotebookGlyph, { size: 15 }),
  )
}

/**
 * Build the two reader variants plus the dispatcher.
 *
 * @param injected - the registration's business face (capture + live prefs).
 */
export function createAnswerActionComponent(injected: AnswerActionInjected): (props: unknown) => unknown {
  /**
   * Shared body: reads the prefs live, saves through the shared capture.
   *
   * Every hook runs BEFORE any early return. `useProjection` is a real shell
   * hook (not a plain function), so skipping it on the disabled render would
   * make the next enabled render call more hooks than the previous one — React
   * refuses that, and the user turning the feature back on is exactly the case
   * that would hit it.
   *
   * `text === undefined` means the snapshot was not a shape this reader
   * understands (a version skew), which is NOT the same as "this answer has no
   * prose" (`null`): the first hides the action, while the second keeps an
   * honest “nothing to save” button instead of a permanently dead affordance on
   * every row.
   */
  function body(props: AnswerActionProps, text: string | null | undefined): JSX.Element | null {
    const prefs = useSyncExternalStore(props.subscribe, props.getPrefs, props.getPrefs)
    const title = typeof props.useProjection === 'function' ? answerTitle(props.useProjection('title')) : ''
    if (text === undefined) return null
    if (prefs.messageToNotebook === false) return null
    return createElement(AnswerActionButton, { text, title, capture: props.capture })
  }

  /** Primary reader: the chat snapshot (the view the row belongs to). */
  function WithChat(props: AnswerActionProps): JSX.Element | null {
    const messageId = readMessageId(props)
    // A stable selector per message: the shell binds it through a store
    // subscription, and a fresh closure every render would unsubscribe and
    // resubscribe on every streaming frame.
    const select = useCallback((snapshot: unknown) => answerTextFromChat(snapshot, messageId), [messageId])
    const text = props.useChat?.(select) as string | null | undefined
    return body(props, text)
  }

  /** Fallback reader: the trajectory snapshot. */
  function WithTrajectory(props: AnswerActionProps): JSX.Element | null {
    const messageId = readMessageId(props)
    const select = useCallback((snapshot: unknown) => answerTextFromTrajectory(snapshot, messageId), [messageId])
    const text = props.useTrajectory?.(select) as string | null | undefined
    return body(props, text)
  }

  return function NotebookAnswerAction(props: unknown): unknown {
    const raw = props as AnswerActionProps
    // A row with no usable message id cannot be matched against anything: the
    // reader has no key, and an interrupted answer carries no id at all, so a
    // loose comparison would file an unrelated reply. Nothing here is a hook,
    // so the guard is order-safe.
    if (readMessageId(raw).trim().length === 0) return null
    // Composition-determined, so this branch is stable for the component's
    // whole life: the reader that exists is the reader that is used.
    if (isFunction(raw.useChat)) return createElement(WithChat, { ...raw, ...injected })
    if (isFunction(raw.useTrajectory)) return createElement(WithTrajectory, { ...raw, ...injected })
    // No snapshot reader in this composition: there is no way to read the
    // answer, so the action must not be offered at all.
    return null
  }
}
