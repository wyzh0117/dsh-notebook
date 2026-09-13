/**
 * tsdown build for dsh-notebook — two artifacts, one per plugin half:
 *
 * - **host half** (`lib/index.js`, ESM/node): the cordis plugin entry
 *   (`src/index.ts`) that owns the notebook HTTP API. Every bare specifier
 *   (node builtins and `@deepseek-ai/*` peers) stays external; the package is
 *   installed into a DSH profile whose `node_modules` already provides them.
 *
 * - **client half** (`lib/client.js`, CJS closure factory): a browser bundle
 *   that replicates the official DSH client-bundle preset. It is *not* plain
 *   ESM — the web shell loads it through `window.__ModuleLoader__.load({id,
 *   factory})`, so the artifact must be a single CJS factory closure that
 *   registers itself, with `require` resolving only module-table entries.
 *   Consequences, all load-bearing:
 *   * `codeSplitting: false` — the factory's `require` cannot resolve relative
 *     chunk URLs in the browser, so everything must land in one script;
 *   * module-table specifiers (`react`, `cordis`, the listed `@deepseek-ai/*`
 *     runtime packages) stay external and are resolved by the shell;
 *   * everything else (our own code, any helper library) inlines;
 *   * no `node:*` import may survive into the bundle.
 *
 * The registered bundle id **must** equal the package name (`dsh-notebook`):
 * the client-modules compose keys on it.
 *
 * Declarations ship from `lib/types` via `tsc -p tsconfig.build.json`, not
 * from tsdown (`dts: false` in both configs).
 */
import { isAbsolute } from 'node:path'
import type { UserConfig } from 'tsdown'

/**
 * Module specifiers the web shell shares into the frozen module table. These
 * must stay external so the bundle uses the shell's single React/runtime
 * instance; anything else is inlined.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

/** Registered bundle id — keep in sync with `package.json` `name`. */
const BUNDLE_ID = 'dsh-notebook'

/**
 * Host half: `src/index.ts` → `lib/index.js` (ESM, node).
 *
 * Anything that is not a relative/absolute path is left external — node
 * builtins and every `@deepseek-ai/*` peer the DSH host loader provides.
 */
const hostConfig: UserConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: false,
  clean: false,
  // tsdown's default ESM extension is `.mjs`; the packed entry point is
  // `lib/index.js` (see `main`/`exports` in package.json), so pin it.
  outExtensions: () => ({ js: '.js' }),
  external: (id: string) => !id.startsWith('.') && !isAbsolute(id),
}

/**
 * Client half: `src/client/index.tsx` → `lib/client.js` (CJS closure factory).
 */
const clientConfig: UserConfig = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
    'import.meta.resolve': 'undefined',
  },
  // CJS output otherwise makes some transitive packages resolve their node
  // entry even though this bundle only ever runs in a browser.
  inputOptions: {
    resolve: {
      conditionNames: ['browser', 'import', 'require', 'default'],
    },
  },
  // Module-table entries stay external; every other dependency inlines.
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  outputOptions: {
    entryFileNames: 'client.js',
    // The factory's `require` only resolves module-table entries; it cannot
    // load relative chunk URLs, so the artifact must be one single script.
    codeSplitting: false,
    banner: `window.__ModuleLoader__.load({ id: "${BUNDLE_ID}", factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}

export default [hostConfig, clientConfig]
