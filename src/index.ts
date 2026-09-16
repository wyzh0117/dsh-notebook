/**
 * dsh-notebook — host half (Cordis plugin entry).
 *
 * Responsibilities:
 *   - resolve the DSH home directory and build the notebook store;
 *   - register the JSON HTTP API under `/notebook/api` on the DSH web server;
 *   - never throw when `webServer` is missing — log a warning and wait for it.
 *
 * Everything user-facing (sidebar, editor, clipboard) lives in the client
 * bundle `lib/client.js`; this half only owns data and the HTTP contract.
 */

import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { NOTEBOOK_API_PREFIX, createNotebookRouter } from './routes'
import { MAX_REQUEST_BYTES } from './shared/types'
import { createNotebookStore, notebookPaths, resolveHomeDir } from './store'

/** Cordis plugin name; the banner id in `dsh.plugin.json` must match it. */
export const name = 'dsh-notebook'

/** Plugin configuration (every field optional; defaults fill in). */
export interface Config {
  /**
   * DSH home override. Empty/absent falls back to `DSH_HOME`, then `~/.dsh`,
   * exactly like {@link resolveHomeDir}.
   */
  homeDir?: string
  /** Cap for one API request body in bytes; defaults to 32 MB. */
  maxNoteBytes?: number
}

/**
 * Schemastery schema for the plugin configuration.
 *
 * Every field carries a default so the plugin loads with no config at all
 * (`cordis.patch.yml` inserts it as `{ id: notebook, name: 'dsh-notebook' }`).
 */
export const Config = z.object({
  homeDir: z.string().default(''),
  maxNoteBytes: z.number().step(1).min(1024).default(MAX_REQUEST_BYTES),
})

/** Used when the package manifest cannot be read. */
const FALLBACK_VERSION = '0.2.2'

/** Read the plugin version from the nearest manifest, falling back to a constant. */
function resolveVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    for (const relative of ['../package.json', '../../package.json', '../dsh.plugin.json']) {
      try {
        const parsed = JSON.parse(readFileSync(join(here, relative), 'utf8')) as { version?: unknown }
        if (typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version
      } catch {
        // Try the next candidate location.
      }
    }
  } catch {
    // `import.meta.url` unavailable in this host shape; fall through.
  }
  return FALLBACK_VERSION
}

/** Log through the Cordis logger when present, otherwise through the console. */
function warn(ctx: Context, message: string): void {
  const text = `[dsh-notebook] ${message}`
  const logger = ctx.logger as { warn?: (value: string) => void } | undefined
  if (logger && typeof logger.warn === 'function') {
    logger.warn(text)
    return
  }
  console.warn(text)
}

/**
 * Mount the host half on a Cordis context.
 *
 * Route registration is wrapped in `ctx.effect` so HMR / plugin reload disposes
 * the previous registration instead of throwing "already registered".
 */
export function apply(ctx: Context, config: Config = {}): void {
  const homeDir = resolveHomeDir(typeof config?.homeDir === 'string' ? config.homeDir : undefined)
  const paths = notebookPaths(homeDir)
  const store = createNotebookStore({
    homeDir,
    warn: (message) => warn(ctx, message),
  })
  const version = resolveVersion()
  const maxBodyBytes =
    typeof config?.maxNoteBytes === 'number' && config.maxNoteBytes > 0 ? config.maxNoteBytes : MAX_REQUEST_BYTES
  const route = createNotebookRouter({
    store,
    root: paths.attachmentsDir,
    version,
    maxBodyBytes,
  })

  // The web server owns the full response lifecycle; `route` answers `false`
  // only for paths outside our prefix, which cannot normally happen here.
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const handled = await route(req, res)
    if (!handled && !res.headersSent) {
      res.statusCode = 404
      res.end()
    }
  }

  const register = (host: Context, service: WebServer): void => {
    host.effect(() => {
      const dispose = service.register({ kind: 'prefix', path: NOTEBOOK_API_PREFIX, handler })
      return () => {
        dispose()
      }
    }, 'dsh-notebook: routes')
  }

  const service = ctx.get('webServer')
  if (service) {
    register(ctx, service)
    return
  }

  // No web server (yet): warn instead of throwing, and register as soon as the
  // service shows up. A DSH profile without the web carrier simply keeps the
  // host half idle — the plugin must not fail to load.
  warn(ctx, `webServer service is not available yet; ${NOTEBOOK_API_PREFIX} will be registered when it appears`)
  ctx.inject(['webServer'], (webCtx) => {
    register(webCtx, webCtx.webServer)
  })
}
