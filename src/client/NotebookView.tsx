/**
 * The Notebook page: header (`＋`), note list, empty state, toasts — the one
 * component all three sidebar tiers render (spec §4.1, §4.3, §4.4).
 *
 * G8 lives here: the list owns the only editor state
 * (`closed | create | edit`) and renders at most ONE `<NotebookEditor>`, as an
 * overlay inside the panel. Editing never opens a second container, a second
 * layer, or a new tab.
 *
 * The delete prompt (v0.2.2) is the panel's second overlay and obeys the same
 * rule: `confirmDelete` raises an in-view dialog — never `window.confirm`,
 * whose renderer-blocking modal can freeze the whole page in an embedded host.
 *
 * While `visible === false` the component neither loads nor polls — the sidebar
 * tiers keep it mounted and hidden, and a hidden panel must not hit the host.
 *
 * Purity: no `node:*`, no `@deepseek-ai/*` value imports.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { NotebookNote, NotebookPrefs } from '../shared/types'
import type { NotebookApiClient } from './api'
import { apiErrorMessage } from './api'
import { NotebookEditor } from './NotebookEditor'
import type { NotebookEditorMode } from './NotebookEditor'
import { CloseIcon, EditIcon, NotebookGlyph, PlusIcon, QuoteIcon, TrashIcon, uiSizes, uiTokens } from './icons'
import { buildBodyText, buildClipboardText, copyText } from './clipboard'
import type { NotebookComposer } from './composer'
import { t } from './locales'

export interface NotebookViewProps {
  api: NotebookApiClient
  prefs: NotebookPrefs
  onPrefsChange(patch: Partial<NotebookPrefs>): void
  visible: boolean
  onRequestClose?: () => void
  /**
   * The composer bridge (attach images / write the body into the draft / insert
   * an `@` reference). Optional: a composition without the DSH conversation
   * simply keeps the clipboard behaviour and hides the reference action.
   */
  composer?: NotebookComposer | null
}

type EditorState = { kind: 'closed' } | { kind: 'create' } | { kind: 'edit'; noteId: string }

/** How often the list re-reads the host while the panel is open and idle. */
const POLL_INTERVAL_MS = 15000
/** How long a toast stays on screen (spec §4.1: ~2s). */
const TOAST_MS = 2000

function sortNotes(notes: NotebookNote[], order: NotebookPrefs['sortOrder']): NotebookNote[] {
  const sorted = [...notes]
  if (order === 'title') {
    sorted.sort((a, b) => String(a.title ?? '').localeCompare(String(b.title ?? '')))
  } else if (order === 'created') {
    sorted.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  } else {
    sorted.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }
  return sorted
}

function formatTime(timestamp: number): string {
  const value = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.now()
  const delta = Date.now() - value
  if (delta < 60_000) return t('timeJustNow')
  if (delta < 3_600_000) return t('timeMinutesAgo', { n: Math.floor(delta / 60_000) })
  if (delta < 86_400_000) return t('timeHoursAgo', { n: Math.floor(delta / 3_600_000) })
  if (delta < 172_800_000) return t('timeYesterday')
  if (delta < 604_800_000) return t('timeDaysAgo', { n: Math.floor(delta / 86_400_000) })
  try {
    return new Date(value).toLocaleDateString()
  } catch {
    return new Date(value).toISOString().slice(0, 10)
  }
}

/** The user-facing name of a note: its title, or the untitled placeholder. */
function displayTitle(note: NotebookNote): string {
  return note.title && note.title.length > 0 ? note.title : t('untitled')
}

export function NotebookView(props: NotebookViewProps): JSX.Element {
  const { api, prefs, onRequestClose, composer } = props
  /** `visible === false` means hidden: the tiers keep this mounted but unseen. */
  const shown = props.visible !== false

  const [notes, setNotes] = useState<NotebookNote[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [degraded, setDegraded] = useState(false)
  const [editorState, setEditorState] = useState<EditorState>({ kind: 'closed' })
  const [toast, setToast] = useState<string | null>(null)
  const [workingId, setWorkingId] = useState<string | null>(null)
  /**
   * The note whose deletion is waiting for the user's answer.
   *
   * `confirmDelete` is answered by the panel's OWN dialog, never by
   * `window.confirm`: a native modal blocks the renderer thread, and in the
   * embedded/composition hosts DSH runs in (webviews, sandboxed frames) the
   * dialog can be swallowed while the block stays — the page simply freezes on
   * a Delete click. An in-view dialog cannot block anything, is testable, and
   * matches the editor overlay the same panel already draws.
   */
  const [confirming, setConfirming] = useState<NotebookNote | null>(null)

  const alive = useRef(true)
  const toastTimer = useRef<number | null>(null)
  /**
   * The note id currently being deleted, so a double click on the dialog's
   * confirm button (two click events before React re-renders) cannot fire two
   * DELETE requests — the second would 404 and paint an error banner over a
   * deletion that actually succeeded.
   */
  const deleting = useRef<string | null>(null)

  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    },
    [],
  )

  const load = useCallback(async () => {
    if (!alive.current) return
    setLoading(true)
    try {
      const state = await api.getState()
      if (!alive.current) return
      setNotes(Array.isArray(state.doc?.notes) ? state.doc.notes : [])
      setDegraded(state.degraded === true)
      setError(null)
      setLoaded(true)
    } catch (caught) {
      if (!alive.current) return
      setError(t('errLoad', { message: apiErrorMessage(caught) }))
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [api])

  // No fetch at all while hidden (`visible === false`); re-read on every reveal.
  useEffect(() => {
    if (!shown) return
    void load()
  }, [shown, load])

  // Poll only while the panel is open AND no EDITOR is capturing the screen; a
  // pending delete confirmation keeps polling on purpose, so a note deleted in
  // another browser takes its own question away (see the effect below).
  useEffect(() => {
    if (!shown || editorState.kind !== 'closed') return
    const timer = window.setInterval(() => {
      void load()
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [shown, editorState.kind, load])

  const showToast = useCallback((message: string) => {
    setToast(message)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => {
      toastTimer.current = null
      setToast(null)
    }, TOAST_MS)
  }, [])

  const sorted = useMemo(() => sortNotes(notes, prefs?.sortOrder ?? 'updated'), [notes, prefs?.sortOrder])

  const openCreate = useCallback(() => {
    setEditorState({ kind: 'create' })
  }, [])

  const openEdit = useCallback((noteId: string) => {
    setEditorState({ kind: 'edit', noteId })
  }, [])

  const closeEditor = useCallback(() => {
    setEditorState({ kind: 'closed' })
  }, [])

  const handleSaved = useCallback(
    async (note: NotebookNote) => {
      setEditorState({ kind: 'closed' })
      // Show it immediately, then let the host's own ordering win.
      setNotes((previous) => [note, ...previous.filter((item) => item.id !== note.id)])
      showToast(t('saved'))
      await load()
    },
    [load, showToast],
  )

  /**
   * G7: the title is the copy affordance — the body (image markers rendered as
   * `[图片: name]` lines) goes to the clipboard, and nothing else happens.
   *
   * Product decision (2026-09-15): clicking a title must NEVER write into the
   * conversation composer on its own. The composer bridge still exposes the
   * attachment path (see `composer.ts`), but it is deliberately unwired here —
   * an explicit action would have to opt into it.
   */
  const handleCopyBody = useCallback(
    async (note: NotebookNote) => {
      const text = buildClipboardText(note, prefs)
      try {
        await copyText(text)
      } catch {
        showToast(t('copyFailed'))
        return
      }
      showToast(text.length > 0 ? t('copied', { n: text.length }) : t('copyEmpty'))
    },
    [prefs, showToast],
  )

  /** The reference action: an atomic `@` chip in the composer, like `@session`. */
  const handleReference = useCallback(
    (note: NotebookNote) => {
      if (!composer || !composer.available()) {
        showToast(t('refUnavailable'))
        return
      }
      const label = displayTitle(note)
      const ok = composer.reference(note, buildBodyText(note))
      showToast(ok ? t('referenced', { title: label }) : t('refFailed'))
    },
    [composer, showToast],
  )

  /** The actual removal, once the decision is made (never asks anything). */
  const performDelete = useCallback(
    async (note: NotebookNote) => {
      // One request per note: the guard lives in a ref because two clicks in
      // the same tick both read the pre-update state.
      if (deleting.current === note.id) return
      deleting.current = note.id
      setConfirming(null)
      setWorkingId(note.id)
      try {
        await api.deleteNote(note.id)
        await load()
      } catch (caught) {
        setError(t('errDelete', { message: apiErrorMessage(caught) }))
      } finally {
        deleting.current = null
        if (alive.current) setWorkingId(null)
      }
    },
    [api, load],
  )

  /**
   * The row's Delete action: raise the in-panel dialog when `confirmDelete` is
   * on, and remove the note straight away when the user turned the prompt off.
   *
   * A request is refused while the editor is open: the editor overlay is
   * keyboard-reachable-around (nothing traps focus), and a confirmation raised
   * BEHIND that overlay would be invisible while it paused the list.
   */
  const handleDelete = useCallback(
    (note: NotebookNote) => {
      if (editorState.kind !== 'closed') return
      if (prefs?.confirmDelete === false) {
        void performDelete(note)
        return
      }
      setConfirming(note)
    },
    [editorState.kind, performDelete, prefs?.confirmDelete],
  )

  const cancelDelete = useCallback(() => {
    setConfirming(null)
  }, [])

  // An edit target that vanished (deleted elsewhere) closes the container.
  const editingNote =
    editorState.kind === 'edit' ? sorted.find((note) => note.id === editorState.noteId) ?? null : null
  useEffect(() => {
    if (editorState.kind === 'edit' && editingNote === null && loaded) setEditorState({ kind: 'closed' })
  }, [editorState.kind, editingNote, loaded])

  // A delete target that vanished (removed in another browser) closes its
  // dialog too: asking about a row that is already gone would 404 on confirm.
  useEffect(() => {
    if (confirming !== null && loaded && !notes.some((note) => note.id === confirming.id)) setConfirming(null)
  }, [confirming, notes, loaded])

  const confirmLabel = confirming === null ? '' : displayTitle(confirming)

  const editorMode: NotebookEditorMode | null =
    editorState.kind === 'create'
      ? { kind: 'create' }
      : editingNote
        ? { kind: 'edit', note: editingNote }
        : null

  const iconButton: CSSProperties = useMemo(
    () => ({
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: uiSizes.iconButton,
      height: uiSizes.iconButton,
      border: 'none',
      borderRadius: '50%',
      background: 'transparent',
      color: uiTokens.textSecondary,
      cursor: 'pointer',
      padding: 0,
    }),
    [],
  )

  const ghostButton: CSSProperties = useMemo(
    () => ({
      display: 'inline-flex',
      alignItems: 'center',
      height: 24,
      padding: '0 8px',
      border: `1px solid ${uiTokens.border}`,
      borderRadius: 6,
      background: 'transparent',
      color: uiTokens.textSecondary,
      fontSize: 11,
      cursor: 'pointer',
    }),
    [],
  )

  /**
   * A row action: the ghost look, but never squeezed by a long title — the
   * row wraps instead (`flexWrap` above), which keeps three actions and a title
   * readable even in the narrowest panel.
   */
  const actionButton: CSSProperties = useMemo(
    () => ({ ...ghostButton, flex: '0 0 auto', whiteSpace: 'nowrap' }),
    [ghostButton],
  )

  const primaryButton: CSSProperties = useMemo(
    () => ({
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      height: 32,
      padding: '0 14px',
      border: 'none',
      borderRadius: uiSizes.radius,
      background: uiTokens.primaryFill,
      color: uiTokens.textInverted,
      fontSize: 13,
      fontWeight: 600,
      cursor: 'pointer',
    }),
    [],
  )

  const showFullPageError = error !== null && !loaded

  return (
    <div
      data-testid="notebook-view"
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        color: uiTokens.text,
        fontFamily: 'inherit',
        fontSize: 13,
      }}
    >
      <div
        data-testid="notebook-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flex: '0 0 auto',
          padding: '6px 8px',
          borderBottom: `1px solid ${uiTokens.border}`,
        }}
      >
        <NotebookGlyph size={15} />
        <span style={{ fontSize: 12, fontWeight: 600, color: uiTokens.textSecondary }}>{t('title')}</span>
        <span style={{ flex: '1 1 auto' }} />
        {onRequestClose ? (
          <button
            type="button"
            data-testid="notebook-close"
            aria-label={t('close')}
            title={t('close')}
            onClick={onRequestClose}
            style={iconButton}
          >
            <CloseIcon size={15} />
          </button>
        ) : null}
        <button
          type="button"
          data-testid="notebook-new"
          aria-label={t('newNote')}
          title={t('newNote')}
          onClick={openCreate}
          style={{ ...iconButton, color: uiTokens.text }}
        >
          <PlusIcon size={15} />
        </button>
      </div>

      {degraded ? (
        <div
          data-testid="notebook-degraded"
          role="status"
          style={{
            flex: '0 0 auto',
            margin: '6px 8px 0',
            padding: '5px 8px',
            border: `1px solid ${uiTokens.border}`,
            borderRadius: 6,
            color: uiTokens.textSecondary,
            fontSize: 11,
          }}
        >
          {t('degraded')}
        </div>
      ) : null}

      {error !== null && !showFullPageError ? (
        <div
          data-testid="notebook-error"
          role="alert"
          style={{
            flex: '0 0 auto',
            margin: '6px 8px 0',
            padding: '5px 8px',
            border: `1px solid ${uiTokens.danger}`,
            borderRadius: 6,
            color: uiTokens.danger,
            fontSize: 11,
          }}
        >
          {error}
        </div>
      ) : null}

      <div
        data-testid="notebook-body-area"
        aria-busy={loading}
        style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}
      >
        {showFullPageError ? (
          <div data-testid="notebook-error-state" style={{ padding: '24px 16px', textAlign: 'center' }}>
            <div role="alert" style={{ color: uiTokens.danger, fontSize: 12 }}>
              {error}
            </div>
            <button type="button" data-testid="notebook-retry" onClick={() => void load()} style={{ ...ghostButton, marginTop: 10 }}>
              {t('retry')}
            </button>
          </div>
        ) : !loaded ? (
          <div
            data-testid="notebook-loading"
            style={{ padding: '24px 16px', textAlign: 'center', color: uiTokens.textTertiary, fontSize: 12 }}
          >
            {t('loading')}
          </div>
        ) : sorted.length === 0 ? (
          <div data-testid="notebook-empty" style={{ padding: '32px 16px', textAlign: 'center' }}>
            <div style={{ color: uiTokens.textTertiary, display: 'flex', justifyContent: 'center' }}>
              <NotebookGlyph size={28} />
            </div>
            <p style={{ margin: '10px 0 14px', color: uiTokens.textSecondary, fontSize: 12 }}>{t('empty')}</p>
            <button type="button" data-testid="notebook-empty-cta" onClick={openCreate} style={primaryButton}>
              <PlusIcon size={14} />
              {t('emptyCta')}
            </button>
          </div>
        ) : (
          <ul data-testid="notebook-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {sorted.map((note) => {
              const imageCount = note.attachments?.length ?? 0
              return (
                <li
                  key={note.id}
                  data-testid="notebook-note"
                  style={{
                    padding: '8px 10px',
                    borderBottom: `1px solid ${uiTokens.border}`,
                    opacity: workingId === note.id ? 0.5 : 1,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      data-testid="notebook-note-title"
                      onClick={() => void handleCopyBody(note)}
                      title={t('copyHint')}
                      style={{
                        flex: '1 1 140px',
                        minWidth: 0,
                        border: 'none',
                        background: 'transparent',
                        padding: 0,
                        textAlign: 'left',
                        font: 'inherit',
                        fontSize: 13,
                        fontWeight: 600,
                        color: uiTokens.text,
                        cursor: 'pointer',
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {displayTitle(note)}
                    </button>
                    {composer ? (
                      <button
                        type="button"
                        data-testid="notebook-note-reference"
                        aria-label={t('referenceHint')}
                        title={t('referenceHint')}
                        onClick={() => handleReference(note)}
                        style={actionButton}
                      >
                        <QuoteIcon size={11} />
                        <span style={{ marginLeft: 4 }}>{t('reference')}</span>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      data-testid="notebook-note-edit"
                      onClick={() => openEdit(note.id)}
                      style={actionButton}
                    >
                      <EditIcon size={11} />
                      <span style={{ marginLeft: 4 }}>{t('edit')}</span>
                    </button>
                    <button
                      type="button"
                      data-testid="notebook-note-delete"
                      onClick={() => handleDelete(note)}
                      style={actionButton}
                    >
                      <TrashIcon size={11} />
                      <span style={{ marginLeft: 4 }}>{t('delete')}</span>
                    </button>
                  </div>
                  <div style={{ marginTop: 3, fontSize: 11, color: uiTokens.textTertiary }}>
                    {formatTime(note.updatedAt)}
                    {imageCount > 0 ? ` · ${t('imageCount', { n: imageCount })}` : ''}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {toast !== null ? (
        <div
          data-testid="notebook-toast"
          role="status"
          style={{
            position: 'absolute',
            left: '50%',
            bottom: 12,
            transform: 'translateX(-50%)',
            maxWidth: '90%',
            padding: '5px 12px',
            borderRadius: 999,
            border: `1px solid ${uiTokens.border}`,
            background: uiTokens.surface,
            color: uiTokens.text,
            fontSize: 12,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {toast}
        </div>
      ) : null}

      {/*
        The confirmDelete prompt: an overlay INSIDE the panel, deliberately not
        `window.confirm` (see the `confirming` state above). Escape and a click
        on the backdrop both answer "no"; the destructive button is never the
        focused one, so a stray Enter cannot delete a note.
      */}
      {confirming !== null ? (
        <div
          data-testid="notebook-confirm-delete"
          role="alertdialog"
          aria-modal="true"
          aria-label={t('confirmDeleteTitle')}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              cancelDelete()
            }
          }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) cancelDelete()
          }}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 2,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 12,
            background: uiTokens.surface,
            backdropFilter: 'blur(3px)',
            WebkitBackdropFilter: 'blur(3px)',
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 280,
              padding: '12px 14px',
              border: `1px solid ${uiTokens.border}`,
              borderRadius: uiSizes.radius,
              background: uiTokens.field,
              color: uiTokens.text,
              fontSize: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: uiTokens.textSecondary }}>
              <NotebookGlyph size={14} />
              <span style={{ fontWeight: 600 }}>{t('confirmDeleteTitle')}</span>
            </div>
            <p
              data-testid="notebook-confirm-delete-message"
              style={{ margin: '8px 0 12px', color: uiTokens.text, overflowWrap: 'anywhere' }}
            >
              {t('confirmDelete', { title: confirmLabel })}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                data-testid="notebook-confirm-delete-cancel"
                autoFocus
                onClick={cancelDelete}
                style={ghostButton}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                data-testid="notebook-confirm-delete-ok"
                onClick={() => void performDelete(confirming)}
                style={{
                  ...ghostButton,
                  borderColor: uiTokens.danger,
                  color: uiTokens.textInverted,
                  background: uiTokens.danger,
                  fontWeight: 600,
                }}
              >
                {t('delete')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {editorMode !== null ? (
        <NotebookEditor
          api={api}
          prefs={prefs}
          mode={editorMode}
          onSaved={(note) => void handleSaved(note)}
          onCancel={closeEditor}
        />
      ) : null}
    </div>
  )
}
