// @vitest-environment jsdom
/**
 * G7 unit coverage: the body → clipboard-text conversion is a pure function,
 * and the write path degrades cleanly when the async clipboard is unavailable
 * (non-secure context / denied permission).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildClipboardText, copyText, isClipboardTextEmpty, legacyCopy } from '../src/client/clipboard'
import { DEFAULT_PREFS } from '../src/shared/types'
import type { NotebookAttachment, NotebookNote, NotebookPrefs } from '../src/shared/types'

const MARKER_ID = 'att-1'
const IMAGE_NAME = 'cover.png'

function attachment(over: Partial<NotebookAttachment> = {}): NotebookAttachment {
  return {
    id: MARKER_ID,
    name: IMAGE_NAME,
    mime: 'image/png',
    size: 12,
    relPath: `note-1/${MARKER_ID}.png`,
    createdAt: 1,
    ...over,
  }
}

function note(over: Partial<NotebookNote> = {}): NotebookNote {
  return {
    id: 'note-1',
    title: '不该泄漏的标题',
    body: `正文第一行\n正文第二行`,
    attachments: [],
    createdAt: 1,
    updatedAt: 2,
    ...over,
  }
}

const prefs: NotebookPrefs = { ...DEFAULT_PREFS }

describe('buildClipboardText', () => {
  it('returns plain body text unchanged (title never leaks)', () => {
    const text = buildClipboardText(note(), prefs)
    expect(text).toBe('正文第一行\n正文第二行')
    expect(text).not.toContain('不该泄漏的标题')
  })

  it('turns a marker into a [图片: name] line when copyImagesAsName is true', () => {
    const target = note({ body: `正文\n\n![${IMAGE_NAME}](attachment:${MARKER_ID})`, attachments: [attachment()] })
    const text = buildClipboardText(target, { ...prefs, copyImagesAsName: true })
    expect(text).toContain('正文')
    expect(text).toContain('[图片: cover.png]')
    expect(text).not.toContain('attachment:')
    expect(text).not.toContain('不该泄漏的标题')
  })

  it('drops the marker (and its line) when copyImagesAsName is false', () => {
    const target = note({ body: `正文\n\n![${IMAGE_NAME}](attachment:${MARKER_ID})`, attachments: [attachment()] })
    const text = buildClipboardText(target, { ...prefs, copyImagesAsName: false })
    expect(text).toBe('正文')
    expect(text).not.toContain('cover.png')
    expect(text).not.toContain('attachment:')
  })

  it('prefers the stored attachment name over the marker alt text', () => {
    const target = note({
      body: `![stale-alt.png](attachment:${MARKER_ID})`,
      attachments: [attachment({ name: 'renamed.png' })],
    })
    expect(buildClipboardText(target, prefs)).toBe('[图片: renamed.png]')
  })

  it('trims leading and trailing whitespace', () => {
    const target = note({ body: '\n\n  正文  \n\n' })
    expect(buildClipboardText(target, prefs)).toBe('正文')
  })

  it('returns an empty string for an empty body', () => {
    const target = note({ body: '' })
    expect(buildClipboardText(target, prefs)).toBe('')
    expect(isClipboardTextEmpty(target, prefs)).toBe(true)
  })
})

describe('copyText', () => {
  let writeText: ReturnType<typeof vi.fn>

  beforeEach(() => {
    writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses navigator.clipboard.writeText when it works', async () => {
    await copyText('正文内容')
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('正文内容')
  })

  it('falls back to the hidden textarea + execCommand when writeText rejects', async () => {
    writeText.mockRejectedValueOnce(new Error('NotAllowedError'))
    const seen: string[] = []
    const execCommand = vi.fn(() => {
      const area = document.querySelector('textarea')
      if (area) seen.push((area as HTMLTextAreaElement).value)
      return true
    })
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true, writable: true })

    await copyText('回退路径文本')

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(seen).toEqual(['回退路径文本'])
    // The off-screen textarea must not survive the call.
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('throws when neither path can write (never a silent no-op)', async () => {
    writeText.mockRejectedValueOnce(new Error('NotAllowedError'))
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn(() => false),
      configurable: true,
      writable: true,
    })
    await expect(copyText('x')).rejects.toThrow()
  })

  it('legacyCopy returns false when execCommand is missing', () => {
    Object.defineProperty(document, 'execCommand', { value: undefined, configurable: true, writable: true })
    expect(legacyCopy('x')).toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
  })
})
