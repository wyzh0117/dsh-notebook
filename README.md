<div align="center">

# dsh-notebook

**A notebook in DSH's sidebar.**

`+` a note → title + body → paste images → **Done** files it under its title.
Click a title to copy the body · type `@` to reference a note · **Edit** reuses the same container.

[![CI](https://github.com/wyzh0117/dsh-notebook/actions/workflows/ci.yml/badge.svg)](https://github.com/wyzh0117/dsh-notebook/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-3c873a.svg)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.1.1--rc.2-6b4fbb.svg)](#compatibility)
[![tests](https://img.shields.io/badge/tests-vitest-6da55f.svg)](./test)

`dsh-plugin` · `deepseek-harness` · `notebook` · `notes` · `sidebar`

</div>

**English** · [中文](./README.zh-CN.md)

**What's new**

- **v0.2.0** — the conversation can write notes too: select text for a floating **“To notebook”** action, or click the notebook icon at the end of any answer to save the whole reply. Both on by default.
- **v0.2.1** — the body box sizes itself: it grows as you type, shrinks as you delete, stops at 60 % of the window height.
- **v0.2.2** — no more native confirm prompts (a native modal can freeze an embedded host); every string follows the shell's language.
- **v0.2.3** — “Open the notebook for new sessions” now really opens the sidebar.

**Jump to** · [Features](#features) · [Install](#install) · [Usage](#usage) · [Compatibility](#compatibility) · [Settings](#settings) · [Under the hood](#under-the-hood) · [Limitations](#known-limitations) · [FAQ](#faq) · [Development](#development)

> **Suggested GitHub topics:** `dsh-plugin` `deepseek-harness` `notebook` `notes` `sidebar`

---

## What it is

`dsh-notebook` is a Web plugin for [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/dsh) that puts a small notebook in the sidebar.

It does one thing: jot down a note with a title, a body and a few images, then use it from the composer — click a title to copy the body, type `@` to reference a note.

No rich-text editor, no cloud sync, no version history. Notes are **global** (not per conversation) and images are stored as **real files on the host disk**.

## Features

| Feature | Detail |
|---|---|
| **`+` creates an entry** | Top-right of the panel; the editor opens **inside the panel** — no new window, no second tab |
| **Title + body + images** | Single-line title, content-sized body, image thumbnail strip in one scrollable container |
| **Images yes, videos no** | Paste, drag & drop and “Insert image” share one validation path: `video/*` and `mp4/mov/webm/mkv/avi/m4v/ogv` are refused inline |
| **“Done” files it under its title** | The list shows one row per note, newest first, with “time · N images” as secondary metadata |
| **Click the title to copy** | Copies the **body only** — never the title — with images as `[image: name]` lines and a “body copied (N chars)” toast. It never writes into the composer |
| **`@`-reference a note** | Typing `@` lists notes under the localized “Notebook” heading (title + snippet, newest first, max 8). Picking one inserts an atomic chip; only the **body** reaches the model |
| **“Reference” row button** | Same as an `@` pick, from the row itself; with no reachable composer it says so instead of pretending |
| **Select text → “To notebook”** (v0.2.0, on) | A floating action beside the selection files it verbatim as a note titled `未命名1`, `未命名2`, … Selections inside the composer or in the panel itself are not offered |
| **Every answer → “save to notebook”** (v0.2.0, on) | One icon at the end of the answer's action row saves the whole reply, titled with the **session's own title** |
| **Both captures are switchable** | `selectionToNotebook` / `messageToNotebook` in settings; a change applies on the next render, no reload |
| **Auto-open for new sessions** (off by default) | Opens the Notebook whenever a session becomes current — including the one a page load restores. All three tiers honour it |
| **“Edit” reuses the same container** | The DOM never holds more than one editor |
| **Images land on disk** | Uploaded as `dataURL`, decoded by the host into `$DSH_HOME/storages/notebook-attachments/<noteId>/`; deleting a note deletes them too |
| **Atomic writes, no silent loss** | Temp file → `fsync` → `.bak` → `rename`, serialized by a mutex. If `$DSH_HOME` is not writable the host degrades to memory and every response carries `degraded: true`, which the UI shows as a banner |
| **Keyboard** | `Cmd/Ctrl+Enter` = Done, `Esc` = Cancel (a dirty draft asks first) |

Longer, deeper notes on the design live in [Under the hood](#under-the-hood).

## Screenshots

> Real screenshots from a live run — the tier 3 rows come from an environment with no sidebar product installed.

| | |
|---|---|
| ![Notebook panel](docs/images/panel-open.png) | ![Editor container](docs/images/editor.png) |
| The Notebook list in the sidebar (`+` in the top-right); expanding pushes the conversation column 400 px | The editor container: title, body and image thumbnails (paste / drop / picker) |
| ![Copy body](docs/images/list-and-copy.png) | ![Standalone panel](docs/images/collapsed-button.png) |
| The “body copied” toast after clicking a title — the body only, never the title | The self-drawn panel (tier 3): the toggle is pinned to the viewport's top-right corner |

Folded into `dsh-better-sidebar` instead (tier 2) — see [Compatibility](#compatibility):

![Notebook inside better-sidebar](docs/images/tier2-better-sidebar.png)

## Install

| | |
|---|---|
| DSH | `>=0.1.1-rc.2` |
| Node | `>=20` |
| Package manager | **pnpm** — this repo does not support npm |

**From the repository:**

```sh
dsh plugin --profile web add github:wyzh0117/dsh-notebook
```

**From source (development):**

```sh
git clone https://github.com/wyzh0117/dsh-notebook.git
cd dsh-notebook
pnpm install
pnpm build            # emits lib/index.js, lib/client.js, lib/types/**

dsh plugin --profile web add "link:$PWD"
```

The manual equivalent — in `~/.dsh/profiles/web/package.json`:

```jsonc
{
  "dependencies": { "dsh-notebook": "link:/abs/path/to/dsh-notebook" },
  "dsh": { "profile": { "bundles": [ /* … */, "dsh-notebook" ] } }
}
```

Then `pnpm install` inside the profile directory. `dsh.profile.bundles` must contain `dsh-notebook`, otherwise the plugin is never loaded.

> **While developing, never restart the DSH instance you are working in** (e.g. the Web GUI on port 3080 — restarting it kills the current session). For a real end-to-end check, start an isolated environment:
> ```sh
> DSH_HOME=/tmp/dshnb-home npx -y --package @deepseek-ai/dsh dsh web --port 3099
> ```

## Usage

1. Expand the right sidebar and open **Notebook**.
2. Click **`+`** in the top-right — the editor opens inside the panel.
3. Write a **title** and a **body**. The body box follows its content (up to 60 % of the window height, then it scrolls inside). Add images by pasting, dropping, or “Insert image” — videos are refused; one image is capped at 10 MB and a note at 20 images (both adjustable).
4. Click **Done** (or `Cmd/Ctrl+Enter`) — the note is filed under its **title**.
5. Click the **title text** to copy the body to the clipboard.
6. To let the model read a note, type **`@`** in the composer and pick it, or click **`Reference`** at the end of its row. Only the **body** is sent; re-insert a reference after a page reload.
7. **`Edit`** reloads a note into the same container; **`Delete`** asks in the panel's own dialog first.
8. Let the conversation write notes for you (v0.2.0):
   - **Select text in the session** → click the floating **“To notebook”** action.
   - **Click the notebook icon at the end of an answer** → the whole reply is saved under the session's title.

   Both confirm with the same toast and can be switched off in settings.

## Compatibility

| | |
|---|---|
| DSH | Minimum `>=0.1.1-rc.2`; the development machine runs `0.1.5-rc.2` with `@deepseek-ai/dsh-client-ui-sidebar-right`, where **tier 1 is the live tier** |
| Node | `>=20` |
| `dsh-better-sidebar` | Optional. Tier 2 targets 0.4.0–0.18.x; 0.19+ is handled by tier 1 |
| Optional DSH plugins | Without `conversation`, `inputTriggers` or `sessions`, the matching integration simply turns off and the v1 behaviour returns |
| Older shells | Every feature registers through optional seams and degrades instead of breaking: a missing slot means the capture entry never appears, an unreadable locale falls back to the plugin's own `zh` dictionaries, and the panel keeps rendering without `window.confirm` or any dialog API |

### How it adapts — the three tiers

DSH's right column changed owner around `0.1.5-rc.1`: before that, plugins such as `dsh-better-sidebar` drew it themselves; afterwards DSH owns it and plugins register tabs. So the client probes once and settles on one of three tiers — **at most one Notebook entry exists on the page**:

| Priority | Tier | Trigger | Registration |
|---|---|---|---|
| 1 | **`native`** | `ctx.get('sidebarRightTabs')` exists (DSH ≥ 0.1.5-rc.1) | `sidebarRightTabs.register({ id, kind, priority:'extension', title, guide })` + the tab body into the keyed slot `sidebar.right.pane.tab` |
| 2 | **`service`** | `ctx.get('betterSidebar')` exists (better-sidebar 0.4.0–0.18.x and similar) | `ctx.betterSidebar.registerTab({ id:'dsh-notebook:notebook', single:true, settings:{…} })` |
| 3 | **`standalone`** | neither of the above | Draws its own right panel, matched to `dsh-better-sidebar` 0.12.1 |

Deliberate choices:

- `betterSidebar` is **never** in `export const inject` — a missing service in `inject` would stop the plugin from activating and kill tier 3.
- Detection is “sync first, async fallback”: if neither `ctx.get` hits, the plugin watches `ctx.inject` and arms a **700 ms fallback timer** that mounts standalone.
- **Late upgrade**: a service appearing after standalone is mounted tears standalone down *first*; the two are never live at once.
- Every registration sits in `ctx.effect(() => { …; return dispose })`, so HMR and disable are clean.

### The tier-3 self-drawn panel

| Item | Spec |
|---|---|
| Expand button | 28×28, pinned to the viewport's top-right corner, 16 px linear icon, delayed tooltip, state-following `aria-label` |
| Geometry | `PANEL_MIN=280` / `PANEL_MAX=640` / `PANEL_DEFAULT=400`, clamped against the viewport |
| Width drag | 6 px grab strip on the panel's left edge (`setPointerCapture` + `clientX` delta) |
| Narrow viewport | `innerWidth < 768` becomes a full-width `100vw` drawer with no drag strip |
| Layout push | Sets `--dsh-notebook-width` and `data-dsh-notebook-collapsed` / `-dragging`, consumed by one namespaced `<style>` removed on dispose |
| Collapse | Stays mounted and slides out (`translateX(100%)`); `visibility: hidden` only after the transition |
| Persistence | Open state and width in `localStorage` (`dsh-notebook:open` / `dsh-notebook:width`) |
| Reduced motion | Honours `@media (prefers-reduced-motion: reduce)` |

## Settings

All three tiers share **one definition**, whose source of truth is the host's `NotebookDoc.prefs` — reads and writes always go through `PATCH /notebook/api/prefs` (tier 2 deliberately does not use better-sidebar's own `pluginSettings`, which would let the tiers drift apart).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `sortOrder` | `'updated' \| 'created' \| 'title'` | `'updated'` | List ordering |
| `copyImagesAsName` | boolean | `true` | Render images as a `[image: <name>]` line when copying |
| `maxImagesPerNote` | number | `20` | Image cap per note (1–100) |
| `confirmDelete` | boolean | `true` | Ask before deleting, in the panel's own dialog; off deletes on the click |
| `openOnStart` | boolean | `false` | **tier 3 only**: expand the sidebar on DSH startup |
| `autoOpenOnNewSession` | boolean | `false` | Open the Notebook whenever a session becomes current |
| `selectionToNotebook` | boolean | `true` | Show the floating “to notebook” action over a text selection |
| `messageToNotebook` | boolean | `true` | Show the “save to notebook” icon at the end of every answer |

Tiers 1 and 3 register the same global settings section (`settings.section`, shared through `hosts/settingsSeat.ts`), so their fields and copy are identical; tier 2 goes through `registerTab({ settings })`, whose inventory is seven rows — every preference except `openOnStart`, which only means something in the standalone tier.

## Under the hood

Everything below is for people reading or changing the code. Skip to [Known limitations](#known-limitations) if you just want to use the plugin.

### Architecture

```
                     ┌─────────────────────────── browser ───────────────────────────┐
                     │ lib/client.js  (CJS module-table factory, id = "dsh-notebook")│
                     │  three-tier detect → native / service / standalone            │
                     │  NotebookView ─ NotebookEditor(one instance) ─ clipboard      │
                     │  capture (v0.2.0): selection pill + answer icon → capture.ts  │
                     │  body sizing (v0.2.1): textarea → autoGrow.ts                 │
                     │  dialogs (v0.2.2): in-panel prompts → locales.ts              │
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

- `src/client/autoGrow.ts` is the only place the body box's geometry is decided: it measures the `<textarea>` against its content and writes `height` / `maxHeight` / `overflowY`, while `NotebookEditor` decides *when* (mount, text change, width change, viewport-height change).
- In the native tier the tab body reads visibility from the slot's injected `useTabInfo()` hook, so a **hidden tab really does skip loading and polling**.
- Images are uploaded as **dataURL** (client-side `FileReader`) and decoded by the host — no multipart parser dependency.

### Host HTTP API

Registered on `ctx.webServer` (`kind: 'prefix'`, `path: '/notebook/api'`), JSON over HTTP, with `Cache-Control: no-store` on every response.

| Method | Path | Request | Response |
|---|---|---|---|
| `GET` | `/notebook/api/state` | — | `{ doc, degraded? }` |
| `POST` | `/notebook/api/notes` | `{ title, body, attachments: [{ name, mime, size, dataUrl }] }` | `{ note }` |
| `PATCH` | `/notebook/api/notes/:id` | `{ title?, body?, attachments? }` | `{ note }` |
| `DELETE` | `/notebook/api/notes/:id` | — | `{ ok: true }` |
| `PATCH` | `/notebook/api/prefs` | `Partial<NotebookPrefs>` | `{ prefs }` |
| `GET` | `/notebook/api/attachments/:noteId/:file` | — | image bytes + `Content-Type` |
| `GET` | `/notebook/api/health` | — | `{ ok, version, degraded }` |

- **Security fence**: only loopback requests are accepted (`req.socket.remoteAddress ∈ 127.0.0.1/::1`) and `Origin`/`Host` must be an allowed local origin, otherwise `403`; path parameters are traversal-checked; request bodies are capped at 32 MB (`413`).
- `400/403/404/413/415/500` all return a structured `{ error: { code, message } }`.
- **The host re-checks for video** (it does not trust the client) and answers `415`.

### On-disk layout

| Path | Contents |
|---|---|
| `$DSH_HOME/storages/notebook.json` | `NotebookDoc` (`version: 1`, `notes[]`, `prefs`), written atomically |
| `$DSH_HOME/storages/notebook.json.bak` | The last known-good version; tried first when the JSON is corrupt |
| `$DSH_HOME/storages/notebook-attachments/<noteId>/<attachmentId>.<ext>` | Image bytes |

`$DSH_HOME` resolution order: explicit injection > `process.env.DSH_HOME` (whitespace-only counts as unset) > `~/.dsh`. If `.bak` is corrupt too, the store starts from an empty document and renames the broken file to `notebook.json.corrupt-<ts>`.

### Session integration (v1.1)

Every seam here is **public and entirely optional**: the client bundle can only `require` module-table entries, never import a DSH UI package, so every member is duck-typed and every call is guarded.

**`@` references.** The plugin registers a `@` source named `dsh-notebook` through `ctx.inputTriggers.registerSource` (`order: 20`), so typing `@` lists notes next to files and sessions. Candidates are filtered case-insensitively on title and body, newest first, at most 8 rows; an aborted query or a failed read yields no rows rather than breaking the menu. Picking a row inserts an atomic chip whose clipboard form is `@[title](dsh-notebook:<noteId>)`. At send time the note's **body only** is serialized (the title is deliberately never sent), each image marker becoming one `[image: <name>]` line: a **deleted note** contributes nothing, while a **real read failure** blocks the send with a visible error instead of silently downgrading the mention.

**Auto-open.** The watcher fires when the current session **becomes a different one**; a re-published snapshot of the same session does not count, and neither does the session already current at activation. `openTab` can throw while the seat holds no binding, so the open is retried at `0 / 200 / 500 / 1200 / 2500 ms` and abandoned the moment the session changes again. Since the plugin activates before the session list arrives, the selection a page load restores also counts as “becoming current”.

**The composer attachment bridge is implemented, unit-tested and deliberately unwired.** Clicking a title must only copy, never write into the composer, so its only entry point was removed (product decision, 2026-09-15). The seams are the expensive part and are already covered, so `composer.ts` and its tests are kept on purpose, waiting for an explicit action of their own. No UI can trigger it today.

**Why the open is the reveal (the v0.2.2 bug, the v0.2.3 fix).** `sidebarRight.openTab(kind)` expands the column as part of the open (its first planned store op is `planSetExpanded(state, true)`), while `isExpanded()` answers from the surface bound at the seat's **last committed render** — so a read in the same synchronous block as `openTab()` is one React commit behind. v0.2.2 read that stale `false` and then “corrected” it with `toggleExpanded()`, which flips the **live** value and collapsed the column the open had just revealed. DSH publishes no idempotent `setExpanded()`, so there is no safe correction from outside: the plugin now calls `openTab` alone, and `test/auto-open.test.ts` models the host's real semantics and asserts the panel ends expanded with zero `isExpanded` / `toggleExpanded` calls.

### Capturing from the conversation (v0.2.0)

Two ways for the conversation to fill the notebook, both tier-independent (they belong to the shell, not to a sidebar carrier) and both on by default. They share one write path — `client/capture.ts` — so title numbering, save ordering and the toast cannot drift apart.

```
selection ──► selectionAction.ts ─┐
                                  ├──► capture.ts ──► POST /notebook/api/notes ──► NotebookDoc.notes
assistant answer ──► answerAction.ts ─┘        (title minting · serialized writes · subscribers · toasts)
```

| | Select text → notebook | Answer → notebook |
|---|---|---|
| Entry point | A floating pill beside the selection (`shell.overlay`) | One extra icon at the end of a finalized message's action row |
| Preference | `selectionToNotebook` | `messageToNotebook` |
| Title | The numbered default `未命名n` — the smallest `n` no existing title uses, so deleting `未命名2` hands the next capture that slot | The **session's own title**; with none yet, the numbered default instead of a placeholder the user never chose |
| Body | The selection **verbatim** (no trimming) | Every `text` block in order, joined by a blank line; `reasoning`, `tool-call` and `image` blocks are left out |
| Refuses | Empty/whitespace-only selections; selections inside the composer, any editable control, or this plugin's own panel; selections outside the conversation | Nothing to offer without a readable snapshot, or on a row with no usable message id (an interrupted answer carries none) |

**Where the action lands in the row.** The DSH slot renders inside the message row's extension band, between the hardcoded **Copy** and **Branch** buttons. `order: 20` puts this plugin after the shipped good-response pair, so the icon is the last entry *the slot can express* — it cannot be placed after Branch.

**Numbering is owned by the capture service.** A title is chosen from the notes the host holds **plus** the titles this activation already minted, and is held until its request settles: consecutive captures never collide even when the note list is unreadable, while a failed save releases its number so a retry mints the same one. Saves are serialized, so that read-modify-write cannot interleave.

**Selection scope, honestly.** DSH exposes no selection service, so the feature watches the document itself and decides what counts as “in the session” from the shell's semantic DOM hooks (`[data-chat-flow]`, `[data-conversation-scroll]`, then `[data-slot=…]`). A future shell that renames them degrades to “anywhere outside the composer and outside our own panel” instead of silently never firing.

## Known limitations

Deliberately out of scope for v1 / v1.1 / v0.2.0–v0.2.3.

- **No video / audio or other rich media** — an explicit requirement; both the client and the host reject it.
- No multi-user, cloud sync, sharing, live collaboration or AI auto-organising, and **no version history** (only the most recent content is kept).
- Notes are **global**, not isolated per conversation.
- **The body box stops at 60 % of the viewport height**: a longer note scrolls inside its own box. An unbounded box would push the title and the Done / Cancel row off the panel, at the cost of never showing a very long note in full while editing. The hand-picked height went away with the drag handle rather than becoming a per-note setting.
- The body is **plain text plus Markdown image markers** (`![name](attachment:<id>)`), not rich text.
- **A reference sends the body, never the title** — the title in `@[title](…)` is a human-facing label dropped at serialization time.
- **An unsent `@` reference degrades to a literal mention after a page reload**: DSH persists unsent drafts as their clipboard projection in `localStorage`, and this plugin has no host-side mention resolver, so the model receives the literal `@[title](dsh-notebook:<noteId>)`. Workaround: send before reloading, or re-insert the reference. A host-half expander on the `agent/pre-step` seam is the identified fix, deliberately left out of v1.1.
- **SVG cannot ride the composer attachment bridge** (png/jpeg/webp/gif only). Notes themselves still support SVG; the bridge has no UI entry point anyway.
- **“Open the notebook for new sessions” is inert on a carrier that cannot open anything**, and DSH force-collapses the right column on a very narrow window even after the tab is placed — the host's decision, and one this plugin deliberately does not fight.
- **The answer icon cannot sit after “branch”**: the slot renders in the extension band, so `order: 20` is the last position it can express.
- **An answer is saved as prose, not as a transcript**: only `text` blocks are stored, and images rendered in an answer are **not** copied into the note.
- **The selection pill follows the shell's DOM hooks**, so a future shell that renames them degrades the scope rather than breaking; it cannot offer the action for a *stale* selection whose geometry the browser no longer reports.
- **A captured note is written immediately, with no confirmation step** — the point of the two actions, but a mis-click files a note the user then deletes by hand.
- The **v1.1 session behaviours and v0.2.0 capture surfaces have not been clicked through a GUI**: their contracts were read from the published `0.1.5-rc.2` packages and are pinned by unit / component tests (see [Verification status](#verification-status)).
- DSH source is never modified (hard constraint).

## FAQ

**I dropped an mp4 — nothing happened.**
Video is not supported. Both the client and the host reject it and show “video files are not supported”.

**Why does the copied body contain `[image: name]` instead of the picture?**
The clipboard gets plain text, and images are files on disk. Turn `copyImagesAsName` off to drop the markers entirely instead.

**Does clicking a title send the note's images into the composer?**
No. The attachment bridge is implemented but unwired, and **no UI can trigger it today**: clicking a title always just copies the body to the clipboard.

**What does an `@` reference actually send?**
The body only — the chip shows the title, but the title is never handed to the model. A deleted note contributes nothing, and a real read failure blocks the send with a visible error.

**Why did my `@` reference turn into `@[title](dsh-notebook:xxx)` after a reload?**
DSH persists an unsent draft as its clipboard projection in `localStorage` and this plugin has no host-side mention resolver, so the chip degrades to literal text. Send before reloading, or re-insert the reference.

**Where are my notes stored? Is anything uploaded?**
Entirely on your machine under `$DSH_HOME/storages/`. Nothing is uploaded, and the HTTP API only listens on loopback.

**I selected text but no “to notebook” button appeared.**
Four deliberate refusals: the selection is empty or whitespace-only; it is inside the composer or any editable control (a prompt draft is not a note); it is inside the Notebook panel itself; or the browser reports no geometry for it. Selections made outside the conversation are not offered while the shell exposes its transcript container. If it still never appears, check “Save selected text to the notebook” in settings.

**Which part of an answer gets saved, and where does the title come from?**
The prose: every `text` block in order, joined by a blank line (an answer that is only tool calls says so instead of writing an empty note). The title is the **session's own title**, or the numbered default when the session has none. The note then behaves like any other.

**Can images get lost?**
Not silently. A failed upload keeps the entry as an error item you can retry; an unwritable `$DSH_HOME` degrades the store to memory with `degraded: true` on every response, surfaced as a banner.

**Can I run this alongside better-sidebar? Will tier 1 work on my machine?**
Yes — that is tier 2. As for tier 1: on a DSH older than `0.1.5-rc.1` there is no `ctx.sidebarRightTabs`, so the plugin falls back to tier 2 or 3.

**`pnpm install` fails with `ERR_PNPM_NO_MATCHING_VERSION: @deepseek-ai/dsh-*`?**
That is pnpm auto-installing peers. The root `pnpm-workspace.yaml` sets `autoInstallPeers: false` (pnpm 11 reads project settings from there); add the same setting if you replicate the package config elsewhere.

## Development

```sh
pnpm install        # pnpm only; npm is unsupported in this repo
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run (node env for the host half, jsdom for *.test.tsx)
pnpm build          # tsc -p tsconfig.build.json && tsdown → lib/index.js + lib/client.js + lib/types/**
pnpm watch          # tsdown --watch
```

`pnpm-workspace.yaml`'s single setting is `autoInstallPeers: false`, because `dsh-better-sidebar` is an *optional* peer that pnpm tries to resolve anyway, picks 0.19.x, and then cannot satisfy (`^0.1.5` is only published as a prerelease, and semver never matches a prerelease against a non-prerelease range). Every peer this repo builds against is an explicit `devDependencies` entry, so disabling peer auto-install costs nothing.

The client artifact is **not** plain ESM — it is a CJS closure factory registered with the global module loader:

```js
window.__ModuleLoader__.load({ id: "dsh-notebook", factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  /* …bundled CJS code… */
  exports.apply = apply; exports.inject = inject;
  return module.exports;
} });
```

Therefore `src/client/**` may **not** import `node:*`, and may **not** import any `@deepseek-ai/*` package as a **value** except the module-table entries (`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`). `codeSplitting: false` is required too — the factory's `require` cannot resolve relative chunk URLs.

### Verification status

| Item | How | Result |
|---|---|---|
| `tsc --noEmit` | whole repo | 0 errors |
| Unit / component tests | `vitest run` | **312 passed (20 files)** |
| Build | `tsc -p tsconfig.build.json && tsdown` | `lib/index.js` (ESM) + `lib/client.js` (CJS) + map + `lib/types/**` |
| Client bundle shape | CI executes `lib/client.js` against a stub `require` | `id=dsh-notebook`, `inject===['slots','locale']`, zero `node:` requires |
| **Tier 3** (no sidebar product) | real browser | toggle pinned to the viewport corner; expanding sets `--dsh-notebook-width: 400px` and pushes `#root` by 400 px; 6 px drag strip; collapse animates out and the push returns to zero |
| **Tier 3 core flow** | real browser, item by item | one editor container; png accepted, mp4 rejected; “Done” files the note; clicking the title put the **body (no title)** on the clipboard with images as `[image: nb-test-image.png]`; “Edit” reopened the same container fully restored |
| **Tier 2** (`dsh-better-sidebar@0.12.1`) | real browser | the self-drawn panel is not mounted; better-sidebar's “New tab” shows **Notebook**, rendering this plugin against the same global notes |
| Persistence | restart + reinstall through another channel | `notebook.json`, `.bak` and the attachment directory land correctly and survive a release-tarball install |
| Release artifact | release tarball into a clean profile | `dsh plugin` mounts it; host routes and client bundle both work |
| CI | GitHub Actions | green |
| **v1.1 artifact is served** (running 3080 instance) | `GET /plugins/??dsh-notebook/client.js&rev=<hash>` | **200**, carrying the v1.1 symbols while the retired attachment toasts no longer appear |
| **Host routes are online** | `GET /notebook/api/state`, `…/attachments/<noteId>/<file>` | `200 application/json` with the real document; attachment `200 image/png` |

Tier 1 has **not been clicked through a GUI**: its registration sequence is covered by `test/tier-detect.test.ts` with a fake ctx and was checked against the `0.1.5-rc.2` real type declarations (recorded in the header of `src/client/hosts/native.ts`). The same is true of the user-visible v1.1 capabilities (`@` reference, auto-open) and of v0.2.0's two capture surfaces — a live pass needs a rebuilt `lib/client.js` loaded by a refreshed page, which is the user's step, not something this repo's suite can assert. v0.2.1's body sizing, by contrast, **was confirmed in a real browser**: empty 120 px, 60 lines clamped to `round(929 × 0.6) = 557 px` with internal scrolling, back to 120 px on delete, the cap re-clamped on a viewport-height-only change, and an unrelated re-render leaving zero style writes.

<details>
<summary>Per-feature test coverage</summary>

| Feature | Tests | What they assert |
|---|---|---|
| Composer attachment bridge (**unwired, no UI**) | `composer.test.ts` (31); `view-actions.test.tsx` (7) asserts the **opposite** | Target resolution, images re-read into `File`s, the `createDrafts` + `addAttachments` sequence, drafts released on refusal, SVG skipped, the image cap, the three text-write paths, no invented success. UI level: clicking a title copies and leaves the composer completely alone |
| `@` reference + “Reference” | `reference.test.ts` (17) + `view-actions.test.tsx` (7) | Register once and dispose, refused-registration retries, filtering / ordering / the 8-row cap, the chip and canonical mention, **serialization carrying the body and never the title**, a deleted note serializing to nothing, a read failure propagating, `refUnavailable` |
| Auto-open for new sessions | `auto-open.test.ts` (16) + `tier-detect.test.ts` (16) + `native-tab-body.test.tsx` (3) | Nothing for the session already current, opening for the restored one, once per change, retries while the seat holds no binding, each tier's own gesture, and that the native gesture is `openTab` **alone** — expanded at the end, `isExpanded` never read, `toggleExpanded` never called |
| Capture: select → notebook | `selection-action.test.tsx` (35) + `capture.test.ts` (21) + `capture-surfaces.test.tsx` (19) | Scope resolution through the real DOM hooks, the refusals, edge clamping, the click not collapsing the selection first, verbatim text, one click → one note, the live pref gate |
| Capture: answer → notebook | `answer-action.test.ts` (18) + `capture-surfaces.test.tsx` (19) + `tier-detect.test.ts` (16) | Both snapshot shapes and version-skew shapes, no id-less match, `text` blocks only, the session title and its fallback, the empty-answer path, `order > 10` |
| Title minting + write ordering | `capture.test.ts` (21) | The smallest **free** number, no reuse across consecutive captures, call-order serialization, a failed save releasing its number, whitespace no-op |
| Body auto-grow | `auto-grow.test.ts` (12) + `editor-autogrow.test.tsx` (8) | The cap and its fallbacks, the `height: auto` reset that makes shrinking possible, the 120 px floor, `overflowY: auto` past the cap, idempotence, growth / shrink / re-measure against the real `<textarea>` |
| Confirm dialogs + language | `editor.test.tsx` (15) + `locales.test.ts` (10) + `capture-surfaces.test.tsx` (19) | The panel's own `alertdialog`, three ways to answer “no”, `confirmDelete` off deleting at once, one request per double click, and **`window.confirm` never called**; the locale read order and every fallback |
| Preferences over HTTP | `api.test.ts` (12) | Normalization, a **missing** preference defaulting to ON rather than being dropped, id encoding, the error envelope |

One drift guard is worth naming: `test/routes.test.ts`'s “accepts EVERY preference key the plugin exposes” asserts the key set accepted by `PATCH /notebook/api/prefs` equals `Object.keys(DEFAULT_PREFS)` — it is what caught the real bug where `/prefs` silently dropped `autoOpenOnNewSession`.

</details>

## Contributing

Issues and pull requests are welcome. Two house rules come first:

- **pnpm only.** `npm` and `yarn` are unsupported; a lockfile mismatch caused by another package manager is not something we can act on.
- **DSH source is never modified.** A hard constraint of the project, not a preference.

**The local gate** — CI runs exactly these on Node 22 (pnpm 11 itself needs Node ≥ 22.13, while the plugin still runs on the Node ≥ 20 that `engines` declares), plus executing `lib/client.js` against a stub `require` to assert the bundle shape:

```sh
pnpm install && pnpm typecheck && pnpm test && pnpm build
```

**Reporting a bug** — use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md). The fields that decide how fast a report can be acted on are the DSH version, the `dsh-better-sidebar` version (if installed), and **which tier was active** (`native` / `service` / `standalone`).

**Sending a PR** — the [PR template](.github/pull_request_template.md) carries the checklist. In short: paste the real `typecheck` / `test` / `build` output; say which parts the change touches (tier 1 / tier 2 / tier 3, the host half, or build / CI / docs only); and update both READMEs when user-visible behaviour or a setting changes.

**Constraints a PR must not break:**

- no video / audio support path — v1 explicitly excludes rich media, and both halves enforce the rejection;
- `cordis` (bare) must never be added to `dependencies` / `peerDependencies` / `optionalDependencies`;
- no `preinstall` / `install` / `postinstall` / `prepare` script;
- in `src/client/**`: no `node:*` import, and no `@deepseek-ai/*` **value** import outside the shared module table;
- the registered client bundle id must stay equal to the package name (`dsh-notebook`).

## Version history

| Milestone | State | Highlights |
|---|---|---|
| **v0.1.0** | tagged | The notebook itself: create / edit / delete, title + body, images with videos rejected, click-a-title-to-copy, the single reusable editor container, three-tier adaptation, atomic writes with `.bak` recovery, loopback-only HTTP API. |
| **v1.1** | merged on `main`, **not tagged** | `@` references and the in-row “Reference” button, auto-open for new sessions. The composer attachment bridge landed as code plus tests with **no UI entry point**. |
| **v0.2.0** | released | Conversation → notebook capture: the floating “to notebook” action over a selection and the “save to notebook” icon after every answer, sharing one serialized write path and both switchable. |
| **v0.2.1** | released | The body box sizes itself, with a 120 px floor and a 60 %-of-viewport cap; the manual drag handle is gone. |
| **v0.2.2** | released | Both confirm prompts move into the panel (no `window.confirm` anywhere), and every string follows the shell's language. |
| **v0.2.3** | this release | “Open the notebook for new sessions” really opens the sidebar — the read-then-`toggleExpanded()` that collapsed the freshly opened column is gone, and a session becoming current while the prefs are still loading is no longer dropped. |

`package.json` declares `0.2.3`; the v1.1 work shipped as part of v0.2.0 rather than under its own tag.

## License

[MIT](./LICENSE) © 2026 wyzh0117
