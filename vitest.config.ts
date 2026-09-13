import { defineConfig } from 'vitest/config'

/**
 * Two test projects, one per runtime the plugin runs in:
 *
 * - `host` — the node half (`src/index.ts`, `src/store.ts`, `src/routes.ts`,
 *   `src/attachments.ts` and the shared type module). Plain node environment;
 *   `test/routes.test.ts` binds a real `node:http` port.
 * - `client` — the browser half (React components, clipboard fallback,
 *   three-tier detection). jsdom environment so `document`, `window`,
 *   `localStorage`, `navigator` and pointer events exist.
 *
 * Vitest 4 removed `test.environmentMatchGlobs`, so the split is expressed
 * with `test.projects` (the supported replacement).
 *
 * JSX needs no transformer option here: Vitest 4 transforms with oxc, which
 * reads `jsx: "react-jsx"` straight from `tsconfig.json`. (Setting
 * `esbuild: { jsx: 'automatic' }` as well only earns a "both esbuild and oxc
 * options were set … esbuild options will be ignored" warning.)
 *
 * `globals: true` matters for more than convenience: React Testing Library
 * only installs its automatic `afterEach(cleanup)` when a global `afterEach`
 * exists, and `test/editor.test.tsx` asserts that exactly one editor
 * container is mounted at a time — a leaked render from a previous test would
 * make that assertion flaky. Test files still import the vitest API
 * explicitly (`import { describe, it, expect, vi } from 'vitest'`).
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'host',
          environment: 'node',
          globals: true,
          include: ['test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'client',
          environment: 'jsdom',
          globals: true,
          include: ['test/**/*.test.tsx'],
        },
      },
    ],
  },
})
