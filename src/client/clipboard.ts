/**
 * "Click a title → the body lands in the clipboard" (spec §4.5, G7).
 *
 * {@link buildClipboardText} is a pure function so the conversion is testable
 * without a DOM: it works from `note.body` only and can never leak the title.
 * {@link copyText} performs the write, preferring the async clipboard API and
 * falling back to the hidden-textarea + `execCommand('copy')` path for
 * non-secure contexts (plain http on a LAN address, denied permission, old
 * engines).
 *
 * Purity: no `node:*`, no `@deepseek-ai/*` value imports.
 */
import type { NotebookNote, NotebookPrefs } from '../shared/types'
import { t } from './locales'

/**
 * A marker that owns its whole line (the editor always writes them that way),
 * trailing newline included, so dropping an image also drops its blank line.
 */
const MARKER_LINE_RE = /^[ \t]*!\[[^\]]*\]\(attachment:[^)]*\)[ \t]*\r?\n?/gm
/** A marker anywhere, including inline ones a future editor might produce. */
const MARKER_RE = /!\[([^\]]*)\]\(attachment:([^)]*)\)/g

/**
 * The exact text that goes to the clipboard: `note.body` with every image
 * marker turned into one `[图片: <name>]` line (or dropped entirely when
 * `prefs.copyImagesAsName` is false). Leading/trailing whitespace is trimmed;
 * the title is never involved.
 */
export function buildClipboardText(note: NotebookNote, prefs: NotebookPrefs): string {
  const body = typeof note?.body === 'string' ? note.body : ''
  if (body.length === 0) return ''

  const names = new Map<string, string>()
  for (const attachment of note.attachments ?? []) {
    if (attachment && typeof attachment.id === 'string') names.set(attachment.id, attachment.name ?? '')
  }

  const copyNames = prefs?.copyImagesAsName !== false // default true when unknown
  const converted = copyNames
    ? body.replace(MARKER_RE, (_match, alt: string, id: string) => {
        const name = names.get(id) ?? (typeof alt === 'string' ? alt : '')
        return t('imageLine', { name: name.length > 0 ? name : t('image') })
      })
    : body.replace(MARKER_LINE_RE, '').replace(MARKER_RE, '')

  return converted.trim()
}

/** True when the note has nothing to copy (empty body after conversion). */
export function isClipboardTextEmpty(note: NotebookNote, prefs: NotebookPrefs): boolean {
  return buildClipboardText(note, prefs).length === 0
}

/**
 * Write `text` to the clipboard. Throws when neither path works, so the caller
 * can surface a failure instead of pretending the copy happened.
 */
export async function copyText(text: string): Promise<void> {
  const value = typeof text === 'string' ? text : String(text ?? '')
  const clipboard =
    typeof navigator !== 'undefined' && navigator
      ? (navigator as Navigator & { clipboard?: { writeText?: (text: string) => Promise<void> } }).clipboard
      : undefined
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(value)
      return
    } catch {
      /* denied / not a secure context — fall through to execCommand */
    }
  }
  if (legacyCopy(value)) return
  throw new Error('clipboard_unavailable')
}

/**
 * The fallback path: an off-screen textarea, `select()`, `execCommand('copy')`.
 * Exported for direct testing of the degraded branch.
 */
export function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false
  let area: HTMLTextAreaElement | null = null
  try {
    area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.left = '-1000px'
    area.style.opacity = '0'
    area.style.pointerEvents = 'none'
    document.body.appendChild(area)
    area.select()
    area.setSelectionRange(0, area.value.length)
    if (typeof document.execCommand !== 'function') return false
    return document.execCommand('copy') === true
  } catch {
    return false
  } finally {
    if (area && area.parentNode) area.parentNode.removeChild(area)
  }
}
