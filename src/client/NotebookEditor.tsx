/**
 * The ONE editing container (spec §4.2, G8).
 *
 * `create` and `edit` are two modes of the same component instance: the list
 * owns `{kind:'closed'|'create'|'edit'}` and renders at most one of these, so
 * "edit" can never grow a second dialog, a second layer, or a new tab.
 *
 * Images (spec §4.2/§4.4, G4):
 * - three entry points — `onPaste`, `onDrop`, and the hidden
 *   `<input type="file" accept="image/*" multiple>` — funnel into `addFiles`,
 *   which runs every file through `validateImageFile` (video is refused here and
 *   again by the host with a 415).
 * - previews are `blob:` object URLs, revoked on removal and on unmount.
 *
 * Body box (v0.2.1): the textarea is content-sized — {@link applyBodyHeight}
 * measures it on every edit, on mount, and whenever the text re-wraps or the
 * viewport-relative cap moves, so a short note shows a short box and a long one
 * grows until the cap, past which it scrolls internally instead of eating the
 * panel.
 *
 * Save protocol: the body is re-composed from the textarea plus the image list,
 * so it always carries one `![name](attachment:<id>)` marker per image. Images
 * that already live on the host keep their real id and the whole request stays a
 * single PATCH; when the image set changed, the attachments are re-uploaded as
 * data URLs under client-local placeholders and, because the host mints new ids,
 * the returned note's ids are folded back into the body with one follow-up PATCH.
 * A failure at any point keeps the container open with the draft intact — the
 * user's work is never silently dropped.
 *
 * Purity: no `node:*`, no `@deepseek-ai/*` value imports.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { NotebookAttachment, NotebookNote, NotebookPrefs } from '../shared/types'
import type { NewAttachmentInput, NotebookApiClient } from './api'
import { apiErrorMessage } from './api'
import { BODY_MIN_HEIGHT, applyBodyHeight, bodyMaxHeight, viewportHeight } from './autoGrow'
import { CloseIcon, ImageIcon, NotebookGlyph, uiSizes, uiTokens } from './icons'
import {
  MAX_IMAGE_MB,
  cleanFileName,
  composeBody,
  fileToDataUrl,
  filesFromDataTransfer,
  imagesFromNote,
  newLocalKey,
  objectUrlFor,
  releaseObjectUrl,
  stripMarkerLines,
  urlToDataUrl,
  validateImageFile,
} from './image'
import type { EditorImage, ImageRejectReason } from './image'
import { t } from './locales'

export type NotebookEditorMode = { kind: 'create' } | { kind: 'edit'; note: NotebookNote }

export interface NotebookEditorProps {
  api: NotebookApiClient
  prefs: NotebookPrefs
  mode: NotebookEditorMode
  onSaved(note: NotebookNote): void
  onCancel(): void
}

interface Draft {
  title: string
  text: string
  images: EditorImage[]
}

interface EditorError {
  key: string
  vars?: Record<string, string | number>
}

/** reason → message key (both dictionaries carry every one of them). */
const REJECT_KEYS: Record<ImageRejectReason, string> = {
  video: 'errVideo',
  'not-image': 'errNotImage',
  'too-large': 'errTooLarge',
  'too-many': 'errTooMany',
}

/** The refusal message for one rejected file, with its limit interpolated. */
function rejectionError(reason: ImageRejectReason, maxImages: number): EditorError {
  if (reason === 'too-large') return { key: REJECT_KEYS[reason], vars: { max: MAX_IMAGE_MB } }
  if (reason === 'too-many') return { key: REJECT_KEYS[reason], vars: { max: maxImages } }
  return { key: REJECT_KEYS[reason] }
}

function draftFrom(mode: NotebookEditorMode, api: NotebookApiClient): Draft {
  if (mode.kind === 'edit') {
    return {
      title: typeof mode.note.title === 'string' ? mode.note.title : '',
      text: stripMarkerLines(mode.note.body),
      images: imagesFromNote(mode.note, api),
    }
  }
  return { title: '', text: '', images: [] }
}

/** Is the image set still exactly what the stored note has? */
function attachmentsUnchanged(images: EditorImage[], note: NotebookNote | null): boolean {
  if (note === null) return false
  if (images.length !== (note.attachments?.length ?? 0)) return false
  return images.every((image, index) => {
    const stored = note.attachments[index]
    return Boolean(image.attachmentId) && Boolean(stored) && image.attachmentId === stored.id
  })
}

/**
 * Map each editor image to the id the host assigned it. Fresh attachments are
 * matched by name+size first (the host echoes the sanitised name it was given),
 * then by position.
 */
function resolveAttachmentIds(
  images: EditorImage[],
  stored: NotebookAttachment[],
): Map<string, string> {
  const resolved = new Map<string, string>()
  if (stored.length < images.length) return resolved
  const used = new Set<number>()
  images.forEach((image, index) => {
    let match = -1
    for (let candidate = 0; candidate < stored.length; candidate += 1) {
      if (used.has(candidate)) continue
      if (stored[candidate].name === image.name && stored[candidate].size === image.size) {
        match = candidate
        break
      }
    }
    if (match < 0 && index < stored.length && !used.has(index)) match = index
    if (match >= 0) {
      used.add(match)
      const id = stored[match].id
      if (typeof id === 'string' && id.length > 0) resolved.set(image.key, id)
    }
  })
  return resolved
}

export function NotebookEditor(props: NotebookEditorProps): JSX.Element {
  const { api, mode, onSaved, onCancel } = props
  const maxImages = Math.max(1, Math.floor(props.prefs?.maxImagesPerNote ?? 20))
  const modeKey = mode.kind === 'edit' ? mode.note.id : 'create'

  const [draft, setDraft] = useState<Draft>(() => draftFrom(mode, api))
  const [error, setError] = useState<EditorError | null>(null)
  const [saving, setSaving] = useState(false)
  /**
   * "Discard the unsaved draft?" — asked by this editor's own dialog.
   *
   * v0.2.2: the prompt used to be `window.confirm`, a modal that blocks the
   * renderer thread. In a host that never draws a native dialog (a webview, a
   * sandboxed frame) that block never resolves and the whole page freezes on
   * Cancel/Escape, so the question is drawn in-view like the delete prompt.
   */
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  const fileInput = useRef<HTMLInputElement | null>(null)
  const bodyRef = useRef<HTMLTextAreaElement | null>(null)
  /** Every object URL this instance owns, so unmount cannot leak one. */
  const ownedUrls = useRef<Set<string>>(new Set())
  const imagesRef = useRef<EditorImage[]>(draft.images)
  const initialRef = useRef<Draft>(draft)
  const lastModeKey = useRef(modeKey)

  /** Size the body box to its content, right now (idempotent, never throws). */
  const syncBodyHeight = useCallback(() => {
    applyBodyHeight(bodyRef.current, bodyMaxHeight(viewportHeight()))
  }, [])

  // Content → height (v0.2.1). `useLayoutEffect` on purpose: the resize must
  // land in the same commit as the text, otherwise the previous height paints
  // for one frame — the flicker this patch exists to remove. Runs on mount too,
  // so an edited note opens at its own height instead of a six-row default.
  useLayoutEffect(() => {
    syncBodyHeight()
  }, [draft.text, syncBodyHeight])

  // Width (and viewport) → height. A narrower panel re-wraps the text, so the
  // same content needs more lines, and the cap itself is viewport-relative; both
  // signals re-sync here. Height-only notifications are our own doing and are
  // ignored — that filter, together with the unchanged-cap check, is what keeps
  // the observer from looping on its own resize.
  useLayoutEffect(() => {
    const element = bodyRef.current
    if (!element) return
    const disposers: Array<() => void> = []
    if (typeof ResizeObserver === 'function') {
      let lastWidth = -1
      let lastMax = -1
      const observer = new ResizeObserver((entries) => {
        const rect = entries[0]?.contentRect
        // `contentRect` is content-box while `clientWidth` is padding-box, so
        // the two are never mixed into one comparison: without an entry the
        // width counts as unknown and only the cap check decides.
        const width = rect ? rect.width : Number.NaN
        const max = bodyMaxHeight(viewportHeight())
        const widthChanged = Number.isFinite(width) && width !== lastWidth
        if (!widthChanged && max === lastMax) return
        if (Number.isFinite(width)) lastWidth = width
        lastMax = max
        syncBodyHeight()
      })
      observer.observe(element)
      disposers.push(() => observer.disconnect())
    }
    // The cap is viewport-relative, and a window resize does not have to change
    // the box's own size (its height is content-driven), so the viewport is
    // watched directly — with or without ResizeObserver.
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', syncBodyHeight)
      disposers.push(() => window.removeEventListener('resize', syncBodyHeight))
    }
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, [syncBodyHeight])

  useEffect(() => {
    imagesRef.current = draft.images
  }, [draft.images])

  useEffect(
    () => () => {
      for (const url of ownedUrls.current) releaseObjectUrl(url, true)
      ownedUrls.current.clear()
    },
    [],
  )

  // Same instance, different subject (defensive: the list closes the editor
  // before it can switch subjects, but a re-render must never mix two notes).
  useEffect(() => {
    if (lastModeKey.current === modeKey) return
    lastModeKey.current = modeKey
    for (const image of imagesRef.current) releaseObjectUrl(image.previewUrl, image.revoke)
    ownedUrls.current.clear()
    const next = draftFrom(mode, api)
    initialRef.current = next
    imagesRef.current = next.images
    setDraft(next)
    setError(null)
    setSaving(false)
  }, [api, mode, modeKey])

  const createPreview = useCallback((file: File): string => {
    const url = objectUrlFor(file)
    if (url) ownedUrls.current.add(url)
    return url
  }, [])

  const dropImage = useCallback((image: EditorImage) => {
    if (!image.revoke) return
    ownedUrls.current.delete(image.previewUrl)
    releaseObjectUrl(image.previewUrl, true)
  }, [])

  /** The single intake gate for paste, drop and the file picker. */
  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return
      const next = [...imagesRef.current]
      let rejection: ImageRejectReason | null = null
      for (const file of files) {
        const verdict = validateImageFile(file, { max: maxImages, current: next.length })
        if (!verdict.ok) {
          if (rejection === null) rejection = verdict.reason
          continue
        }
        next.push({
          key: newLocalKey(),
          name: cleanFileName(file.name),
          mime: file.type || 'application/octet-stream',
          size: file.size,
          previewUrl: createPreview(file),
          revoke: true,
          file,
        })
      }
      imagesRef.current = next
      setDraft((previous) => ({ ...previous, images: next }))
      setError(rejection === null ? null : rejectionError(rejection, maxImages))
    },
    [createPreview, maxImages],
  )

  const removeImage = useCallback(
    (key: string) => {
      const current = imagesRef.current
      const target = current.find((image) => image.key === key)
      if (target) dropImage(target)
      const next = current.filter((image) => image.key !== key)
      imagesRef.current = next
      setDraft((previous) => ({ ...previous, images: next }))
    },
    [dropImage],
  )

  const canSave = !saving && (draft.title.trim().length > 0 || draft.text.trim().length > 0 || draft.images.length > 0)
  const dirty =
    draft.title !== initialRef.current.title ||
    draft.text !== initialRef.current.text ||
    draft.images.map((image) => image.key).join(',') !== initialRef.current.images.map((image) => image.key).join(',')

  const handleDone = useCallback(async () => {
    if (!canSave) return
    const images = imagesRef.current
    const stored = mode.kind === 'edit' ? mode.note : null
    setSaving(true)
    setError(null)
    // 'prepare' = reading the image bytes; 'request' = talking to the host.
    let phase: 'prepare' | 'request' = 'prepare'
    try {
      const unchanged = attachmentsUnchanged(images, stored)
      const knownIds = new Map<string, string>()
      if (unchanged) {
        for (const image of images) {
          if (image.attachmentId) knownIds.set(image.key, image.attachmentId)
        }
      }
      let uploads: NewAttachmentInput[] | null = null
      if (!unchanged) {
        uploads = []
        for (const image of images) {
          const dataUrl = image.file ? await fileToDataUrl(image.file) : await urlToDataUrl(image.previewUrl)
          uploads.push({ name: image.name, mime: image.mime, size: image.size, dataUrl })
        }
      }
      const bodyFor = (ids: Map<string, string>) =>
        composeBody(draft.text, images, (image) => ids.get(image.key) ?? image.key)
      const title = draft.title.trim()
      const body = bodyFor(knownIds)

      phase = 'request'
      let note =
        stored === null
          ? await api.createNote({ title, body, attachments: uploads ?? [] })
          : await api.updateNote(stored.id, uploads === null ? { title, body } : { title, body, attachments: uploads })

      if (uploads !== null && uploads.length > 0) {
        // The host minted the real ids for the uploads; fold them back in.
        const resolved = resolveAttachmentIds(images, note.attachments ?? [])
        for (const [key, id] of resolved) knownIds.set(key, id)
        const finalBody = bodyFor(knownIds)
        if (resolved.size !== images.length) {
          // Not fatal (the images still render), but the markers stay local.
          console.warn('[dsh-notebook] could not map every uploaded attachment back to its id', {
            wanted: images.length,
            got: resolved.size,
          })
        }
        if (finalBody !== note.body) note = await api.updateNote(note.id, { body: finalBody })
      }
      onSaved(note)
    } catch (caught) {
      setError(
        phase === 'prepare'
          ? { key: 'errUpload', vars: { n: images.filter((image) => image.file).length } }
          : { key: 'errSave', vars: { message: apiErrorMessage(caught) } },
      )
      setSaving(false)
    }
  }, [api, canSave, draft.text, draft.title, mode, onSaved])

  /**
   * Cancel / close / Escape: a dirty draft asks first, through the dialog
   * below; a pristine one leaves immediately. Nothing here can block.
   */
  const handleCancel = useCallback(() => {
    if (dirty) {
      setConfirmingDiscard(true)
      return
    }
    onCancel()
  }, [dirty, onCancel])

  /** "Discard": leave the editor and drop the draft (owned URLs are released on unmount). */
  const discardDraft = useCallback(() => {
    setConfirmingDiscard(false)
    onCancel()
  }, [onCancel])

  /** "Keep editing": take the question away and stay in the editor. */
  const keepEditing = useCallback(() => {
    setConfirmingDiscard(false)
  }, [])

  /**
   * Hand the keyboard back to the body box when the discard question closes.
   *
   * The overlay owns focus while it is up, and a dismissed overlay drops focus
   * to `<body>` — which would silently kill this editor's Escape and
   * Cmd/Ctrl+Enter shortcuts (a native modal kept focus, so this is the one
   * behaviour that must be put back by hand).
   */
  const askedDiscard = useRef(false)
  useEffect(() => {
    if (confirmingDiscard) {
      askedDiscard.current = true
      return
    }
    if (!askedDiscard.current) return
    askedDiscard.current = false
    bodyRef.current?.focus()
  }, [confirmingDiscard])

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      // While the discard question is up, the dialog owns the keyboard (it also
      // stops propagation; this guard keeps a stray event from re-asking).
      if (confirmingDiscard) return
      if (event.key === 'Escape') {
        event.preventDefault()
        handleCancel()
        return
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void handleDone()
      }
    },
    [confirmingDiscard, handleCancel, handleDone],
  )

  const titleText = mode.kind === 'edit' ? t('editorEdit') : t('editorCreate')
  const errorText = error ? t(error.key, error.vars) : ''

  const fieldStyle: CSSProperties = useMemo(
    () => ({
      width: '100%',
      boxSizing: 'border-box',
      background: uiTokens.field,
      color: uiTokens.text,
      border: `1px solid ${uiTokens.borderStrong}`,
      borderRadius: uiSizes.radius,
      padding: '6px 8px',
      fontSize: 13,
      lineHeight: '20px',
      fontFamily: 'inherit',
      outline: 'none',
    }),
    [],
  )

  const rowButtonStyle: CSSProperties = useMemo(
    () => ({
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      height: uiSizes.controlHeight,
      padding: '0 10px',
      border: `1px solid ${uiTokens.border}`,
      borderRadius: uiSizes.radius,
      background: 'transparent',
      color: uiTokens.text,
      fontSize: 12,
      cursor: 'pointer',
    }),
    [],
  )

  return (
    <div
      data-testid="notebook-editor"
      role="dialog"
      aria-modal="true"
      aria-label={titleText}
      onKeyDown={handleKeyDown}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 3,
        display: 'flex',
        flexDirection: 'column',
        background: uiTokens.surface,
        backdropFilter: 'blur(3px)',
        WebkitBackdropFilter: 'blur(3px)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          borderBottom: `1px solid ${uiTokens.border}`,
          color: uiTokens.textSecondary,
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        <NotebookGlyph size={14} />
        <span>{titleText}</span>
        <span style={{ flex: '1 1 auto' }} />
        <button
          type="button"
          data-testid="notebook-editor-close"
          aria-label={t('cancel')}
          onClick={handleCancel}
          style={{
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
          }}
        >
          <CloseIcon size={14} />
        </button>
      </div>

      <div style={{ flex: '1 1 auto', overflowY: 'auto', padding: '10px 12px' }}>
        <input
          data-testid="notebook-title"
          aria-label={t('titleLabel')}
          placeholder={t('titlePlaceholder')}
          value={draft.title}
          onChange={(event) => setDraft((previous) => ({ ...previous, title: event.target.value }))}
          style={{ ...fieldStyle, fontWeight: 600 }}
        />

        <div style={{ height: 8 }} />

        <textarea
          ref={bodyRef}
          data-testid="notebook-body"
          aria-label={t('bodyLabel')}
          placeholder={t('bodyPlaceholder')}
          value={draft.text}
          // One row, so the box's intrinsic height cannot out-vote a
          // measurement; the CSS `min-height` below is what guarantees a
          // usable field before the first measurement and without one.
          rows={1}
          onChange={(event) => setDraft((previous) => ({ ...previous, text: event.target.value }))}
          onPaste={(event) => {
            const files = filesFromDataTransfer(event.clipboardData)
            if (files.length > 0) {
              event.preventDefault()
              addFiles(files)
            }
          }}
          onDragOver={(event) => {
            event.preventDefault()
          }}
          onDrop={(event) => {
            event.preventDefault()
            addFiles(filesFromDataTransfer(event.dataTransfer))
          }}
          style={{
            ...fieldStyle,
            // The height is content-driven (v0.2.1): the drag handle is gone
            // because a manual height would be overwritten by the next
            // measurement, and `applyBodyHeight` owns `height`/`maxHeight`/
            // `overflowY` from here on. `minHeight` is the floor the measurement
            // clamps to, and it holds the box open on the very first paint —
            // before the layout effect has run — as well as in any runtime that
            // cannot measure.
            resize: 'none',
            minHeight: BODY_MIN_HEIGHT,
          }}
        />

        {draft.images.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {draft.images.map((image) => (
              <div
                key={image.key}
                data-testid="notebook-image"
                style={{
                  position: 'relative',
                  width: 88,
                  border: `1px solid ${uiTokens.border}`,
                  borderRadius: uiSizes.radius,
                  background: uiTokens.field,
                  padding: 4,
                  boxSizing: 'border-box',
                }}
              >
                <img
                  src={image.previewUrl}
                  alt={image.name}
                  style={{ display: 'block', width: '100%', height: 68, objectFit: 'cover', borderRadius: 5 }}
                />
                <div
                  style={{
                    marginTop: 2,
                    fontSize: 10,
                    color: uiTokens.textTertiary,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {image.name}
                </div>
                <button
                  type="button"
                  data-testid="notebook-image-remove"
                  aria-label={`${t('removeImage')}: ${image.name}`}
                  onClick={() => removeImage(image.key)}
                  style={{
                    position: 'absolute',
                    top: 2,
                    right: 2,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 18,
                    height: 18,
                    border: 'none',
                    borderRadius: '50%',
                    background: 'transparent',
                    color: uiTokens.textSecondary,
                    cursor: 'pointer',
                  }}
                >
                  <CloseIcon size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {error ? (
          <div
            data-testid="notebook-editor-error"
            role="alert"
            style={{
              marginTop: 8,
              padding: '6px 8px',
              border: `1px solid ${uiTokens.danger}`,
              borderRadius: uiSizes.radius,
              color: uiTokens.danger,
              fontSize: 12,
            }}
          >
            {errorText}
          </div>
        ) : null}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderTop: `1px solid ${uiTokens.border}`,
        }}
      >
        <button
          type="button"
          data-testid="notebook-insert-image"
          onClick={() => fileInput.current?.click()}
          style={rowButtonStyle}
        >
          <ImageIcon size={14} />
          {t('insertImage')}
        </button>
        <span style={{ color: uiTokens.textTertiary, fontSize: 11 }}>
          {t('imageCountOf', { n: draft.images.length, max: maxImages })}
        </span>
        <span style={{ flex: '1 1 auto' }} />
        <button type="button" data-testid="notebook-cancel" onClick={handleCancel} style={rowButtonStyle}>
          {t('cancel')}
        </button>
        <button
          type="button"
          data-testid="notebook-done"
          onClick={() => void handleDone()}
          disabled={!canSave}
          style={{
            ...rowButtonStyle,
            background: canSave ? uiTokens.primaryFill : 'transparent',
            color: canSave ? uiTokens.textInverted : uiTokens.textTertiary,
            borderColor: canSave ? uiTokens.primaryFill : uiTokens.border,
            cursor: canSave ? 'pointer' : 'not-allowed',
            fontWeight: 600,
          }}
        >
          {saving ? t('loading') : t('done')}
        </button>
      </div>

      <input
        ref={fileInput}
        data-testid="notebook-file-input"
        type="file"
        accept="image/*"
        multiple
        onChange={(event) => {
          const files = event.target.files ? Array.from(event.target.files) : []
          event.target.value = ''
          addFiles(files)
        }}
        style={{ display: 'none' }}
      />

      {/*
        The unsaved-draft prompt (v0.2.2): drawn here, never by
        `window.confirm`. "Keep editing" is the default action (it holds focus),
        so an impatient Enter cannot throw the draft away.
      */}
      {confirmingDiscard ? (
        <div
          data-testid="notebook-confirm-discard"
          role="alertdialog"
          aria-modal="true"
          aria-label={t('discardConfirm')}
          onKeyDown={(event) => {
            // The editor's own Escape / Cmd+Enter shortcuts stay behind this
            // dialog: behind it, Escape would only reopen the question.
            event.stopPropagation()
            if (event.key === 'Escape') keepEditing()
          }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) keepEditing()
          }}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 4,
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
              <span style={{ fontWeight: 600 }}>{t('discardTitle')}</span>
            </div>
            <p style={{ margin: '8px 0 12px', color: uiTokens.text, overflowWrap: 'anywhere' }}>
              {t('discardConfirm')}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                data-testid="notebook-confirm-discard-cancel"
                autoFocus
                onClick={keepEditing}
                style={rowButtonStyle}
              >
                {t('discardKeep')}
              </button>
              <button
                type="button"
                data-testid="notebook-confirm-discard-ok"
                onClick={discardDraft}
                style={{
                  ...rowButtonStyle,
                  borderColor: uiTokens.danger,
                  color: uiTokens.textInverted,
                  background: uiTokens.danger,
                  fontWeight: 600,
                }}
              >
                {t('discardLeave')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
