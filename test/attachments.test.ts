/**
 * Attachment tests: data-URL decoding, the video fence, size/count caps,
 * directory-traversal protection, file-name sanitization and the SVG headers.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AttachmentError,
  AttachmentLimitError,
  AttachmentNotFoundError,
  AttachmentPathError,
  AttachmentTooLargeError,
  MAX_IMAGE_BYTES,
  UnsupportedMediaError,
  decodeDataUrl,
  extForMime,
  imageResponseHeaders,
  mimeForExt,
  noteAttachmentDir,
  readAttachment,
  readImageSize,
  removeNoteAttachmentDir,
  resolveAttachmentPath,
  sanitizeFileName,
  saveAttachment,
} from '../src/attachments'

let home = ''
let root = ''

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'dshnb-att-'))
  root = path.join(home, 'notebook-attachments')
  await mkdir(root, { recursive: true })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

/** Minimal but structurally valid PNG (header only: the size sniff reads IHDR). */
function pngBytes(width = 3, height = 2): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr[16] = 8 // bit depth
  ihdr[17] = 6 // colour type
  return Buffer.concat([signature, ihdr])
}

function dataUrl(mime: string, bytes: Buffer | string): string {
  const payload = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes
  return `data:${mime};base64,${payload.toString('base64')}`
}

describe('decodeDataUrl', () => {
  it('decodes a strict base64 data URL', () => {
    const { mime, bytes } = decodeDataUrl('data:image/png;base64,AQID')
    expect(mime).toBe('image/png')
    expect([...bytes]).toEqual([1, 2, 3])
  })

  it('normalizes the image/jpg alias and tolerates extra parameters', () => {
    expect(decodeDataUrl('data:image/jpg;base64,AQID').mime).toBe('image/jpeg')
    expect(decodeDataUrl('data:image/svg+xml;charset=utf-8;base64,AQID').mime).toBe('image/svg+xml')
    expect(decodeDataUrl('DATA:IMAGE/PNG;base64,AQID').mime).toBe('image/png')
  })

  it('rejects anything that is not a base64 data URL', () => {
    for (const bad of ['', 'not-a-data-url', 'data:image/png,plain-text', 'data:;base64,AQID', 'data:image/png;base64,']) {
      expect(() => decodeDataUrl(bad)).toThrowError(AttachmentError)
    }
    const error = (() => {
      try {
        decodeDataUrl('nope')
      } catch (caught) {
        return caught as AttachmentError
      }
      return undefined
    })()
    expect(error?.status).toBe(400)
    expect(error?.code).toBe('BAD_DATA_URL')
  })
})

describe('saveAttachment', () => {
  it('accepts all five allowed image types and never uses the original name on disk', async () => {
    const cases: Array<[string, string]> = [
      ['image/png', pngBytes().toString('base64')],
      ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]).toString('base64')],
      ['image/gif', Buffer.from('GIF89a').toString('base64')],
      ['image/webp', Buffer.from('RIFF....WEBPVP8 ').toString('base64')],
      ['image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')],
    ]
    const savedIds: string[] = []
    for (const [mime, payload] of cases) {
      const attachment = await saveAttachment(root, 'note-1', {
        name: `../../sneaky ${mime.split('/')[1]!.replace('+xml', '')}.weird`,
        mime,
        dataUrl: `data:${mime};base64,${payload}`,
      })
      savedIds.push(attachment.id)
      expect(attachment.mime).toBe(mime)
      expect(attachment.name).not.toContain('/')
      expect(attachment.name).not.toContain('..')
      expect(attachment.size).toBeGreaterThan(0)
      // The on-disk name is `<attachmentId>.<ext>`, derived from the MIME type.
      expect(attachment.relPath).toBe(`note-1/${attachment.id}.${extForMime(mime)}`)
      const onDisk = await readFile(path.join(root, 'note-1', `${attachment.id}.${extForMime(mime)}`))
      expect(onDisk.byteLength).toBe(attachment.size)
    }
    expect(new Set(savedIds).size).toBe(cases.length)
  })

  it('sniffs the pixel size of a raster image', async () => {
    const attachment = await saveAttachment(root, 'note-1', {
      name: 'grid.png',
      mime: 'image/png',
      dataUrl: dataUrl('image/png', pngBytes(3, 2)),
    })
    expect(attachment.width).toBe(3)
    expect(attachment.height).toBe(2)
    expect(readImageSize(Buffer.from('<svg/>'), 'image/svg+xml')).toBeUndefined()
  })

  it('rejects a video payload with a 415-shaped error', async () => {
    await expect(
      saveAttachment(root, 'note-1', { name: 'clip.mp4', mime: 'video/mp4', dataUrl: dataUrl('video/mp4', 'AAAA') }),
    ).rejects.toBeInstanceOf(UnsupportedMediaError)

    const error = (await saveAttachment(root, 'note-1', {
      name: 'clip.webm',
      mime: 'video/webm',
      dataUrl: dataUrl('video/webm', 'AAAA'),
    }).catch((caught: unknown) => caught)) as UnsupportedMediaError
    expect(error).toBeInstanceOf(UnsupportedMediaError)
    expect(error.status).toBe(415)
    expect(error.code).toBe('UNSUPPORTED_MEDIA')

    // Nothing may reach the disk for a refused upload.
    await expect(readdir(path.join(root, 'note-1'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a video file name even when the payload claims to be an image', async () => {
    const error = (await saveAttachment(root, 'note-1', {
      name: 'holiday.mp4',
      mime: 'image/png',
      dataUrl: dataUrl('image/png', pngBytes()),
    }).catch((caught: unknown) => caught)) as UnsupportedMediaError
    expect(error).toBeInstanceOf(UnsupportedMediaError)
    expect(error.status).toBe(415)

    // Same rule when only the declared MIME is video but the payload is an image.
    await expect(
      saveAttachment(root, 'note-1', {
        name: 'clip.png',
        mime: 'video/quicktime',
        dataUrl: dataUrl('image/png', pngBytes()),
      }),
    ).rejects.toBeInstanceOf(UnsupportedMediaError)
  })

  it('rejects non-image payloads', async () => {
    for (const mime of ['application/pdf', 'text/plain', 'audio/mpeg', 'application/octet-stream']) {
      await expect(
        saveAttachment(root, 'note-1', { name: 'file.bin', mime, dataUrl: dataUrl(mime, 'AAAA') }),
      ).rejects.toBeInstanceOf(UnsupportedMediaError)
    }
    expect(() => extForMime('image/tiff')).toThrowError(UnsupportedMediaError)
    expect(mimeForExt('.PNG')).toBe('image/png')
    expect(mimeForExt('jpeg')).toBe('image/jpeg')
    expect(mimeForExt('tiff')).toBeUndefined()
  })

  it('enforces the 10 MB per-image cap by default', async () => {
    expect(MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024)
    const bytes = Buffer.alloc(MAX_IMAGE_BYTES + 1)
    const error = (await saveAttachment(root, 'note-1', {
      name: 'huge.png',
      mime: 'image/png',
      dataUrl: dataUrl('image/png', bytes),
    }).catch((caught: unknown) => caught)) as AttachmentTooLargeError
    expect(error).toBeInstanceOf(AttachmentTooLargeError)
    expect(error.status).toBe(413)
    expect(error.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('enforces an injectable per-image cap and the per-note image count cap', async () => {
    await expect(
      saveAttachment(root, 'note-1', { name: 'a.png', mime: 'image/png', dataUrl: dataUrl('image/png', pngBytes()) }, { maxBytes: 8 }),
    ).rejects.toBeInstanceOf(AttachmentTooLargeError)

    const first = await saveAttachment(
      root,
      'note-1',
      { name: 'a.png', mime: 'image/png', dataUrl: dataUrl('image/png', pngBytes()) },
      { maxImages: 1, existingCount: 0 },
    )
    expect(first.id).toBeTruthy()
    const error = (await saveAttachment(
      root,
      'note-1',
      { name: 'b.png', mime: 'image/png', dataUrl: dataUrl('image/png', pngBytes()) },
      { maxImages: 1, existingCount: 1 },
    ).catch((caught: unknown) => caught)) as AttachmentLimitError
    expect(error).toBeInstanceOf(AttachmentLimitError)
    expect(error.status).toBe(413)
    expect(error.code).toBe('TOO_MANY_ATTACHMENTS')
  })
})

describe('path safety', () => {
  it('refuses traversal attempts in both raw and percent-encoded forms', () => {
    for (const attempt of [
      '../../etc/passwd',
      '../secret.png',
      '..%2f..%2fetc%2fpasswd',
      'a%5cb.png',
      '',
      '.',
      '..',
    ]) {
      expect(() => resolveAttachmentPath(root, 'note-1', attempt)).toThrowError(AttachmentPathError)
    }
    for (const noteId of ['../note-1', '..%2fnote-1', 'a/b', '', '.']) {
      expect(() => resolveAttachmentPath(root, noteId, 'a.png')).toThrowError(AttachmentPathError)
    }
    expect(() => noteAttachmentDir(root, '..')).toThrowError(AttachmentPathError)

    const error = (() => {
      try {
        resolveAttachmentPath(root, 'note-1', '../../etc/passwd')
      } catch (caught) {
        return caught as AttachmentPathError
      }
      return undefined
    })()
    expect(error?.status).toBe(400)
  })

  it('accepts a normal note/file pair and keeps it inside the root', () => {
    const resolved = resolveAttachmentPath(root, 'note-1', 'a1.png')
    expect(resolved).toBe(path.join(path.resolve(root), 'note-1', 'a1.png'))
    expect(resolved.startsWith(path.resolve(root) + path.sep)).toBe(true)
  })

  it('reports missing files and unknown extensions as 404', async () => {
    await mkdir(path.join(root, 'note-1'), { recursive: true })
    await writeFile(path.join(root, 'note-1', 'weird.exe'), 'x')

    await expect(readAttachment(root, 'note-1', 'missing.png')).rejects.toBeInstanceOf(AttachmentNotFoundError)
    const error = (await readAttachment(root, 'note-1', 'weird.exe').catch((caught: unknown) => caught)) as
      | AttachmentNotFoundError
      | undefined
    expect(error).toBeInstanceOf(AttachmentNotFoundError)
    expect(error?.status).toBe(404)
  })

  it('reads stored bytes back and removes note directories', async () => {
    const attachment = await saveAttachment(root, 'note-1', {
      name: 'pixel.png',
      mime: 'image/png',
      dataUrl: dataUrl('image/png', pngBytes()),
    })
    const file = attachment.relPath.split('/').pop()!
    const read = await readAttachment(root, 'note-1', file)
    expect(read.mime).toBe('image/png')
    expect(read.bytes.byteLength).toBe(attachment.size)

    await removeNoteAttachmentDir(root, 'note-1')
    await expect(readdir(path.join(root, 'note-1'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('sanitizeFileName', () => {
  it('strips paths, control characters and leading dots, and caps the length', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFileName('C:\\Users\\me\\Pictures\\pic.png')).toBe('pic.png')
    expect(sanitizeFileName('pic\u0000name.png')).toBe('picname.png')
    expect(sanitizeFileName('  spaced.png  ')).toBe('spaced.png')
    expect(sanitizeFileName('...hidden.png')).toBe('hidden.png')
    expect(sanitizeFileName('photo[1].png')).toBe('photo1.png')
    expect(sanitizeFileName(undefined)).toBe('')
    expect(sanitizeFileName(42)).toBe('')
    const long = sanitizeFileName(`${'x'.repeat(400)}.png`)
    expect(long.length).toBeLessThanOrEqual(120)
    expect(long.endsWith('.png')).toBe(true)
  })

  it('falls back to the generated file name when nothing usable is left', async () => {
    const attachment = await saveAttachment(root, 'note-1', {
      name: '../..',
      mime: 'image/png',
      dataUrl: dataUrl('image/png', pngBytes()),
    })
    expect(attachment.name).toBe(`${attachment.id}.png`)
  })
})

describe('response headers', () => {
  it('serves SVG with a locking-down CSP and every image with nosniff', () => {
    const svg = imageResponseHeaders('image/svg+xml')
    expect(svg['Content-Type']).toBe('image/svg+xml')
    expect(svg['Content-Security-Policy']).toBe("default-src 'none'; style-src 'unsafe-inline'")
    expect(svg['X-Content-Type-Options']).toBe('nosniff')
    expect(svg['Content-Disposition']).toBe('inline')
    expect(svg['Cache-Control']).toBe('no-store')

    const png = imageResponseHeaders('image/png')
    expect(png['Content-Type']).toBe('image/png')
    expect(png['Content-Security-Policy']).toBeUndefined()
    expect(png['X-Content-Type-Options']).toBe('nosniff')
  })
})
