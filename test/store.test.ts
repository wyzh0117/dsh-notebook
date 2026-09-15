/**
 * Store tests: CRUD + prefs round-trip, atomic writes, concurrent mutations,
 * corruption recovery and the read-only degraded mode.
 *
 * Every test gets its own temp `$DSH_HOME`, so nothing touches the real
 * `~/.dsh/storages/notebook.json`.
 */

import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NotebookAttachment, NotebookDoc } from '../src/shared/types'
import {
  NoteNotFoundError,
  createNotebookStore,
  notebookPaths,
  parseDoc,
  resolveHomeDir,
  type NotebookStore,
} from '../src/store'

const isWindows = process.platform === 'win32'

let home = ''

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'dshnb-store-'))
})

afterEach(async () => {
  // Re-open permissions first: the degraded-mode test makes the directory read-only.
  await chmod(home, 0o700).catch(() => undefined)
  await rm(home, { recursive: true, force: true })
})

function readDoc(filePath: string): Promise<NotebookDoc> {
  return readFile(filePath, 'utf8').then((text) => JSON.parse(text) as NotebookDoc)
}

function attachment(id: string, noteId: string, ext = 'png'): NotebookAttachment {
  return {
    id,
    name: `${id}.${ext}`,
    mime: ext === 'svg' ? 'image/svg+xml' : 'image/png',
    size: 3,
    relPath: `${noteId}/${id}.${ext}`,
    createdAt: 1,
  }
}

describe('resolveHomeDir', () => {
  it('prefers the explicit argument, then DSH_HOME, then ~/.dsh', () => {
    const previous = process.env.DSH_HOME
    try {
      delete process.env.DSH_HOME
      expect(resolveHomeDir('/tmp/dshnb-explicit')).toBe('/tmp/dshnb-explicit')
      expect(resolveHomeDir()).toBe(path.join(homedir(), '.dsh'))

      process.env.DSH_HOME = '   '
      expect(resolveHomeDir()).toBe(path.join(homedir(), '.dsh'))

      process.env.DSH_HOME = '/tmp/dshnb-env'
      expect(resolveHomeDir()).toBe('/tmp/dshnb-env')
      // A blank explicit value must not shadow the environment variable.
      expect(resolveHomeDir('')).toBe('/tmp/dshnb-env')
      expect(resolveHomeDir('   ')).toBe('/tmp/dshnb-env')
      expect(resolveHomeDir('/tmp/dshnb-wins')).toBe('/tmp/dshnb-wins')

      process.env.DSH_HOME = '~/dshnb-tilde'
      expect(resolveHomeDir()).toBe(path.join(homedir(), 'dshnb-tilde'))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('derives the documented storage paths', () => {
    const paths = notebookPaths('/tmp/dshnb-home')
    expect(paths.storagesDir).toBe('/tmp/dshnb-home/storages')
    expect(paths.filePath).toBe('/tmp/dshnb-home/storages/notebook.json')
    expect(paths.backupPath).toBe('/tmp/dshnb-home/storages/notebook.json.bak')
    expect(paths.attachmentsDir).toBe('/tmp/dshnb-home/storages/notebook-attachments')
  })
})

describe('notebook store CRUD', () => {
  it('round-trips notes, attachments and prefs through disk', async () => {
    const store = createNotebookStore({ homeDir: home, warn: () => undefined })
    const note = await store.createNote({
      title: '  会议纪要 2026-09-14  ',
      body: '第一行 ![图](attachment:att-1)',
      attachments: [attachment('att-1', 'placeholder')],
    })
    expect(note.title).toBe('会议纪要 2026-09-14')
    expect(note.body).toBe('第一行 ![图](attachment:att-1)')
    expect(note.attachments).toHaveLength(1)
    expect(note.createdAt).toBeGreaterThan(0)

    const doc = await store.getDoc()
    expect(doc.version).toBe(1)
    expect(doc.notes).toHaveLength(1)
    expect(doc.notes[0]!.id).toBe(note.id)
    expect(doc.notes[0]!.attachments[0]!.id).toBe('att-1')

    const updated = await store.updateNote(note.id, { title: '改后标题', body: '改后正文' })
    expect(updated.title).toBe('改后标题')
    expect(updated.body).toBe('改后正文')
    expect(updated.updatedAt).toBeGreaterThanOrEqual(note.updatedAt)
    // Only the addressed fields change; images survive a title/body-only patch.
    expect(updated.attachments).toHaveLength(1)

    const prefs = await store.updatePrefs({ sortOrder: 'title', copyImagesAsName: false })
    expect(prefs.sortOrder).toBe('title')
    expect(prefs.copyImagesAsName).toBe(false)
    expect(prefs.confirmDelete).toBe(true)
    expect(prefs.maxImagesPerNote).toBe(20)

    // A fresh store on the same home directory sees the persisted document.
    const reopened = createNotebookStore({ homeDir: home, warn: () => undefined })
    const reopenedDoc = await reopened.getDoc()
    expect(reopenedDoc.notes).toHaveLength(1)
    expect(reopenedDoc.notes[0]!.title).toBe('改后标题')
    expect(reopenedDoc.notes[0]!.attachments[0]!.name).toBe('att-1.png')
    expect(reopenedDoc.prefs.sortOrder).toBe('title')
    expect(reopenedDoc.prefs.copyImagesAsName).toBe(false)

    expect(await reopened.deleteNote(note.id)).toBe(true)
    expect(await reopened.deleteNote(note.id)).toBe(false)
    expect((await reopened.getDoc()).notes).toHaveLength(0)
  })

  it('rejects updates and deletions of unknown notes', async () => {
    const store = createNotebookStore({ homeDir: home, warn: () => undefined })
    await expect(store.updateNote('missing', { title: 'x' })).rejects.toBeInstanceOf(NoteNotFoundError)
    await expect(store.updateNote('missing', { title: 'x' })).rejects.toMatchObject({ status: 404 })
    expect(await store.deleteNote('missing')).toBe(false)
  })

  it('ignores unknown prefs fields and clamps invalid values', async () => {
    const store = createNotebookStore({ homeDir: home, warn: () => undefined })
    const prefs = await store.updatePrefs({ sortOrder: 'created' })
    expect(prefs.sortOrder).toBe('created')
    // Store-level normalization is lenient; the HTTP layer is the strict validator.
    const stillValid = await store.updatePrefs({ maxImagesPerNote: 10_000 })
    expect(stillValid.maxImagesPerNote).toBe(20)
    const overridden = await store.updatePrefs({ maxImagesPerNote: 5 })
    expect(overridden.maxImagesPerNote).toBe(5)
  })

  it('deletes a note together with its attachment directory', async () => {
    const store = createNotebookStore({ homeDir: home, warn: () => undefined })
    const paths = notebookPaths(home)
    const note = await store.createNote({ title: 'with image', attachments: [] })
    const noteDir = path.join(paths.attachmentsDir, note.id)
    await mkdir(noteDir, { recursive: true })
    await writeFile(path.join(noteDir, 'a1.png'), Buffer.from([1, 2, 3]))

    expect(await store.deleteNote(note.id)).toBe(true)
    await expect(readdir(noteDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('garbage-collects attachment files that the body no longer references', async () => {
    const store = createNotebookStore({ homeDir: home, warn: () => undefined })
    const paths = notebookPaths(home)
    const note = await store.createNote({
      id: 'note-gc',
      title: 'two images',
      body: 'A ![a](attachment:a1)\nB ![b](attachment:a2)',
      attachments: [attachment('a1', 'note-gc'), attachment('a2', 'note-gc')],
    })
    const noteDir = path.join(paths.attachmentsDir, note.id)
    await mkdir(noteDir, { recursive: true })
    await writeFile(path.join(noteDir, 'a1.png'), Buffer.from('a'))
    await writeFile(path.join(noteDir, 'a2.png'), Buffer.from('b'))

    const afterRemoval = await store.updateNote(note.id, {
      body: 'only A ![a](attachment:a1)',
      keepAttachmentIds: [],
    })
    expect(afterRemoval.attachments.map((item) => item.id)).toEqual(['a1'])
    expect((await readFile(path.join(noteDir, 'a1.png'))).byteLength).toBe(1)
    await expect(readFile(path.join(noteDir, 'a2.png'))).rejects.toMatchObject({ code: 'ENOENT' })

    // An attachment the body never referenced is preserved rather than silently dropped.
    const loose = await store.createNote({
      id: 'note-loose',
      title: 'unreferenced image',
      body: 'no markers here',
      attachments: [attachment('keep-me', 'note-loose')],
    })
    const afterRewrite = await store.updateNote(loose.id, { body: 'still no markers', keepAttachmentIds: [] })
    expect(afterRewrite.attachments.map((item) => item.id)).toEqual(['keep-me'])
  })

  it('keeps an image whose name still appears in the rewritten body', async () => {
    const store = createNotebookStore({ homeDir: home, warn: () => undefined })
    const shot: NotebookAttachment = {
      id: 'original-id',
      name: 'shot.png',
      mime: 'image/png',
      size: 3,
      relPath: 'note-names/original-id.png',
      createdAt: 1,
    }
    const note = await store.createNote({
      id: 'note-names',
      title: 'shot',
      body: '![shot.png](attachment:original-id)',
      attachments: [shot],
    })
    // A client that re-serializes markers with its own placeholder ids must not
    // lose the stored image: the marker alt text still names it.
    const patched = await store.updateNote(note.id, {
      body: '![shot.png](attachment:client-placeholder)',
      keepAttachmentIds: [],
    })
    expect(patched.attachments.map((item) => item.id)).toEqual(['original-id'])
  })
})

describe('atomic writes', () => {
  it('leaves valid JSON, no temp file and a backup of the previous version', async () => {
    const store = createNotebookStore({ homeDir: home, warn: () => undefined })
    const paths = notebookPaths(home)

    await store.createNote({ title: 'first' })
    const first = await readDoc(paths.filePath)
    expect(first.version).toBe(1)
    expect(first.notes.map((note) => note.title)).toEqual(['first'])

    const entriesAfterFirstWrite = await readdir(paths.storagesDir)
    expect(entriesAfterFirstWrite).toContain('notebook.json')
    expect(entriesAfterFirstWrite.some((entry) => entry.endsWith('.tmp'))).toBe(false)

    await store.createNote({ title: 'second' })
    const backup = await readDoc(paths.backupPath)
    expect(backup.notes.map((note) => note.title)).toEqual(['first'])
    const current = await readDoc(paths.filePath)
    expect(current.notes.map((note) => note.title).sort()).toEqual(['first', 'second'])
    expect(await readdir(paths.storagesDir)).not.toContain('notebook.json.tmp')
  })

  it('parses a good document and rejects garbage', () => {
    expect(parseDoc('not json at all')).toBeUndefined()
    expect(parseDoc('[]')).toBeUndefined()
    expect(parseDoc('{"version":2,"notes":[]}')).toBeUndefined()
    expect(parseDoc('{"version":1}')).toBeUndefined()
    const parsed = parseDoc('{"version":1,"notes":[{"id":"n1","title":"hi"}]}')
    expect(parsed?.notes).toHaveLength(1)
    expect(parsed?.notes[0]!.title).toBe('hi')
    expect(parsed?.prefs.sortOrder).toBe('updated')
  })
})

describe('concurrency', () => {
  it('keeps every note when 20 creates race', async () => {
    const store = createNotebookStore({ homeDir: home, warn: () => undefined })
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.createNote({ title: `note-${index}`, body: `body-${index}` }),
      ),
    )
    expect(created).toHaveLength(20)

    const doc = await store.getDoc()
    expect(doc.notes).toHaveLength(20)
    expect(new Set(doc.notes.map((note) => note.id)).size).toBe(20)
    expect(new Set(doc.notes.map((note) => note.title)).size).toBe(20)

    const onDisk = await readDoc(notebookPaths(home).filePath)
    expect(onDisk.notes).toHaveLength(20)
  })

  it('round-trips the new-session auto-open preference (off unless asked for)', async () => {
    const store = createNotebookStore({ homeDir: home, warn: () => undefined })
    // The default is off: a panel nobody asked for must never open itself.
    expect((await store.getPrefs()).autoOpenOnNewSession).toBe(false)

    const prefs = await store.updatePrefs({ autoOpenOnNewSession: true })
    expect(prefs.autoOpenOnNewSession).toBe(true)
    expect((await readDoc(notebookPaths(home).filePath)).prefs.autoOpenOnNewSession).toBe(true)

    const cleared = await store.updatePrefs({ autoOpenOnNewSession: false })
    expect(cleared.autoOpenOnNewSession).toBe(false)
  })

  it('interleaves creates and pref updates without losing any write', async () => {
    const store = createNotebookStore({ homeDir: home, warn: () => undefined })
    await Promise.all([
      ...Array.from({ length: 10 }, (_, index) => store.createNote({ title: `c-${index}` })),
      store.updatePrefs({ sortOrder: 'created' }),
      store.updatePrefs({ confirmDelete: false }),
    ])
    const doc = await store.getDoc()
    expect(doc.notes).toHaveLength(10)
    expect(doc.prefs.sortOrder).toBe('created')
    expect(doc.prefs.confirmDelete).toBe(false)
    expect((await readDoc(notebookPaths(home).filePath)).prefs.confirmDelete).toBe(false)
  })

  it('serializes 20 concurrent patches of the same note', async () => {
    const store = createNotebookStore({ homeDir: home, warn: () => undefined })
    const note = await store.createNote({ title: 'race', body: 'v0' })
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.updateNote(note.id, { body: `v${index + 1}` })),
    )
    const doc = await store.getDoc()
    expect(doc.notes).toHaveLength(1)
    expect(doc.notes[0]!.body).toMatch(/^v([1-9]|1[0-9]|20)$/)
    // The persisted document must match the in-memory view exactly.
    const onDisk = await readDoc(notebookPaths(home).filePath)
    expect(onDisk.notes[0]!.body).toBe(doc.notes[0]!.body)
  })
})

describe('corruption recovery', () => {
  it('restores a corrupt document from the backup and quarantines the bad file', async () => {
    const store = createNotebookStore({ homeDir: home, warn: () => undefined })
    const paths = notebookPaths(home)
    await store.createNote({ title: 'first' })
    await store.createNote({ title: 'second' })
    await writeFile(paths.filePath, '{ this is definitely not json', 'utf8')

    const warnings: string[] = []
    const recovered = createNotebookStore({ homeDir: home, warn: (message) => warnings.push(message) })
    const doc = await recovered.getDoc()
    expect(doc.notes).toHaveLength(1)
    expect(doc.notes[0]!.title).toBe('first')
    expect(warnings.join('\n')).toMatch(/corrupt/)

    const entries = await readdir(paths.storagesDir)
    expect(entries.some((entry) => entry.startsWith('notebook.json.corrupt-'))).toBe(true)
    // The primary file is healed, so the next start is clean.
    const healed = await readDoc(paths.filePath)
    expect(healed.notes.map((note) => note.title)).toEqual(['first'])
  })

  it('starts from an empty document when the backup is broken too', async () => {
    const store = createNotebookStore({ homeDir: home, warn: () => undefined })
    const paths = notebookPaths(home)
    await store.createNote({ title: 'first' })
    await store.createNote({ title: 'second' })
    await writeFile(paths.filePath, 'garbage', 'utf8')
    await writeFile(paths.backupPath, 'also garbage', 'utf8')

    const warnings: string[] = []
    const recovered = createNotebookStore({ homeDir: home, warn: (message) => warnings.push(message) })
    expect((await recovered.getDoc()).notes).toEqual([])
    expect(warnings.join('\n')).toMatch(/both unreadable/)
    const entries = await readdir(paths.storagesDir)
    expect(entries.filter((entry) => entry.includes('.corrupt-'))).toHaveLength(2)
    // Still usable: the document can be written again.
    await recovered.createNote({ title: 'after recovery' })
    expect((await readDoc(paths.filePath)).notes.map((note) => note.title)).toEqual(['after recovery'])
  })

  it('recovers a missing document from the backup', async () => {
    const store = createNotebookStore({ homeDir: home, warn: () => undefined })
    const paths = notebookPaths(home)
    await store.createNote({ title: 'first' })
    await store.createNote({ title: 'second' })
    await rm(paths.filePath)

    const warnings: string[] = []
    const recovered = createNotebookStore({ homeDir: home, warn: (message) => warnings.push(message) })
    expect((await recovered.getDoc()).notes.map((note) => note.title)).toEqual(['first'])
    expect(warnings.join('\n')).toMatch(/missing/)
  })

  it('creates an empty document on first use', async () => {
    const store = createNotebookStore({ homeDir: home, warn: () => undefined })
    const doc = await store.getDoc()
    expect(doc).toEqual({ version: 1, notes: [], prefs: (await store.getPrefs()) })
    expect(await readDoc(notebookPaths(home).filePath)).toEqual(doc)
  })
})

describe.skipIf(isWindows)('degraded mode', () => {
  it('falls back to memory, warns, and never writes to the read-only home', async () => {
    const readOnlyHome = await mkdtemp(path.join(tmpdir(), 'dshnb-ro-'))
    try {
      await chmod(readOnlyHome, 0o500)
      const warnings: string[] = []
      const store: NotebookStore = createNotebookStore({
        homeDir: readOnlyHome,
        warn: (message) => warnings.push(message),
      })

      await store.init()
      expect(store.degraded).toBe(true)
      expect(store.degradedReason).toBeTruthy()
      expect(warnings.join('\n')).toMatch(/not writable/)
      expect(warnings.join('\n')).toMatch(/MEMORY-ONLY/)

      const note = await store.createNote({ title: 'memory only', body: 'body' })
      expect(note.title).toBe('memory only')
      expect((await store.getDoc()).notes).toHaveLength(1)
      expect((await store.updatePrefs({ sortOrder: 'title' })).sortOrder).toBe('title')
      expect(await store.deleteNote(note.id)).toBe(true)
      expect((await store.getDoc()).notes).toHaveLength(0)

      // Nothing reached the disk.
      await chmod(readOnlyHome, 0o700)
      const reopened = createNotebookStore({ homeDir: readOnlyHome, warn: () => undefined })
      expect(reopened.degraded).toBe(false)
      expect((await reopened.getDoc()).notes).toEqual([])
    } finally {
      await chmod(readOnlyHome, 0o700).catch(() => undefined)
      await rm(readOnlyHome, { recursive: true, force: true })
    }
  })
})

describe('sort order', () => {
  it('honours prefs.sortOrder for the returned document', async () => {
    let tick = 1_000_000
    let counter = 0
    const store = createNotebookStore({
      homeDir: home,
      warn: () => undefined,
      now: () => tick++,
      newId: () => `note-${++counter}`,
    })
    const beta = await store.createNote({ title: 'Beta' })
    await store.createNote({ title: 'alpha' })
    await store.createNote({ title: 'Gamma' })

    expect((await store.getDoc()).notes.map((note) => note.title)).toEqual(['Gamma', 'alpha', 'Beta'])

    await store.updateNote(beta.id, { body: 'edited' })
    const byUpdated = await store.getDoc()
    expect(byUpdated.prefs.sortOrder).toBe('updated')
    expect(byUpdated.notes.map((note) => note.title)).toEqual(['Beta', 'Gamma', 'alpha'])

    await store.updatePrefs({ sortOrder: 'created' })
    expect((await store.getDoc()).notes.map((note) => note.title)).toEqual(['Gamma', 'alpha', 'Beta'])

    await store.updatePrefs({ sortOrder: 'title' })
    expect((await store.getDoc()).notes.map((note) => note.title)).toEqual(['alpha', 'Beta', 'Gamma'])

    // The persisted order stays canonical (updatedAt desc) regardless of the view order.
    expect((await readDoc(notebookPaths(home).filePath)).notes.map((note) => note.title)).toEqual([
      'Beta',
      'Gamma',
      'alpha',
    ])
  })
})
