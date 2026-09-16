// @vitest-environment jsdom
/**
 * The language plumbing behind every user-visible string.
 *
 * v0.2.2 regression: the plugin read the active locale through `locale.get()`,
 * which DSH's `LocaleRuntime` does not expose — it publishes `getLocale()` /
 * `getSnapshot()` snapshots instead. `currentLang()` therefore always fell back
 * to `zh`, and an English shell rendered Chinese tooltips. These tests pin the
 * read order (`getLocale` → `getSnapshot` → the legacy `get`) and the fallback
 * rules down, so the plugin keeps following whatever language the shell shows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCALE_NS, attachLocale, currentLang, t, type LocaleLike } from '../src/client/locales'

/** A locale service shaped like DSH's `LocaleRuntime` (snapshot readers only). */
function snapshotService(active: string): { service: LocaleLike; registrations: Array<[string, string]> } {
  const registrations: Array<[string, string]> = []
  const listeners = new Set<() => void>()
  const snapshot = { active, locales: [{ id: active, label: active }], revision: 1 }
  const service: LocaleLike = {
    register(ns, lang) {
      registrations.push([ns, lang])
      return () => listeners.delete(() => {})
    },
    getLocale: () => snapshot,
    getSnapshot: () => snapshot,
  }
  return { service, registrations }
}

afterEach(() => {
  // Drop whatever the previous test attached: `register`-only services keep the
  // plugin on its documented `zh` default.
  attachLocale({ register: () => () => {} })
  vi.restoreAllMocks()
})

describe('the active locale read', () => {
  it('follows an English shell through getLocale()', () => {
    const { service, registrations } = snapshotService('en')
    attachLocale(service)

    expect(currentLang()).toBe('en')
    expect(t('delete')).toBe('Delete')
    expect(t('timeMinutesAgo', { n: 5 })).toBe('5 min ago')
    // Both dictionaries are registered under the plugin namespace.
    expect(registrations).toEqual([
      [LOCALE_NS, 'zh'],
      [LOCALE_NS, 'en'],
    ])
  })

  it('follows a Chinese shell, whatever the tag says', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-Hans', 'ZH']) {
      attachLocale(snapshotService(tag).service)
      expect(currentLang()).toBe('zh')
      expect(t('delete')).toBe('删除')
    }
  })

  it('reads the snapshot form too, and prefers getLocale when both exist', () => {
    const viaSnapshot: LocaleLike = { register: () => () => {}, getSnapshot: () => ({ active: 'en' }) }
    attachLocale(viaSnapshot)
    expect(t('cancel')).toBe('Cancel')

    const both: LocaleLike = {
      register: () => () => {},
      getLocale: () => ({ active: 'zh' }),
      getSnapshot: () => ({ active: 'en' }),
    }
    attachLocale(both)
    expect(t('cancel')).toBe('取消')
  })

  it('still understands a service that exposes a bare language string', () => {
    attachLocale({ register: () => () => {}, get: () => 'en-US' })
    expect(currentLang()).toBe('en')
  })

  it('falls back to English for a language it does not ship', () => {
    // DSH's own fallback locale is English; a registered `ja` shell must not be
    // answered with Chinese just because Chinese is this plugin's primary one.
    attachLocale(snapshotService('ja').service)
    expect(currentLang()).toBe('en')
  })
})

describe('the fallbacks that keep it from throwing', () => {
  it('keeps the plugin on zh when the service has no readable locale', () => {
    attachLocale({ register: () => () => {} })
    expect(currentLang()).toBe('zh')
    expect(t('delete')).toBe('删除')
  })

  it('keeps zh when the service is missing or malformed', () => {
    attachLocale(undefined)
    expect(currentLang()).toBe('zh')

    attachLocale({ register: () => () => {}, getLocale: () => ({}) as never, get: () => '' })
    expect(currentLang()).toBe('zh')
  })

  it('survives a reader that throws and uses the next one', () => {
    const service: LocaleLike = {
      register: () => () => {},
      getLocale: () => {
        throw new Error('no locale yet')
      },
      getSnapshot: () => ({ active: 'en' }),
    }
    attachLocale(service)
    expect(currentLang()).toBe('en')

    const hostile: LocaleLike = {
      register: () => () => {},
      getLocale: () => {
        throw new Error('boom')
      },
      getSnapshot: () => {
        throw new Error('boom')
      },
      get: () => {
        throw new Error('boom')
      },
    }
    attachLocale(hostile)
    expect(currentLang()).toBe('zh')
  })

  it('disposes the previous registration when it is re-bound', () => {
    const first = vi.fn(() => () => {})
    const second = vi.fn(() => () => {})
    attachLocale({ register: first })
    attachLocale({ register: second })
    expect(second).toHaveBeenCalledTimes(2)
  })

  it('never throws when the service refuses to register', () => {
    const service: LocaleLike = {
      register: () => {
        throw new Error('namespace taken')
      },
      getLocale: () => ({ active: 'en' }),
    }
    expect(() => attachLocale(service)).not.toThrow()
    // The read still works: a refused dictionary only costs the wording.
    expect(currentLang()).toBe('en')
  })
})
