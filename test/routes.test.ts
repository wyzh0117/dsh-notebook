/**
 * HTTP contract tests: the router runs on a real `http.createServer` bound to a
 * loopback port and is driven with `fetch`, so the whole stack (status codes,
 * headers, body caps, the loopback fence) is exercised for real.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_MAX_BODY_BYTES, NOTEBOOK_API_PREFIX, createNotebookRouter } from '../src/routes'
import { DEFAULT_PREFS, type NotebookDoc, type NotebookNote } from '../src/shared/types'
import { createNotebookStore, notebookPaths, type NotebookStore } from '../src/store'

const isWindows = process.platform === 'win32'

/** Minimal but structurally valid PNG (only the IHDR size is meaningful). */
function pngBytes(width = 2, height = 2): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  ihdr[16] = 8
  ihdr[17] = 6
  return Buffer.concat([signature, ihdr])
}

function dataUrl(mime: string, bytes: Buffer | string): string {
  const payload = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes
  return `data:${mime};base64,${payload.toString('base64')}`
}

interface Harness {
  base: string
  origin: string
  home: string
  store: NotebookStore
  route: ReturnType<typeof createNotebookRouter>
  close(): Promise<void>
}

async function startHarness(options: { maxBodyBytes?: number; home?: string } = {}): Promise<Harness> {
  const home = options.home ?? (await mkdtemp(path.join(tmpdir(), 'dshnb-routes-')))
  const store = createNotebookStore({ homeDir: home, warn: () => undefined })
  const route = createNotebookRouter({
    store,
    root: notebookPaths(home).attachmentsDir,
    version: '9.9.9-test',
    maxBodyBytes: options.maxBodyBytes,
  })
  const server: Server = createServer(async (req, res) => {
    const handled = await route(req, res)
    if (!handled && !res.headersSent) {
      res.statusCode = 404
      res.end('not ours')
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}${NOTEBOOK_API_PREFIX}`,
    origin: `http://localhost:${port}`,
    home,
    store,
    route,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

async function readNote(payload: unknown): Promise<NotebookNote> {
  const body = payload as { note?: NotebookNote }
  if (!body.note) throw new Error('response has no note')
  return body.note
}

const extraHomes: string[] = []
const extraServers: Array<() => Promise<void>> = []

beforeEach(() => {
  extraHomes.length = 0
  extraServers.length = 0
})

afterEach(async () => {
  for (const close of extraServers) await close()
  for (const home of extraHomes) {
    await chmod(home, 0o700).catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  }
})

describe('notebook HTTP API', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await startHarness()
  })

  afterEach(async () => {
    await harness.close()
    await chmod(harness.home, 0o700).catch(() => undefined)
    await rm(harness.home, { recursive: true, force: true })
  })

  it('serves /health with the version and no-store', async () => {
    const response = await fetch(`${harness.base}/health`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ ok: true, version: '9.9.9-test', degraded: false })
  })

  it('serves an empty /state document with defaults', async () => {
    const response = await fetch(`${harness.base}/state`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { doc: NotebookDoc; degraded: boolean }
    expect(body.degraded).toBe(false)
    expect(body.doc).toEqual({ version: 1, notes: [], prefs: DEFAULT_PREFS })
  })

  it('creates, lists, patches and deletes a note', async () => {
    const created = await fetch(`${harness.base}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '会议纪要', body: '第一行' }),
    })
    expect(created.status).toBe(200)
    const note = await readNote(await created.json())
    expect(note.title).toBe('会议纪要')
    expect(note.body).toBe('第一行')
    expect(note.attachments).toEqual([])

    const state = (await (await fetch(`${harness.base}/state`)).json()) as { doc: NotebookDoc }
    expect(state.doc.notes).toHaveLength(1)
    expect(state.doc.notes[0]!.id).toBe(note.id)

    const patched = await fetch(`${harness.base}/notes/${note.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '购物清单', body: '牛奶\n鸡蛋' }),
    })
    expect(patched.status).toBe(200)
    const patchedNote = await readNote(await patched.json())
    expect(patchedNote.title).toBe('购物清单')
    expect(patchedNote.body).toBe('牛奶\n鸡蛋')

    const removed = await fetch(`${harness.base}/notes/${note.id}`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ ok: true })

    const gone = await fetch(`${harness.base}/notes/${note.id}`, { method: 'DELETE' })
    expect(gone.status).toBe(404)
    expect(await gone.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
    expect(((await (await fetch(`${harness.base}/state`)).json()) as { doc: NotebookDoc }).doc.notes).toHaveLength(0)
  })

  it('stores an uploaded image and serves the exact bytes back', async () => {
    const bytes = pngBytes(4, 6)
    const response = await fetch(`${harness.base}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '带图',
        body: '看图 ![pixel](attachment:placeholder)',
        attachments: [{ name: 'pixel.png', mime: 'image/png', size: bytes.byteLength, dataUrl: dataUrl('image/png', bytes) }],
      }),
    })
    expect(response.status).toBe(200)
    const note = await readNote(await response.json())
    expect(note.attachments).toHaveLength(1)
    const attachment = note.attachments[0]!
    expect(attachment.mime).toBe('image/png')
    expect(attachment.size).toBe(bytes.byteLength)
    expect(attachment.width).toBe(4)
    expect(attachment.height).toBe(6)
    expect(attachment.relPath).toBe(`${note.id}/${attachment.id}.png`)
    expect(note.body).toContain(`attachment:${attachment.id}`)

    const file = attachment.relPath.split('/').pop()!
    const image = await fetch(`${harness.base}/attachments/${note.id}/${file}`)
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(image.headers.get('cache-control')).toBe('no-store')
    expect(image.headers.get('x-content-type-options')).toBe('nosniff')
    expect(image.headers.get('content-disposition')).toBe('inline')
    expect(Buffer.from(await image.arrayBuffer())).toEqual(bytes)
  })

  it('serves SVG with the locking-down CSP header', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>'
    const created = await fetch(`${harness.base}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'svg',
        body: 'svg',
        attachments: [{ name: 'pic.svg', mime: 'image/svg+xml', dataUrl: dataUrl('image/svg+xml', svg) }],
      }),
    })
    const note = await readNote(await created.json())
    const file = note.attachments[0]!.relPath.split('/').pop()!
    const response = await fetch(`${harness.base}/attachments/${note.id}/${file}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/svg+xml')
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'")
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toBe(svg)
  })

  it('refuses video with 415 and leaves no note or file behind', async () => {
    const response = await fetch(`${harness.base}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'video',
        body: 'bad',
        attachments: [{ name: 'clip.mp4', mime: 'video/mp4', dataUrl: dataUrl('video/mp4', 'AAAA') }],
      }),
    })
    expect(response.status).toBe(415)
    expect(await response.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA' } })

    const state = (await (await fetch(`${harness.base}/state`)).json()) as { doc: NotebookDoc }
    expect(state.doc.notes).toHaveLength(0)
    const attachmentsRoot = notebookPaths(harness.home).attachmentsDir
    await expect(readdir(attachmentsRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a video file name even when the payload claims to be an image', async () => {
    const response = await fetch(`${harness.base}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'sneaky',
        body: 'sneaky',
        attachments: [{ name: 'holiday.mp4', mime: 'image/png', dataUrl: dataUrl('image/png', pngBytes()) }],
      }),
    })
    expect(response.status).toBe(415)
    expect(await response.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA' } })
  })

  it('refuses non-image payloads with 415', async () => {
    const response = await fetch(`${harness.base}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'pdf',
        body: 'pdf',
        attachments: [{ name: 'doc.pdf', mime: 'application/pdf', dataUrl: dataUrl('application/pdf', 'AAAA') }],
      }),
    })
    expect(response.status).toBe(415)
    expect(await response.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA' } })
  })

  it('adds an image to an existing note and keeps the previous one', async () => {
    const first = await fetch(`${harness.base}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'images', body: 'one' }),
    })
    const note = await readNote(await first.json())

    const patched = await fetch(`${harness.base}/notes/${note.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        body: 'one ![a](attachment:new)',
        attachments: [{ name: 'a.png', mime: 'image/png', dataUrl: dataUrl('image/png', pngBytes()) }],
      }),
    })
    expect(patched.status).toBe(200)
    const patchedNote = await readNote(await patched.json())
    expect(patchedNote.attachments).toHaveLength(1)
    const added = patchedNote.attachments[0]!
    expect(patchedNote.body).toBe(`one ![a](attachment:${added.id})`)

    // A second patch that references the stored image by id must keep it.
    const second = await fetch(`${harness.base}/notes/${note.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'images 2', attachments: [{ id: added.id }] }),
    })
    expect(second.status).toBe(200)
    const secondNote = await readNote(await second.json())
    expect(secondNote.title).toBe('images 2')
    expect(secondNote.attachments.map((item) => item.id)).toEqual([added.id])

    // And the image is still served.
    const file = added.relPath.split('/').pop()!
    expect((await fetch(`${harness.base}/attachments/${note.id}/${file}`)).status).toBe(200)
  })

  it('leaves no orphan file when a later upload of the same patch is refused', async () => {
    const created = await fetch(`${harness.base}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'partial upload', body: 'x' }),
    })
    const note = await readNote(await created.json())

    const response = await fetch(`${harness.base}/notes/${note.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        body: 'x ![ok](attachment:ok) ![bad](attachment:bad)',
        attachments: [
          { name: 'ok.png', mime: 'image/png', dataUrl: dataUrl('image/png', pngBytes()) },
          { name: 'bad.mp4', mime: 'video/mp4', dataUrl: dataUrl('video/mp4', 'AAAA') },
        ],
      }),
    })
    expect(response.status).toBe(415)

    const state = (await (await fetch(`${harness.base}/state`)).json()) as { doc: NotebookDoc }
    expect(state.doc.notes[0]!.attachments).toEqual([])
    expect(state.doc.notes[0]!.body).toBe('x')
    // The accepted image of the refused request must not linger on disk (the
    // empty directory is reused by the next upload of this note).
    const leftovers = await readdir(path.join(notebookPaths(harness.home).attachmentsDir, note.id)).catch(() => [])
    expect(leftovers).toEqual([])
  })

  it('points placeholder markers at the stored attachment ids', async () => {
    const created = await fetch(`${harness.base}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'markers',
        body: 'first ![pixel.png](attachment:local-1)\nsecond ![other.png](attachment:local-2)',
        attachments: [
          // Distinct bytes: two different pictures must stay two attachments.
          { name: 'other.png', mime: 'image/png', dataUrl: dataUrl('image/png', pngBytes(7, 5)) },
          { name: 'pixel.png', mime: 'image/png', dataUrl: dataUrl('image/png', pngBytes(3, 3)) },
        ],
      }),
    })
    expect(created.status).toBe(200)
    const note = await readNote(await created.json())
    const pixel = note.attachments.find((item) => item.name === 'pixel.png')!
    const other = note.attachments.find((item) => item.name === 'other.png')!
    // Matched by the file name carried in the marker, not by upload order.
    expect(note.body).toContain(`![pixel.png](attachment:${pixel.id})`)
    expect(note.body).toContain(`![other.png](attachment:${other.id})`)
    expect(note.body).not.toContain('attachment:local-')
  })

  it('pairs leftover markers positionally when no file name matches', async () => {
    const created = await fetch(`${harness.base}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'positional',
        body: 'shot ![renamed](attachment:tmp-1)',
        attachments: [{ name: 'pixel.png', mime: 'image/png', dataUrl: dataUrl('image/png', pngBytes()) }],
      }),
    })
    const note = await readNote(await created.json())
    const stored = note.attachments[0]!
    expect(note.body).toBe(`shot ![renamed](attachment:${stored.id})`)
  })

  it('reuses an identical re-upload instead of duplicating the file', async () => {
    const shot = pngBytes(5, 5)
    const created = await fetch(`${harness.base}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'dedupe',
        body: '![shot.png](attachment:local)',
        attachments: [{ name: 'shot.png', mime: 'image/png', dataUrl: dataUrl('image/png', shot) }],
      }),
    })
    const note = await readNote(await created.json())
    const first = note.attachments[0]!
    const dir = path.join(notebookPaths(harness.home).attachmentsDir, note.id)
    expect(await readdir(dir)).toHaveLength(1)

    // The editor re-uploads every picture of a note when the image set changes.
    const patched = await fetch(`${harness.base}/notes/${note.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        body: '![shot.png](attachment:local-1)\n![new.png](attachment:local-2)',
        attachments: [
          { name: 'shot.png', mime: 'image/png', dataUrl: dataUrl('image/png', shot) },
          { name: 'new.png', mime: 'image/png', dataUrl: dataUrl('image/png', pngBytes(9, 9)) },
        ],
      }),
    })
    expect(patched.status).toBe(200)
    const after = await readNote(await patched.json())
    expect(after.attachments.map((item) => item.name).sort()).toEqual(['new.png', 'shot.png'])
    // The unchanged picture keeps its original id and its single file on disk.
    expect(after.attachments.map((item) => item.id)).toContain(first.id)
    expect(await readdir(dir)).toHaveLength(2)
    expect(after.body).toContain(`![shot.png](attachment:${first.id})`)
    expect(after.body).not.toContain('attachment:local-')
  })

  it('accepts EVERY preference key the plugin exposes (allowlist drift guard)', async () => {
    // One non-default value per key in `DEFAULT_PREFS`. The key-set equality
    // below is the point: adding a preference without teaching the `/prefs`
    // PATCH allowlist about it (or without adding it here) fails this test,
    // because a dropped key is invisible — the client's optimistic write is
    // then clobbered by the server's unchanged response.
    const patch: Record<string, string | number | boolean> = {
      sortOrder: 'created',
      copyImagesAsName: false,
      maxImagesPerNote: 7,
      confirmDelete: false,
      openOnStart: true,
      autoOpenOnNewSession: true,
    }
    expect(Object.keys(patch).sort()).toEqual(Object.keys(DEFAULT_PREFS).sort())

    const response = await fetch(`${harness.base}/prefs`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { prefs: Record<string, unknown> }
    for (const [key, value] of Object.entries(patch)) {
      expect([key, body.prefs[key]]).toEqual([key, value])
    }

    const persisted = (await (await fetch(`${harness.base}/state`)).json()) as { doc: NotebookDoc }
    for (const [key, value] of Object.entries(patch)) {
      expect([key, (persisted.doc.prefs as unknown as Record<string, unknown>)[key]]).toEqual([key, value])
    }
  })

  it('patches prefs and validates every field', async () => {
    const ok = await fetch(`${harness.base}/prefs`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sortOrder: 'title',
        confirmDelete: false,
        maxImagesPerNote: 3,
        autoOpenOnNewSession: true,
      }),
    })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { prefs: typeof DEFAULT_PREFS }
    expect(body.prefs.sortOrder).toBe('title')
    expect(body.prefs.confirmDelete).toBe(false)
    expect(body.prefs.maxImagesPerNote).toBe(3)
    expect(body.prefs.copyImagesAsName).toBe(true)
    // Every boolean preference the plugin exposes must survive the PATCH
    // allowlist — a key missing from it is silently dropped, which is how
    // `autoOpenOnNewSession` once became a switch that could never turn on.
    expect(body.prefs.autoOpenOnNewSession).toBe(true)
    expect(body.prefs.openOnStart).toBe(false)

    const persisted = (await (await fetch(`${harness.base}/state`)).json()) as { doc: NotebookDoc }
    expect(persisted.doc.prefs.sortOrder).toBe('title')
    expect(persisted.doc.prefs.autoOpenOnNewSession).toBe(true)

    for (const bad of [
      { sortOrder: 'nope' },
      { confirmDelete: 'yes' },
      { maxImagesPerNote: 0 },
      { maxImagesPerNote: 2.5 },
      { maxImagesPerNote: 1000 },
      { openOnStart: 1 },
      { autoOpenOnNewSession: 'yes' },
    ]) {
      const response = await fetch(`${harness.base}/prefs`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bad),
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
    }
  })

  it('reports 404 for unknown notes, unknown routes and wrong methods', async () => {
    for (const [method, url] of [
      ['PATCH', `${harness.base}/notes/missing`],
      ['DELETE', `${harness.base}/notes/missing`],
      ['GET', `${harness.base}/notes`],
      ['POST', `${harness.base}/prefs`],
      ['GET', `${harness.base}/nope`],
      ['GET', `${harness.base}/attachments/only-one-segment`],
    ] as const) {
      const response = await fetch(url, { method })
      expect([404, 400]).toContain(response.status)
      expect(await response.json()).toMatchObject({ error: { code: expect.stringMatching(/NOT_FOUND|INVALID_PATH/) } })
    }
  })

  it('reports 404 for a missing attachment and 400 for traversal attempts', async () => {
    const missing = await fetch(`${harness.base}/attachments/nope/none.png`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })

    // Encoded separators survive WHATWG URL normalization, so the router sees the
    // traversal and refuses it with 400.
    const traversal = await fetch(`${harness.base}/attachments/nope/..%2f..%2fetc%2fpasswd`)
    expect(traversal.status).toBe(400)
    expect(await traversal.json()).toMatchObject({ error: { code: 'INVALID_PATH' } })

    // A literal `../../` is normalized away by the URL parser before it is sent,
    // so it can only ever land on a non-notebook path (404 from the host).
    const literal = await fetch(`http://127.0.0.1:${new URL(harness.base).port}/notebook/attachments/nope/../../../../etc/passwd`)
    expect(literal.status).toBe(404)
  })

  it('sends no-store on every JSON response', async () => {
    for (const [method, url] of [
      ['GET', `${harness.base}/health`],
      ['GET', `${harness.base}/state`],
      ['PATCH', `${harness.base}/prefs`],
    ] as const) {
      const response = await fetch(url, { method })
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
  })

  it('rejects a foreign Origin with 403 and accepts a loopback one', async () => {
    const foreign = await fetch(`${harness.base}/state`, { headers: { origin: 'http://evil.example.com' } })
    expect(foreign.status).toBe(403)
    expect(await foreign.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })

    const nullOrigin = await fetch(`${harness.base}/state`, { headers: { origin: 'null' } })
    expect(nullOrigin.status).toBe(403)

    const fileOrigin = await fetch(`${harness.base}/state`, { headers: { origin: 'file://' } })
    expect(fileOrigin.status).toBe(403)

    const local = await fetch(`${harness.base}/state`, { headers: { origin: harness.origin } })
    expect(local.status).toBe(200)

    const literal = await fetch(`${harness.base}/state`, { headers: { origin: `http://127.0.0.1:${new URL(harness.base).port}` } })
    expect(literal.status).toBe(200)
  })

  it('fences non-loopback peers by socket address', async () => {
    const cases: Array<[string, number]> = [
      ['127.0.0.1', 200],
      ['::1', 200],
      ['::ffff:127.0.0.1', 200],
      ['10.0.0.5', 403],
      ['192.168.1.20', 403],
      ['', 403],
    ]
    for (const [address, expected] of cases) {
      const { res, body } = fakeResponse()
      const req = {
        url: `${NOTEBOOK_API_PREFIX}/state`,
        method: 'GET',
        headers: {},
        socket: { remoteAddress: address },
      } as unknown as IncomingMessage
      const handled = await harness.route(req, res)
      expect(handled).toBe(true)
      expect(res.statusCode).toBe(expected)
      if (expected === 403) expect(body()).toContain('FORBIDDEN')
    }
  })

  it('returns false for paths outside the notebook prefix', async () => {
    const { res } = fakeResponse()
    const req = {
      url: '/some/other/api',
      method: 'GET',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as IncomingMessage
    expect(await harness.route(req, res)).toBe(false)
    expect(res.headersSent).toBe(false)
  })
})

/** Minimal ServerResponse stand-in for the direct handler calls above. */
function fakeResponse(): { res: ServerResponse; headers: Record<string, string>; body: () => string } {
  const headers: Record<string, string> = {}
  let text = ''
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(name: string, value: unknown) {
      headers[name.toLowerCase()] = String(value)
      return res
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()]
    },
    removeHeader(name: string) {
      delete headers[name.toLowerCase()]
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) text += String(chunk)
      res.headersSent = true
      return res
    },
  }
  return { res: res as unknown as ServerResponse, headers, body: () => text }
}

describe('request body limits', () => {
  it('answers 413 when the streaming cap is exceeded', async () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(32 * 1024 * 1024)
    const harness = await startHarness({ maxBodyBytes: 512 })
    extraServers.push(harness.close)
    extraHomes.push(harness.home)
    try {
      const response = await fetch(`${harness.base}/notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'big', body: 'x'.repeat(4_000) }),
      })
      expect(response.status).toBe(413)
      expect(await response.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } })
      // The oversized note must not have been created.
      const state = (await (await fetch(`${harness.base}/state`)).json()) as { doc: NotebookDoc }
      expect(state.doc.notes).toHaveLength(0)
    } finally {
      await harness.close()
      await rm(harness.home, { recursive: true, force: true })
      extraServers.pop()
      extraHomes.pop()
    }
  })

  it('answers 400 for a body that is not a JSON object', async () => {
    const harness = await startHarness()
    try {
      const response = await fetch(`${harness.base}/notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'BAD_JSON' } })

      const array = await fetch(`${harness.base}/notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(['nope']),
      })
      expect(array.status).toBe(400)
      expect(await array.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
    } finally {
      await harness.close()
      await rm(harness.home, { recursive: true, force: true })
    }
  })
})

describe.skipIf(isWindows)('degraded host', () => {
  it('surfaces degraded: true over /health and /state', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'dshnb-ro-routes-'))
    await chmod(home, 0o500)
    const harness = await startHarness({ home })
    try {
      const health = (await (await fetch(`${harness.base}/health`)).json()) as { ok: boolean; degraded: boolean }
      expect(health.ok).toBe(true)
      expect(health.degraded).toBe(true)

      const state = (await (await fetch(`${harness.base}/state`)).json()) as { degraded: boolean; doc: NotebookDoc }
      expect(state.degraded).toBe(true)
      expect(state.doc.notes).toEqual([])

      // Writes keep working in memory and are reported as degraded, never silent.
      const created = await fetch(`${harness.base}/notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'in memory', body: 'body' }),
      })
      expect(created.status).toBe(200)
      const after = (await (await fetch(`${harness.base}/state`)).json()) as { doc: NotebookDoc }
      expect(after.doc.notes).toHaveLength(1)
    } finally {
      await harness.close()
      await chmod(home, 0o700).catch(() => undefined)
      await rm(home, { recursive: true, force: true })
    }
  })
})
