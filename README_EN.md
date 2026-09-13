<div align="center">

# dsh-notebook

**A sidebar notebook for DSH** — `+` a new entry → title + body → paste images (videos rejected) → “Done” files it under its title → click the title to copy the body → “Edit” reuses the very same container.

[![CI](https://github.com/wyzh0117/dsh-notebook/actions/workflows/ci.yml/badge.svg)](https://github.com/wyzh0117/dsh-notebook/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-3c873a.svg)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.1.1--rc.2-6b4fbb.svg)](#compatibility)
[![tests](https://img.shields.io/badge/tests-vitest-6da55f.svg)](./test)

`dsh-plugin` · `deepseek-harness` · `notebook` · `notes` · `sidebar`

</div>

> **Suggested GitHub topics:** `dsh-plugin` `deepseek-harness` `notebook` `notes` `sidebar`
>
> 中文文档见 [README.md](./README.md)。

---

## What it is

`dsh-notebook` is a Web plugin for [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/dsh): a small notebook that lives in the sidebar.
No rich-text editor, no cloud sync, no version history — it does one thing: jot down a note that has a title, a body and a few images,
and copy the body to the clipboard with a single click on the title.

Notes are **global** (not isolated per conversation) and images are stored as **real files on the host disk**, addressed by path.

## Features

| Feature | Detail |
|---|---|
| **`+` creates an entry** | The `+` sits in the top-right corner of the sidebar page; clicking it opens the editor container **inside the panel** (no new window, no second sidebar tab) |
| **Text container** | Single-line title `<input>` + body `<textarea>` + image thumbnail strip, sharing one scrollable container |
| **Images yes, videos no** | All three entry points share one validation path: paste (`onPaste`), drag & drop (`onDrop`), and the “Insert image” button (`<input type="file" accept="image/*" multiple>`). `video/*` MIME types and `mp4/mov/webm/mkv/avi/m4v/ogv` extensions are rejected inline with “video files are not supported”; anything that is not an image gets “only image files are supported” |
| **Title + body** | The title is what the list displays; the body carries the content |
| **“Done” files it under its title** | The container closes and the list shows one row per note, titled, newest first, with “time · N images” as secondary metadata |
| **Click the title to copy** | The clipboard receives the **body only** (**never the title**); image markers become a `[image: <name>]` line. A 2-second toast confirms “body copied (N chars)” |
| **“Edit” reuses the same container** | The list’s “Edit” button loads that note into the **one and only** `<NotebookEditor>` instance (title, body and thumbnails restored); the DOM never holds more than one editor container |
| **Images land on disk** | Uploaded as `dataURL`, decoded by the host into `$DSH_HOME/storages/notebook-attachments/<noteId>/`; deleting a note deletes its attachment directory too |
| **Atomic writes + serialization** | `notebook.json` is written to a temp file → `fsync` → previous version copied to `.bak` → `rename`; a single in-process mutex serializes every read-modify-write |
| **No silent data loss** | If `$DSH_HOME` is not writable the host degrades to an in-memory store and every API response carries `degraded: true`; the client shows a non-blocking banner |
| **Keyboard** | `Cmd/Ctrl+Enter` = Done, `Esc` = Cancel |

## Three-tier adaptive behaviour (the core design)

DSH’s right column changed owner around 0.1.5-rc.1. Before that, plugins such as `dsh-better-sidebar` drew it themselves;
afterwards DSH owns it and plugins register tabs through `ctx.sidebarRightTabs`. So the client probes once and settles on
one of three tiers — **at most one Notebook entry may exist on the page at any moment**:

| Priority | Tier | Trigger | Registration |
|---|---|---|---|
| 1 | **`native`** | `ctx.get('sidebarRightTabs')` exists (DSH ≥ 0.1.5-rc.1) | Two-phase native registration: `sidebarRightTabs.register({ id, kind, priority:'extension', title, guide })`, then the tab body into the keyed slot `sidebar.right.pane.tab` (same `id` as the key) |
| 2 | **`service`** | `ctx.get('betterSidebar')` exists (better-sidebar 0.4.0–0.18.x and similar products) | `ctx.betterSidebar.registerTab({ id:'dsh-notebook:notebook', …, single:true, settings:{ pluginToggles, render } })` |
| 3 | **`standalone`** | neither of the above | Draws its own right panel (UI matched to `dsh-better-sidebar` 0.12.1) and registers its own settings section |

Deliberate choices:

- `export const inject = ['slots', 'locale']` — `betterSidebar` is **never** listed in `inject`. A missing service in `inject`
  means the plugin never activates, which would kill tier 3 entirely.
- Detection is “sync first, async fallback”: when both `ctx.get` calls miss, the plugin registers `ctx.inject([...], cb)`
  observers and arms a **700 ms fallback timer**; if no tier has appeared when it fires, standalone is mounted.
- **Late upgrade**: if standalone is already mounted and a service shows up afterwards, standalone is torn down *first*
  and the service registration happens after it — the two are never live at once.
- Every registration sits inside `ctx.effect(() => { …; return dispose })`, so HMR and disable are clean and a second
  activation never throws `already registered`.

### The tier-3 self-drawn panel (matched to better-sidebar 0.12.1)

| Item | Spec |
|---|---|
| Expand button | A 28×28 button pinned to the **viewport’s top-right corner**, 16 px linear panel icon, ~500 ms delayed tooltip, `aria-label` following the expanded state |
| Panel geometry | `PANEL_MIN=280` / `PANEL_MAX=640` / `PANEL_DEFAULT=400`, clamped with `Math.min(max, Math.max(280, round(w)))` |
| Width drag | A 6 px grab strip on the panel’s **left edge**; `setPointerCapture` then track the `clientX` delta |
| Narrow viewport | `innerWidth < 768` collapses to a full-width `100vw` drawer with no drag strip |
| Layout push | Sets `--dsh-notebook-width` plus `data-dsh-notebook-collapsed` / `data-dsh-notebook-dragging`, consumed by one namespaced `<style>` tag that is removed on dispose |
| Collapse | The panel **stays mounted** and slides out (`translateX(100%)`); `visibility: hidden` only after the transition ends |
| Persistence | Open state and width live in `localStorage` (`dsh-notebook:open` / `dsh-notebook:width`, every access wrapped in try/catch) |
| Reduced motion | Honours `@media (prefers-reduced-motion: reduce)` |

## Install

Requirements: Node ≥ 20, DSH ≥ 0.1.1-rc.2, and **pnpm** (this repo does not support npm).

### Option 1 — mount from source (development)

```sh
git clone https://github.com/wyzh0117/dsh-notebook.git
cd dsh-notebook
pnpm install
pnpm build            # emits lib/index.js, lib/client.js, lib/types/**

# mount it into a DSH profile (the web profile here)
dsh plugin --profile web add "link:$PWD"
```

The manual equivalent — in `~/.dsh/profiles/web/package.json`:

```jsonc
{
  "dependencies": { "dsh-notebook": "link:/abs/path/to/dsh-notebook" },
  "dsh": { "profile": { "bundles": [ /* … */, "dsh-notebook" ] } }
}
```

then run `pnpm install` inside the profile directory. `dsh.profile.bundles` must contain `dsh-notebook`,
otherwise the plugin is never loaded.

### Option 2 — install from the repository

```sh
dsh plugin --profile web add github:wyzh0117/dsh-notebook
```

> While developing, **never restart the DSH instance you are working in** (e.g. the Web GUI on port 3080 —
> restarting it kills the current session). For a real end-to-end check, start an isolated environment instead:
> ```sh
> DSH_HOME=/tmp/dshnb-home npx -y --package @deepseek-ai/dsh dsh web --port 3099
> ```

## Usage

1. Expand the right sidebar and open **Notebook**.
2. Click the **`+`** in the top-right corner — the editor container opens inside the panel.
3. Type a **title** and a **body**; add pictures by **pasting or dropping** them, or with “Insert image”.
   - Videos are rejected with “video files are not supported”; a single image is capped at 10 MB and a note at 20 images (adjustable in settings).
4. Click **Done** (or `Cmd/Ctrl+Enter`) — the container closes and the note is filed under its **title**.
5. Click the **title text** — the body (never the title) goes to your clipboard, with a “body copied (N chars)” toast.
6. Use **`Edit`** at the end of the row to load that note into the **same container**; **`Delete`** removes the note and its attachment directory.

## Architecture

```
                     ┌─────────────────────────── browser ───────────────────────────┐
                     │ lib/client.js  (CJS module-table factory, id = "dsh-notebook")│
                     │  three-tier detect → native / service / standalone            │
                     │  NotebookView ─ NotebookEditor(one instance) ─ clipboard      │
                     └──────────────────────────────┬────────────────────────────────┘
                                     fetch JSON      │
                     ┌──────────────────────────────┴────────────────────────────────┐
                     │ lib/index.js   (cordis plugin, ctx.webServer prefix)           │
                     │  routes.ts ─ store.ts (atomic write + mutex) ─ attachments.ts  │
                     └──────────────────────────────┬────────────────────────────────┘
                                                    │
                            $DSH_HOME/storages/notebook.json
                            $DSH_HOME/storages/notebook.json.bak
                            $DSH_HOME/storages/notebook-attachments/<noteId>/<attachmentId>.<ext>
```

### Host HTTP API

Registered on `ctx.webServer` (`kind: 'prefix'`, `path: '/notebook/api'`), JSON over HTTP,
with `Cache-Control: no-store` on **every** response.

| Method | Path | Request | Response |
|---|---|---|---|
| `GET` | `/notebook/api/state` | — | `{ doc, degraded? }` |
| `POST` | `/notebook/api/notes` | `{ title, body, attachments: [{ name, mime, size, dataUrl }] }` | `{ note }` |
| `PATCH` | `/notebook/api/notes/:id` | `{ title?, body?, attachments? }` | `{ note }` |
| `DELETE` | `/notebook/api/notes/:id` | — | `{ ok: true }` |
| `PATCH` | `/notebook/api/prefs` | `Partial<NotebookPrefs>` | `{ prefs }` |
| `GET` | `/notebook/api/attachments/:noteId/:file` | — | image bytes + `Content-Type` |
| `GET` | `/notebook/api/health` | — | `{ ok, version, degraded }` |

- Images are uploaded as **dataURL** (client-side `FileReader`) and decoded by the host — no multipart parser dependency.
- **Security fence**: only loopback requests are accepted (`req.socket.remoteAddress ∈ 127.0.0.1/::1`) and
  `Origin`/`Host` must be an allowed local origin, otherwise `403`; path parameters are traversal-checked
  (`path.resolve` must stay inside the attachments root). Request bodies are capped at 32 MB (`413` beyond that).
- `400/403/404/413/415/500` all return a structured `{ error: { code, message } }`.
- **The host re-checks for video** (it does not trust the client) and answers `415`.

### On-disk layout

| Path | Contents |
|---|---|
| `$DSH_HOME/storages/notebook.json` | `NotebookDoc` (`version: 1`, `notes[]`, `prefs`), written atomically |
| `$DSH_HOME/storages/notebook.json.bak` | The last known-good version; used first when the JSON is corrupt |
| `$DSH_HOME/storages/notebook-attachments/<noteId>/<attachmentId>.<ext>` | Image bytes |

`$DSH_HOME` resolution order: explicit injection > `process.env.DSH_HOME` (whitespace-only counts as unset) > `~/.dsh`.
If `.bak` is corrupt too the store starts from an empty document and renames the broken file to `notebook.json.corrupt-<ts>`.

## Settings

All three tiers share **one definition**, whose source of truth is the host’s `NotebookDoc.prefs`
(consistent across tiers and browsers). Reads and writes always go through `PATCH /notebook/api/prefs` —
tier 2 deliberately does **not** use better-sidebar’s own `pluginSettings`, which would let the tiers drift apart.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `sortOrder` | `'updated' \| 'created' \| 'title'` | `'updated'` | List ordering: recently updated / recently created / title ascending |
| `copyImagesAsName` | boolean | `true` | When copying, render images as a `[image: <name>]` line |
| `maxImagesPerNote` | number | `20` | Image cap per note (1–100) |
| `confirmDelete` | boolean | `true` | Ask before deleting |
| `openOnStart` | boolean | `false` | **tier 3 only**: expand the sidebar on DSH startup |

Where they surface: tier 1 in DSH’s native settings (`settings.plugin.item` slot); tier 2 through
`registerTab({ settings: { pluginToggles, render } })`; tier 3 through a self-registered settings section.

## Relationship to dsh-better-sidebar

- **This is not a fork of it, and it does not depend on it.** `dsh-better-sidebar` appears only in `peerDependencies`
  with `optional: true`, and the source contains **zero imports** of it (it duck-types `ctx.betterSidebar` instead),
  so two instances of it can never be pulled in.
- **With it installed (0.4.0–0.18.x)**: tier 2. Expanding its right sidebar shows Notebook **in addition to** its own
  editor / git / terminal / browser tabs. We deliberately avoid its reserved ids
  (`editor` `git` `subagent` `sidechat` `terminal` `browser` `diff`); ours is `dsh-notebook:notebook`.
- **With it at 0.19+ (the right column now belongs to DSH)**: tier 1 — the tab shows up in the column DSH itself draws.
- **With no sidebar product at all**: tier 3 — the plugin draws its own expandable right panel, matched to
  better-sidebar 0.12.1 (button placement, panel width and dragging, full-width narrow mode, collapse animation).

## Compatibility

| | |
|---|---|
| DSH | `>=0.1.1-rc.2` (the version verified on the development machine). Tier 1 needs DSH ≥ `0.1.5-rc.1` plus `@deepseek-ai/dsh-client-ui-sidebar-right` installed |
| Node | `>=20` (development and build) |
| `dsh-better-sidebar` | Optional. Tier 2 targets 0.4.0–0.18.x; 0.19+ is handled by tier 1 |

## Known limitations (deliberately out of scope for v1)

- **No video / audio or other rich media** — an explicit requirement. Both the client and the host reject it.
- No multi-user, cloud sync, sharing, live collaboration or AI auto-organising.
- **No version history**: only the most recent content is kept.
- Notes are **global**, not isolated per conversation.
- The body is **plain text plus Markdown image markers** (`![name](attachment:<id>)`), not rich text;
  no rich-text editor dependency is pulled in.
- Tier-1 code is written against the 0.1.5-rc.2 type declarations and covered by unit tests over the registration
  call sequence with a fake ctx; the development machine (0.1.1-rc.2) has no right-sidebar package, so **tier 1
  cannot be verified on real hardware here**.
- DSH source is never modified (hard constraint).

## Development

```sh
pnpm install        # pnpm only; npm is unsupported in this repo
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run (node env for the host half, jsdom for *.test.tsx)
pnpm build          # tsc -p tsconfig.build.json && tsdown → lib/index.js + lib/client.js + lib/types/**
pnpm watch          # tsdown --watch
```

The repo root carries a `pnpm-workspace.yaml` whose single setting is `autoInstallPeers: false`. Why: `dsh-better-sidebar` is an *optional* peer,
pnpm tries to resolve it anyway, picks 0.19.x, and then cannot satisfy that package’s `@deepseek-ai/*` peer ranges
(`^0.1.5`) — npm only publishes those as prereleases (`0.1.5-rc.2`), and semver never matches a prerelease against a
non-prerelease range, so the install dies with `ERR_PNPM_NO_MATCHING_VERSION`. Every peer this repo builds against is
an explicit `devDependencies` entry, so disabling peer auto-install costs nothing. See
[`docs/specs/scaffold-notes.md`](docs/specs/scaffold-notes.md).

The client artifact is **not** plain ESM — it is a CJS closure factory registered with the global module loader:

```js
window.__ModuleLoader__.load({ id: "dsh-notebook", factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  /* …bundled CJS code… */
  exports.apply = apply; exports.inject = inject;
  return module.exports;
} });
```

Therefore `src/client/**` may **not** import `node:*`, and may **not** import any `@deepseek-ai/*` package as a
**value** except the module-table entries (`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `cordis`,
`@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-web-react`,
`@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-schema-form`,
`@deepseek-ai/dsh-client-runtime/client`). `codeSplitting: false` is required too — the factory’s `require` cannot
resolve relative chunk URLs.

## Screenshots

> Real screenshots from a live run (DSH `0.1.1-rc.2`, no sidebar product installed — tier 3, the self-drawn panel):

| | |
|---|---|
| ![Notebook panel](docs/images/panel-open.png) | ![Editor container](docs/images/editor.png) |
| The Notebook list in the sidebar (`+` in the top-right); expanding pushes the conversation column 400px | The editor container: title, body and image thumbnails (paste / drop / picker) |
| ![Copy body](docs/images/list-and-copy.png) | ![Standalone panel](docs/images/collapsed-button.png) |
| The “body copied” toast after clicking a title — the body only, never the title | The self-drawn panel (tier 3): the toggle is pinned to the viewport's top-right corner |

## FAQ

**I dropped an mp4 — nothing happened.**
v1 does not support video. Both the client and the host reject it and show “video files are not supported”.

**Why does the copied body contain `[image: name]` instead of the picture?**
The clipboard gets plain text; images are files on disk and cannot travel as text, so they become a filename line.
Turn `copyImagesAsName` off in settings to drop the markers entirely instead.

**Where are my notes stored? Is anything uploaded?**
Entirely on your machine under `$DSH_HOME/storages/`. Nothing is uploaded anywhere, and the HTTP API only listens on loopback.

**Can images get lost?**
Not silently. A failed upload keeps the entry as an error item you can retry; if `$DSH_HOME` is not writable the
store degrades to memory and every API response carries `degraded: true`, which the UI surfaces as a banner.

**Can I run this alongside better-sidebar?**
Yes — that is exactly tier 2. Notebook shows up as one entry inside its right sidebar.

**Will tier 1 work on my machine?**
If your DSH is older than 0.1.5-rc.1 there is no `ctx.sidebarRightTabs`, so the plugin falls back to tier 2 or tier 3.

**`pnpm install` fails with `ERR_PNPM_NO_MATCHING_VERSION: @deepseek-ai/dsh-*`?**
That is pnpm auto-installing peers. This repo’s root `pnpm-workspace.yaml` sets `autoInstallPeers: false`
(pnpm 11 reads project settings from `pnpm-workspace.yaml`); add the same setting
if you replicate the package config elsewhere.

## License

[MIT](./LICENSE) © 2026 wyzh0117
