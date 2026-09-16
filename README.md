<div align="center">

# dsh-notebook

**A sidebar notebook for DSH** — `+` a new entry → title + body → paste images (videos rejected) → “Done” files it under its title → click the title to copy the body → reference notes with `@` → “Edit” reuses the very same container. **Since v0.2.0 the conversation can fill it for you:** select text and a floating “to notebook” action appears, and every answer carries a “save to notebook” icon that files the whole reply under the session's title. **Since v0.2.1 the body box sizes itself** — it grows while you write and shrinks when you delete. **v0.2.2 removes the native confirm prompts**: Delete and “discard this draft?” are asked by the panel's own dialogs (no `window.confirm`, which blocks the renderer and can freeze an embedded host), and every string follows the shell's language.

[![CI](https://github.com/wyzh0117/dsh-notebook/actions/workflows/ci.yml/badge.svg)](https://github.com/wyzh0117/dsh-notebook/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-3c873a.svg)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.1.1--rc.2-6b4fbb.svg)](#compatibility)
[![tests](https://img.shields.io/badge/tests-vitest-6da55f.svg)](./test)

`dsh-plugin` · `deepseek-harness` · `notebook` · `notes` · `sidebar`

</div>

**English** · [中文](./README.zh-CN.md)

> **Suggested GitHub topics:** `dsh-plugin` `deepseek-harness` `notebook` `notes` `sidebar`

---

## What it is

`dsh-notebook` is a Web plugin for [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/dsh): a small notebook that lives in the sidebar.
No rich-text editor, no cloud sync, no version history — it does one thing: jot down a note that has a title, a body and a few images,
and use it from the composer: a single click on the title copies the body, and typing `@` can reference a note.

Notes are **global** (not isolated per conversation) and images are stored as **real files on the host disk**, addressed by path.

## Features

| Feature | Detail |
|---|---|
| **`+` creates an entry** | The `+` sits in the top-right corner of the sidebar page; clicking it opens the editor container **inside the panel** (no new window, no second sidebar tab) |
| **Text container** | Single-line title `<input>` + content-sized body `<textarea>` (v0.2.1) + image thumbnail strip, sharing one scrollable container |
| **The body box follows its content (v0.2.1)** | The body `<textarea>` is re-measured on every edit, when the editor opens, and whenever a narrower panel re-wraps the text or the viewport (which the cap is derived from) changes height: it grows line by line while you type or paste, and shrinks back the moment text is deleted. It never drops below **120 px** — an empty note renders at exactly that, and a CSS `min-height` holds the box open before the first measurement — and never exceeds **60 % of the viewport height**; past that cap it stops growing and scrolls its own content, so the Done / Cancel row stays reachable. Only the multi-line body scales; the title stays a single-line field. The manual drag handle is gone, because a hand-set height would be overwritten by the next measurement |
| **Confirmations live inside the panel (v0.2.2)** | Deleting a note and discarding an unsaved draft ask through the panel's own dialogs — never `window.confirm`, whose native modal blocks the renderer thread and, in an embedded host that does not draw one, freezes the whole page. Cancel, `Esc` and a click on the backdrop all answer “no”; the destructive button never holds focus, so a stray Enter cannot delete anything; confirming a delete fires exactly one request, reports a failure in the panel and keeps the row |
| **Every string follows the shell (v0.2.2)** | The active language is read from DSH's `LocaleRuntime` (`getLocale()` / `getSnapshot()`), so the panel, its tooltips and its toasts render in whatever language the shell is showing; a composition whose locale cannot be read keeps the plugin's own Chinese dictionaries rather than rendering nothing |
| **Images yes, videos no** | All three entry points share one validation path: paste (`onPaste`), drag & drop (`onDrop`), and the “Insert image” button (`<input type="file" accept="image/*" multiple>`). `video/*` MIME types and `mp4/mov/webm/mkv/avi/m4v/ogv` extensions are rejected inline with “video files are not supported”; anything that is not an image gets “only image files are supported” |
| **Title + body** | The title is what the list displays; the body carries the content |
| **“Done” files it under its title** | The container closes and the list shows one row per note, titled, newest first, with “time · N images” as secondary metadata |
| **Click the title to copy** | The clipboard receives the **body only** (**never the title**); image markers become a `[image: <name>]` line. A 2-second toast confirms “body copied (N chars)”. **Clicking a title only copies — it never writes into the composer** |
| **`@`-reference a note** | Typing `@` in the composer lists notebook entries next to files and sessions under the localized “Notebook” heading (title + body snippet, a case-insensitive match on title or body, newest first, at most 8 rows). Picking one inserts an **atomic inline chip** like `@session`, whose clipboard/persistence form is the canonical mention `@[title](dsh-notebook:<noteId>)` |
| **Select text → “to notebook” (v0.2.0, on by default)** | Select text in the session and a floating **“进记事本 / To notebook”** action appears next to the selection; one click files the selection as a new note. The title is the numbered default **`未命名1`, `未命名2`, …** (the smallest number no existing note uses), and the body is the selection **verbatim**. Selections inside the composer, in an editable control, or in the Notebook panel itself are deliberately not offered |
| **Every answer → “save to notebook” (v0.2.0, on by default)** | Each finalized assistant message gains one extra icon at the end of its action row (next to copy / good response / branch). One click stores the **whole answer** — every `text` block of the reply, in order, joined by a blank line; reasoning and tool-call blocks are not prose and are left out — as a new note titled with the **session's own title** (falling back to `未命名n` when the session has none yet) |
| **Both capture features are switchable (v0.2.0)** | `selectionToNotebook` and `messageToNotebook` sit in the same settings section as every other preference and are **on by default**; turning one off takes effect on the next render, without reloading the plugin |
| **The in-row “Reference” button** | Each row gains a “Reference” button next to Edit/Delete that does the same as an `@` pick — insert the same atomic chip (falling back to inserting the body text when the chip path is unavailable); with no reachable composer it toasts “No composer is available in this session” |
| **Auto-open for new sessions (off by default)** | With “Open the notebook for new sessions” on, every session that becomes current (a new one, or a switch to another) opens the Notebook through that tier's own gesture — the native right sidebar and a sidebar product use their `openTab`, the standalone tier expands its own panel; the session already current at plugin activation does not count, so nothing pops up at page load |
| **“Edit” reuses the same container** | The list's “Edit” button loads that note into the **one and only** `<NotebookEditor>` instance (title, body and thumbnails restored); the DOM never holds more than one editor container |
| **Images land on disk** | Uploaded as `dataURL`, decoded by the host into `$DSH_HOME/storages/notebook-attachments/<noteId>/`; deleting a note deletes its attachment directory too |
| **Atomic writes + serialization** | `notebook.json` is written to a temp file → `fsync` → previous version copied to `.bak` → `rename`; a single in-process mutex serializes every read-modify-write |
| **No silent data loss** | If `$DSH_HOME` is not writable the host degrades to an in-memory store and every API response carries `degraded: true`; the client shows a non-blocking banner |
| **Keyboard** | `Cmd/Ctrl+Enter` = Done, `Esc` = Cancel — a dirty draft asks first, and `Esc` on that question closes it and keeps you in the editor (with the caret back in the body box) |

## Screenshots

> Real screenshots from a live run on DSH `0.1.1-rc.2` with no sidebar product installed — that is the self-drawn panel (tier 3).

| | |
|---|---|
| ![Notebook panel](docs/images/panel-open.png) | ![Editor container](docs/images/editor.png) |
| The Notebook list in the sidebar (`+` in the top-right); expanding pushes the conversation column 400px | The editor container: title, body and image thumbnails (paste / drop / picker) |
| ![Copy body](docs/images/list-and-copy.png) | ![Standalone panel](docs/images/collapsed-button.png) |
| The “body copied” toast after clicking a title — the body only, never the title | The self-drawn panel (tier 3): the toggle is pinned to the viewport's top-right corner |

A fourth shot shows the plugin folded into `dsh-better-sidebar` instead — see [Relationship to dsh-better-sidebar](#relationship-to-dsh-better-sidebar):

![Notebook inside better-sidebar](docs/images/tier2-better-sidebar.png)

## Install

### Requirements

| | |
|---|---|
| DSH | `>=0.1.1-rc.2` |
| Node | `>=20` |
| Package manager | **pnpm** — this repo does not support npm |

### Option 1 — install from the repository

```sh
dsh plugin --profile web add github:wyzh0117/dsh-notebook
```

> While developing, **never restart the DSH instance you are working in** (e.g. the Web GUI on port 3080 —
> restarting it kills the current session). For a real end-to-end check, start an isolated environment instead:
> ```sh
> DSH_HOME=/tmp/dshnb-home npx -y --package @deepseek-ai/dsh dsh web --port 3099
> ```

### Option 2 — build from source (development)

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

## Usage

1. Expand the right sidebar and open **Notebook**.
2. Click the **`+`** in the top-right corner — the editor container opens inside the panel.
3. Type a **title** and a **body** — the body box grows with what you write and shrinks when you delete it (v0.2.1), up to 60 % of the window height, where it scrolls inside instead. Add pictures by **pasting or dropping** them, or with “Insert image”.
   - Videos are rejected with “video files are not supported”; a single image is capped at 10 MB and a note at 20 images (adjustable in settings).
4. Click **Done** (or `Cmd/Ctrl+Enter`) — the container closes and the note is filed under its **title**.
5. Click the **title text** — the body (never the title) goes to your clipboard, with a “body copied (N chars)” toast.
   **Clicking a title is a pure copy**: the v1.1 composer attachment bridge exists but has no UI entry point (see the next section).
6. To let the model read a note, type **`@`** in the composer and pick it under the “Notebook” heading, or click **`Reference`** at the
   end of its row — both insert one atomic reference chip, and only the **body** reaches the model (the title is never sent).
7. Use **`Edit`** at the end of the row to load that note into the **same container**; **`Delete`** opens the panel's own confirmation dialog (v0.2.2 — Cancel, Escape and a click on the backdrop all keep the note) and, once confirmed, removes the note and its attachment directory.
8. To see the notebook automatically in every new session, turn on “Open the notebook for new sessions” in settings (off by default; all three tiers honour it).
9. **Let the conversation write a note for you** (v0.2.0, both on by default):
   - **Select any text in the session** — a floating **“进记事本 / To notebook”** action appears beside the selection; one click files it as a new note titled `未命名1`, `未命名2`, … (the smallest number no note uses yet). The selection lands in the body exactly as selected, so you can rename it later with **`Edit`**.
   - **Click the notebook icon at the end of an answer** — it sits in the answer's action row next to copy / good response / branch, and stores the whole reply as one note titled with the **session's title** (a session without a title yet gets a `未命名n` title instead). Both actions confirm with the same toast, and either can be turned off in settings.

## Compatibility

| | |
|---|---|
| DSH | Minimum supported `>=0.1.1-rc.2`; **the development machine runs `0.1.5-rc.2`** with `@deepseek-ai/dsh-client-ui-sidebar-right` installed, so the native right sidebar exists and **tier 1 is the live tier here** (tier 1 needs DSH ≥ `0.1.5-rc.1` plus that package) |
| Node | `>=20` (development and build) |
| `dsh-better-sidebar` | Optional. Tier 2 targets 0.4.0–0.18.x; 0.19+ is handled by tier 1 |
| Optional DSH plugins | When `conversation` (the session composer), `inputTriggers` (the `@` pipeline) or `sessions` (the session list) is missing, the matching integration simply turns off and the v1 behaviour returns |
| v0.2.0 capture surfaces on an older shell | Both register through `ctx.slots.inject`, so a shell that does not declare `shell.overlay` or `conversation.chat.assistant-actions` simply never fires the callback: the feature is absent, never broken. A shell whose session kit has no `useProjection` loses only the session-title source, and the note falls back to the numbered `未命名n` title |
| v0.2.2 language on an older shell | The active locale is read through `getLocale()` / `getSnapshot()` → the legacy `get()` → and finally the plugin's own `zh` default, each guarded by its own `try`: a service that answers none of them costs the localized wording, never the panel. Note the deliberate order — a shell that reports a language this plugin does not ship (say `ja`) is answered in **English**, DSH's own fallback, not in Chinese |
| v0.2.2 dialogs on any shell | Both prompts are plain React state plus absolutely-positioned overlays — no `window.confirm`, no dialog API, no focus trap library — so they render in every runtime the panel itself renders in, and the renderer thread is never blocked |
| v0.2.1 body sizing on an older shell | Plain DOM measurement (`scrollHeight` against an `auto` height, then inline `height` / `maxHeight` / `overflowY`), so it works in any browser the shell itself supports. `ResizeObserver` handles the re-wrap case when it exists, and a `window` `resize` listener always tracks the viewport-relative cap (a height-only window resize does not have to change the box's own size, so the observer alone is not enough); in a runtime with no layout at all the box keeps its 120 px floor rather than collapsing |

## Version adaptation — the three tiers

This is the core design, and it is what makes one artifact work across DSH releases that moved the right column between owners.

DSH's right column changed owner around 0.1.5-rc.1. Before that, plugins such as `dsh-better-sidebar` drew it themselves;
afterwards DSH owns it and plugins register tabs through `ctx.sidebarRightTabs`. So the client probes once and settles on
one of three tiers — **at most one Notebook entry may exist on the page at any moment**:

| Priority | Tier | Trigger | Registration |
|---|---|---|---|
| 1 | **`native`** | `ctx.get('sidebarRightTabs')` exists (DSH ≥ 0.1.5-rc.1) | Two-phase native registration: `sidebarRightTabs.register({ id, kind, priority:'extension', title, guide })`, then the tab body into the keyed slot `sidebar.right.pane.tab` (same `id` as the key); plus the global `settings.section` seat and the “auto-open for new sessions” watcher |
| 2 | **`service`** | `ctx.get('betterSidebar')` exists (better-sidebar 0.4.0–0.18.x and similar products) | `ctx.betterSidebar.registerTab({ id:'dsh-notebook:notebook', …, single:true, settings:{ pluginToggles, render } })` |
| 3 | **`standalone`** | neither of the above | Draws its own right panel (UI matched to `dsh-better-sidebar` 0.12.1) and registers the **same** global settings seat (`settings.section`) |

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
| Expand button | A 28×28 button pinned to the **viewport's top-right corner**, 16 px linear panel icon, ~500 ms delayed tooltip, `aria-label` following the expanded state |
| Panel geometry | `PANEL_MIN=280` / `PANEL_MAX=640` / `PANEL_DEFAULT=400`, clamped with `Math.min(max, Math.max(280, round(w)))` |
| Width drag | A 6 px grab strip on the panel's **left edge**; `setPointerCapture` then track the `clientX` delta |
| Narrow viewport | `innerWidth < 768` collapses to a full-width `100vw` drawer with no drag strip |
| Layout push | Sets `--dsh-notebook-width` plus `data-dsh-notebook-collapsed` / `data-dsh-notebook-dragging`, consumed by one namespaced `<style>` tag that is removed on dispose |
| Collapse | The panel **stays mounted** and slides out (`translateX(100%)`); `visibility: hidden` only after the transition ends |
| Persistence | Open state and width live in `localStorage` (`dsh-notebook:open` / `dsh-notebook:width`, every access wrapped in try/catch) |
| Reduced motion | Honours `@media (prefers-reduced-motion: reduce)` |

## Settings

All three tiers share **one definition**, whose source of truth is the host's `NotebookDoc.prefs`
(consistent across tiers and browsers). Reads and writes always go through `PATCH /notebook/api/prefs` —
tier 2 deliberately does **not** use better-sidebar's own `pluginSettings`, which would let the tiers drift apart.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `sortOrder` | `'updated' \| 'created' \| 'title'` | `'updated'` | List ordering: recently updated / recently created / title ascending |
| `copyImagesAsName` | boolean | `true` | When copying, render images as a `[image: <name>]` line |
| `maxImagesPerNote` | number | `20` | Image cap per note (1–100) |
| `confirmDelete` | boolean | `true` | Ask before deleting — in the panel's own dialog (v0.2.2); `false` deletes on the click, with no prompt of any kind |
| `openOnStart` | boolean | `false` | **tier 3 only**: expand the sidebar on DSH startup |
| `autoOpenOnNewSession` | boolean | `false` | Open the Notebook page whenever a session becomes current (all three tiers honour it; off by default, nothing pops up at page load) |
| `selectionToNotebook` | boolean | `true` | **v0.2.0**: show the floating “to notebook” action over a text selection in the session |
| `messageToNotebook` | boolean | `true` | **v0.2.0**: show the “save to notebook” icon at the end of every answer's action row |

Where they surface: tiers 1 and 3 register the **same** global settings section (`settings.section`, shared through
`hosts/settingsSeat.ts`), so both tiers expose identical fields and copy; tier 2 goes through
`registerTab({ settings: { pluginToggles, render } })` — its declarative inventory is now seven rows (every preference except
`openOnStart`, which only means something in the standalone tier) while the panel it renders is the same one.
Every edit travels through `PATCH /notebook/api/prefs` into `NotebookDoc.prefs` (the host validates every key).

## DSH session integration (v1.1)

Every seam here is **public** and **entirely optional**: the client bundle can only `require` the module-table entries, never import
a DSH UI package, so every member is duck-typed and every call is guarded — a host without `ctx.conversation` /
`ctx.inputTriggers` / `ctx.sessions` merely loses one capability and falls back to the v1 behaviour, never to an error.

Two capabilities are user-visible: `@` references (§2) and “auto-open for new sessions” (§3). A third, the composer attachment
bridge (§1), is **implemented, unit-tested and deliberately unwired** — no UI calls it.

### 1. The composer attachment bridge (**implemented, unwired**)

> **Product decision (2026-09-15):** clicking a title must **only copy**, never write into the composer on its own. Its only entry
> point was therefore removed: the title action in `NotebookView` is `handleCopyBody` (a plain `buildClipboardText` + `copyText`) and
> no longer calls `attachImages`; `composer.ts` carries the same WIRING NOTE on `NotebookComposer`.
> The code and its tests are **kept on purpose** — the seams are the expensive part and they are already covered — waiting for an
> explicit action of their own.

What the bridge does (for a future caller, and why it is worth keeping):

- `attachImages(note)`: resolve the target (a current session from `ctx.sessions`, the `ctx.conversation` service and that session's
  input facade) → re-read the stored bytes over the plugin's own `GET /notebook/api/attachments/<noteId>/<file>` route into `File`s →
  `ctx.conversation.createDrafts(sessionId, files)` to mint browser-owned draft attachments → `input.addAttachments(ids)` for the rail.
  The images live in the draft only and **upload when the prompt is sent**; a rail **refusal** releases the drafts through
  `releaseDraftAttachments` (no object URL or upload outlives the attempt). Formats the composer cannot take (**not SVG** — only
  png / jpeg / webp / gif) count as `skipped`, unreadable files as `failed`, and a batch that inserts nothing reports
  `no-target` / `no-images` / `fetch-failed`.
- `appendText(text)`: writes `buildBodyText(note)` (every image marker **removed**, so the rail is not duplicated) into the draft,
  preferring the session-scoped `slash/input-insert-text` (spliced at a caret span, so `@`-chips already in the draft keep their
  identity), then the facade's own `insertText`, and only as a last resort a whole-draft `setDraft` rebuild.
- The path has **no UI entry point**: the `attached` / `attachedPartial` / `attachSkipped` / `attachReadFailed` /
  `attachedBodySkipped` toasts were removed from `locales.ts` together with it (the last leftover key, `attachFailed`, has since been
  removed too, so the final artifact carries no attachment toast at all).
- Because the title action is a pure copy, **this bridge does not affect `@` references**, which ride a different seam (below).

### 2. The `@` source and the “Reference” button

- The plugin registers a `@` source named `dsh-notebook` through `ctx.inputTriggers.registerSource` (`order: 20`; the built-in source
  sits at 0), so typing `@` lists notebook entries next to files and sessions. Each row shows the title plus a body snippet
  (markers dropped, whitespace collapsed, truncated at 60 characters) under the localized “Notebook” heading. Candidates are filtered
  **case-insensitively** on title and body, **newest update first, at most 8 rows**; an aborted query or a failed read yields no rows
  (it never breaks the menu that also lists files and sessions). A refused registration (an HMR predecessor that has not
  unloaded yet, and the source name is the serialization routing key so it cannot be renamed) is retried every 500 ms, up to
  five times, before the plugin gives up with a warning.
- Picking a row inserts an **atomic inline chip** (labelled with the title) whose clipboard/persistence form is the canonical mention
  `@[title](dsh-notebook:<noteId>)` (brackets are stripped out of the label).
- At **send time** the trigger pipeline asks the source's codec to serialize each chip occurrence: the plugin returns the note's
  **body only** — **the title is deliberately never sent** — with each image marker rendered as one `[image: <name>]` line.
- The failure policy mirrors the pipeline's own contract: a **deleted note** serializes to nothing (the reference is simply gone and the
  send proceeds), while a **real read failure** rejects — the send is blocked with a visible error instead of silently downgrading the
  mention to `@title`.
- The in-row **“Reference”** button takes the same road: it inserts the same chip through the session-scoped
  `slash/input-insert-reference` event (spliced at a caret span, so the chip stays a chip), and falls back to inserting the note's body
  text when that path is unavailable. With no reachable composer it toasts `refUnavailable` (“No composer is available in this session”)
  rather than pretending it worked.
- The three row actions (Reference / Edit / Delete) now **wrap** (`flexWrap`), so a title and its buttons stay readable in the narrowest panel.

### 3. Auto-open for new sessions (off by default)

| Item | Behaviour |
|---|---|
| Preference | `autoOpenOnNewSession`, **default `false`**, persisted with every other preference in the host's `NotebookDoc.prefs` |
| Tier | **All three tiers wire it** (`attachSessionAutoOpen`), each with its own gesture; where a carrier cannot open anything (a sidebar product without `openTab`) the watcher simply stays inert rather than pretending |
| Trigger | The current session in the session list **becomes a different one** (a new session, or a switch) — a re-published snapshot of the same session does not count |
| Never fires | For the session that is **already** current when the plugin activates (no popup at page load), nor when `current` becomes `null` (the hero screen) |
| Retry | `openTab` throws (or `open()` reports failure) while the new session's sidebar surface is still mounting, so the open is retried at `0 / 200 / 500 / 1200 / 2500 ms` and abandoned the moment the session changes again or the plugin unloads |
| Gesture | Tier 1: `sidebarRight.openTab('dsh-notebook')` plus `toggleExpanded()` while collapsed; tier 2: `service.openTab({ type, title })`; tier 3: the self-drawn panel's `control.setOpen(true)` |
| Settings seat | Tiers 1 and 3 register the **same** global settings section (`settings.section`, shared through `hosts/settingsSeat.ts`, carrying all eight preferences); tier 2 goes through `registerTab({ settings })`, whose inventory is seven rows (every preference except `openOnStart`) while the panel it renders is the same one |

## Capturing from the conversation (v0.2.0)

Two ways for the conversation to fill the notebook, both **tier-independent** (they belong to the shell, not to a sidebar
carrier) and both **on by default**. They share one write path — `client/capture.ts` — so title numbering, save ordering and
the toast the user sees cannot drift apart between them.

```
selection ──► selectionAction.ts ─┐
                                  ├──► capture.ts ──► POST /notebook/api/notes ──► NotebookDoc.notes
assistant answer ──► answerAction.ts ─┘        (title minting · serialized writes · subscribers · toasts)
```

| | Select text → notebook | Answer → notebook |
|---|---|---|
| Entry point | A floating pill beside the selection (`shell.overlay`, a click-through layer this plugin adds one entry to) | One extra icon at the end of a finalized message's action row (`conversation.chat.assistant-actions`) |
| Preference | `selectionToNotebook` | `messageToNotebook` |
| Title | The numbered default `未命名n` — the smallest `n ≥ 1` that no existing note title uses, so deleting `未命名2` hands the next capture that slot instead of skipping a number | The **session's own title** (`useProjection('title')`); with no title yet the capture mints the numbered default instead of filing the note under a placeholder the user never chose |
| Body | The selection **verbatim** (no trimming — the exact text becomes the note) | Every `text` block of the reply, in order, joined by a blank line. `reasoning` (private deliberation), `tool-call` and `image` blocks are not prose and are left out; an answer that is nothing but tool calls reports “nothing to save” rather than writing an empty note |
| Refuses | A collapsed/whitespace-only selection; a selection inside the composer's own DOM (`[data-composer-card]`, `[data-composer-input]`, `[data-lexical-editor]`, any `input`/`textarea`/`contenteditable`); a selection inside this plugin's own panel (`[data-dsh-notebook]`); a selection outside the conversation | — (the icon only exists under a finalized message). It is not offered at all when there would be no way to read the answer: no snapshot reader in the composition, or a snapshot whose container shape this plugin cannot read (a version skew). A row with no usable message id hides it too — an interrupted answer carries no id, so a loose match would file the wrong reply. A snapshot that reads fine but holds no matching message (or holds no prose) keeps the button, which then reports there is nothing to save |
| Feedback | A toast: “Saved to the notebook as「未命名3」”, or the host's own error text on failure | Same shared toast, plus the icon itself turns into a short-lived saved state (and returns to idle so a failed save can be retried) |

**Where the action lands in the row.** The DSH slot list renders inside the message row's *extension band*, i.e. between the
hardcoded **Copy** button and the hardcoded **Branch** button. Its `order` (20) puts this plugin after the shipped
good-response pair (order 10), so the icon is the last entry *the slot can express* — it cannot be placed after Branch, and
this README says so rather than implying otherwise.

**Numbering is owned by the capture service.** A title is chosen from the notes the host currently holds **plus** the titles
this activation has already minted, and it is held until its request settles: consecutive captures never collide even when
the note list cannot be read (an outage, or a write that has not landed yet), while a failed save releases its number so a
retry mints the same one. Saves are serialized, so the read-modify-write of that number cannot interleave.

**Selection scope, honestly.** DSH exposes no selection service, so this feature watches the document itself
(`selectionchange` / `mouseup` / `keyup`, plus `scroll` and `resize` to keep the pill glued to the text) and decides what
counts as “in the session” from the shell's semantic DOM hooks — `[data-chat-flow]` (the transcript column),
`[data-conversation-scroll]`, then the `[data-slot=…]` outlets. If a future shell renames those, the feature degrades to
“any selection outside the composer and outside our own panel” instead of silently never firing; the per-package CSS-module
class names are intentionally never used, because they are content-hashed.

## Architecture

```
                     ┌─────────────────────────── browser ───────────────────────────┐
                     │ lib/client.js  (CJS module-table factory, id = "dsh-notebook")│
                     │  three-tier detect → native / service / standalone            │
                     │  NotebookView ─ NotebookEditor(one instance) ─ clipboard      │
                     │  composer bridge (ref chip; attach/body code unwired)         │
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

`src/client/autoGrow.ts` (v0.2.1) is the only place the body box's geometry is decided: it measures the `<textarea>` against
its content and writes `height` / `maxHeight` / `overflowY`, while `NotebookEditor` decides *when* — on mount, on every text
change, on a width change and on a viewport-height change. That seam is what the tests target from both sides: the node project
drives `applyBodyHeight` with plain objects, the jsdom project drives the real element with a simulated `scrollHeight`.

v0.2.2 adds no module: the two confirmation prompts are plain React state plus an overlay inside the surface that owns them (`NotebookView` for a delete, `NotebookEditor` for a discarded draft), and the language plumbing is confined to `src/client/locales.ts`, which reads the active id from `ctx.locale` (`getLocale()` / `getSnapshot()`, then the legacy `get()`) and keeps the plugin's own `zh` dictionaries as the last resort.

In the native tier the tab body reads visibility from the slot's injected `useTabInfo()` hook (DSH 0.1.5-rc.2 renders a tab
without a plain `props.tab.visible`), so a **hidden tab really does skip loading and polling** — `NotebookView` issues no host
request at all while `visible === false`.

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

## Known limitations (deliberately out of scope for v1 / v1.1 / v0.2.0 / v0.2.1 / v0.2.2)

- **No video / audio or other rich media** — an explicit requirement. Both the client and the host reject it.
- No multi-user, cloud sync, sharing, live collaboration or AI auto-organising.
- **No version history**: only the most recent content is kept.
- Notes are **global**, not isolated per conversation.
- **The body box stops at 60 % of the viewport height (v0.2.1)**: a note long enough to need more scrolls inside its own box,
  which is deliberate — an unbounded box would push the title and the Done / Cancel row off the panel — but it does mean the
  editor never shows an entire very long note at once while editing. The preference for a hand-picked height was removed with
  the drag handle rather than persisted, so resizing the box is not a per-note setting.
- The body is **plain text plus Markdown image markers** (`![name](attachment:<id>)`), not rich text;
  no rich-text editor dependency is pulled in.
- Tier-1's registration sequence is covered by `test/tier-detect.test.ts` with a fake ctx and was checked against the
  0.1.5-rc.2 **real type declarations** (see the header of `src/client/hosts/native.ts`); this machine has
  `dsh-client-ui-sidebar-right` and tier 1 is the live tier, but the three v1.1 behaviours have **not been clicked through a
  GUI** (unit / component tests plus the live endpoint checks in [Verification status](#verification-status)).
- **SVG cannot ride the composer attachment bridge**: the bridge accepts png/jpeg/webp/gif only (notes themselves still support
  SVG; this bridge simply will not take it). The bridge currently has no UI entry point — see [DSH session integration](#dsh-session-integration-v11).
- **A reference sends the body, never the title**: the title in `@[title](…)` is a human-facing label and is deliberately
  dropped at serialization time; images become one `[image: <name>]` line.
- **An unsent `@` reference degrades to a literal mention after a page reload**: DSH persists an unsent draft as its
  **clipboard projection** in `localStorage` (`dsh.conversation`, per session), and the plugin has no host-side mention
  resolver — `dsh-session:` mentions are expanded by `@deepseek-ai/dsh-session-reference` at `agent/pre-step`, a seam this
  plugin does not hook — so after a reload the model receives the literal text `@[title](dsh-notebook:<noteId>)` instead of
  the note body. Workaround: send before reloading, or re-insert the reference. A host-half expander on the same
  `agent/pre-step` seam is the identified fix and is deliberately left out of v1.1.
- **“Open the notebook for new sessions” is inert on a carrier that cannot open anything**: all three tiers wire the same
  watcher, but a sidebar product without `openTab` never opens anything (and never pretends it did).
- **The answer icon cannot sit after “branch”**: the DSH slot it registers into
  (`conversation.chat.assistant-actions`) renders inside the message row's extension band, between the hardcoded Copy and
  Branch buttons. `order: 20` puts it last *within that band* — after the shipped good-response pair, before Branch. That is
  a property of the host's action row, not a choice this plugin could make differently.
- **An answer is saved as prose, not as a transcript**: only `text` blocks are stored. A reply whose content is entirely tool
  calls has nothing to save (the click reports that instead of writing an empty note), and images rendered in an answer are
  **not** copied into the note — the note holds text, and image attachments are added by hand in the editor.
- **The selection pill follows the shell's DOM hooks**: DSH publishes no selection service, so this feature listens to the
  document and identifies “the session” as `[data-chat-flow]` / `[data-conversation-scroll]` / `[data-slot=…]`. A future shell
  that renames those degrades the scope to “anywhere outside the composer and our own panel” rather than breaking; it cannot
  offer the action for a *stale* selection whose geometry the browser no longer reports.
- **A captured note is written immediately, with no confirmation step**: that is the point of the two actions, but it also
  means a mis-click files a note (titled `未命名n` or with the session's title) that the user then deletes by hand, exactly like
  one created with `+`.
- The session-integration capabilities **depend on the host**: without the conversation / input-trigger / sessions services
  the plugin falls back to the v1 behaviour (clipboard copy, no Reference button).
- DSH source is never modified (hard constraint).

## FAQ

**I dropped an mp4 — nothing happened.**
v1 does not support video. Both the client and the host reject it and show “video files are not supported”.

**Why does the copied body contain `[image: name]` instead of the picture?**
The clipboard gets plain text; images are files on disk and cannot travel as text, so they become a filename line.
Turn `copyImagesAsName` off in settings to drop the markers entirely instead.

**Does clicking a title send the note's images into the composer?**
No. v1.1 briefly wired image notes into the composer (images attached, body in the draft), but the product decision of
2026-09-15 turned the title click back into a **pure copy**, which removed its only entry point. The bridge code and its unit
tests are kept in `composer.ts` (waiting for an explicit action of its own), but **no UI can trigger it today**: clicking a title
always just copies the body to the clipboard.

**Why did my `@` reference turn into `@[title](dsh-notebook:xxx)` after a reload?**
DSH persists an unsent draft as its clipboard projection in `localStorage`, and this plugin has no host-side mention resolver
(`dsh-session:` mentions are expanded by `@deepseek-ai/dsh-session-reference` at `agent/pre-step`, a seam the plugin does not
hook), so the chip degrades to literal text. Send before reloading, or re-insert the reference.

**What does an `@` reference actually send?**
The body only. The chip shows the title, but serialization sends the body (each image marker becoming one `[image: <name>]` line);
the title is a human-facing label and is **never** handed to the model. A note that has been deleted contributes nothing, and a
real read failure blocks the send with a visible error.

**Where are my notes stored? Is anything uploaded?**
Entirely on your machine under `$DSH_HOME/storages/`. Nothing is uploaded anywhere, and the HTTP API only listens on loopback.

**I selected text in the session but no “to notebook” button appeared.**
Four things suppress it, all deliberate: the selection is empty or whitespace-only; it is inside the composer (or any editable
control), because a prompt draft is not a note; it is inside the Notebook panel itself; or the browser reports no geometry for
it (the selection is scrolled out of view). Selections made *outside* the conversation — the sidebar, the settings dialog —
are also not offered while the shell exposes its transcript container. If the button still never appears, the feature may be
switched off: check “Save selected text to the notebook” in settings.

**Which part of an answer gets saved, and where does the title come from?**
The prose: every `text` block of the reply, in order, joined by a blank line. Reasoning blocks, tool calls and images are not
prose and are left out (an answer that is only tool calls says so instead of writing an empty note). The title is the
**session's own title**; a session that has no title yet gets the numbered default `未命名n` rather than a placeholder you
never chose. The note then behaves like any other: rename it with `Edit`, delete it, or reference it with `@`.

**The saved-answer icon is not the last icon in the row — why?**
Because the host decides that. The DSH slot it registers into renders inside the message row's extension band, between the
hardcoded **Copy** and **Branch** buttons, so no plugin can place an action after Branch. This plugin registers at the end of
that band (after the shipped good-response pair), which is the last position the slot can express.

**Can images get lost?**
Not silently. A failed upload keeps the entry as an error item you can retry; if `$DSH_HOME` is not writable the
store degrades to memory and every API response carries `degraded: true`, which the UI surfaces as a banner.

**Can I run this alongside better-sidebar?**
Yes — that is exactly tier 2. Notebook shows up as one entry inside its right sidebar.

**Will tier 1 work on my machine?**
If your DSH is older than 0.1.5-rc.1 there is no `ctx.sidebarRightTabs`, so the plugin falls back to tier 2 or tier 3.

**`pnpm install` fails with `ERR_PNPM_NO_MATCHING_VERSION: @deepseek-ai/dsh-*`?**
That is pnpm auto-installing peers. This repo's root `pnpm-workspace.yaml` sets `autoInstallPeers: false`
(pnpm 11 reads project settings from `pnpm-workspace.yaml`); add the same setting
if you replicate the package config elsewhere.

## Development

```sh
pnpm install        # pnpm only; npm is unsupported in this repo
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run (node env for the host half, jsdom for *.test.tsx)
pnpm build          # tsc -p tsconfig.build.json && tsdown → lib/index.js + lib/client.js + lib/types/**
pnpm watch          # tsdown --watch
```

The repo root carries a `pnpm-workspace.yaml` whose single setting is `autoInstallPeers: false`. Why: `dsh-better-sidebar` is an *optional* peer,
pnpm tries to resolve it anyway, picks 0.19.x, and then cannot satisfy that package's `@deepseek-ai/*` peer ranges
(`^0.1.5`) — npm only publishes those as prereleases (`0.1.5-rc.2`), and semver never matches a prerelease against a
non-prerelease range, so the install dies with `ERR_PNPM_NO_MATCHING_VERSION`. Every peer this repo builds against is
an explicit `devDependencies` entry, so disabling peer auto-install costs nothing.

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
**value** except the module-table entries (`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`,
`@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`). `codeSplitting: false` is required too —
the factory's `require` cannot resolve relative chunk URLs.

### Verification status

Checked live in an **isolated environment** (`DSH_HOME=/tmp/dshnb-home`, never against the instance in use); the tier 3 / tier 2
rows are records from the `0.1.1-rc.2` era, while the last two rows are the **currently running 3080 instance** (DSH `0.1.5-rc.2`):

| Item | How | Result |
|---|---|---|
| `tsc --noEmit` | whole repo | 0 errors |
| Unit / component tests | `vitest run` | **307 passed (20 files)** — the v0.2.2 count; v0.2.2 added `test/locales.test.ts` (10), grew `test/editor.test.tsx` to 15 (the delete + discard dialogs, the `window.confirm` regression guard, the failed-delete report, the one-request guard and the focus hand-back) and `test/capture-surfaces.test.tsx` to 19 (the icon's hint in both languages) |
| Build | `tsc -p tsconfig.build.json && tsdown` | `lib/index.js` (ESM) + `lib/client.js` (CJS) + `lib/client.js.map` + `lib/types/**` |
| Client bundle shape | CI executes `lib/client.js` against a stub `require` | `id=dsh-notebook`, `exports=apply,inject,…`, `inject===['slots','locale']`, zero `node:` requires |
| **Tier 3** (no sidebar product) | real browser | toggle pinned to the viewport's top-right corner (`top:10,right:innerWidth-10`, 28×28); expanding sets `--dsh-notebook-width: 400px` and pushes `#root` by 400px; 6 px drag strip on the left edge; collapse animates `translateX(102%)` + `visibility:hidden` with the push back to zero |
| **Tier 3, the core flow** | real browser, item by item | `+` → exactly **one** editor container; title and body written; pasted png accepted, pasted mp4 rejected with “video files are not supported”; “Done” closes it and files the note under its title; clicking the title put the **body (no title)** on the clipboard with images as `[image: nb-test-image.png]` and a “body copied (67 chars)” toast; “Edit” reopened the **same** container with title, body and thumbnails restored |
| **Tier 2** (`dsh-better-sidebar@0.12.1`) | real browser | the self-drawn panel is **not** mounted (detection settles on the service tier); better-sidebar's “New tab” shows **Notebook** next to Explorer / Source Control / Tasks / Terminal / Browser, rendering this plugin inside its own panel against the same global notes |
| Persistence | restart + reinstall through another channel | `notebook.json`, `.bak` and `notebook-attachments/<noteId>/<image>.png` land correctly; data survives a release-tarball install and the attachment route answers `200 image/png` |
| Release artifact | release tarball into a clean profile | `dsh plugin` mounts it, host routes and client bundle both work |
| CI | GitHub Actions | green |
| **v1.1 artifact is served** (running 3080 instance) | `GET /plugins/??dsh-notebook/client.js&rev=<framed hash>` | **200**; the served bytes carry `slash/input-insert-reference`, `slash/input-insert-text`, `autoOpenOnNewSession`, `noteReferenceInsert`, `useTabInfo` (plus the `createDrafts` / `attachImages` symbols of the retained-but-unwired bridge) — i.e. the v1.1 code really is in the artifact being served, while the retired attachment toasts (`attachSkipped` / `attachReadFailed`) **no longer appear** |
| **v1.1 host routes are online** | `GET /notebook/api/state`, `GET /notebook/api/attachments/<noteId>/<file>` | `state` → **200** `application/json` with the real document; attachment → **200 `image/png`** — the byte-fetch path the attachment bridge performs per image (the bridge is implemented but unwired, so no UI calls it) |

Tier 1 (the native right sidebar of DSH ≥ 0.1.5-rc.1) has **not been clicked through a GUI**: its registration sequence is
covered by `test/tier-detect.test.ts` with a fake ctx and was checked against the 0.1.5-rc.2 **real type declarations** (the
header of `src/client/hosts/native.ts` records this); this machine has `dsh-client-ui-sidebar-right` installed and tier 1 is
the live tier.

The user-visible v1.1 capabilities (`@` reference + “Reference”, auto-open for new sessions) have **not been clicked through a
GUI**; their behaviour rests on unit / component tests. The composer attachment bridge has no UI entry point and is covered at
bridge level only (what the live instance did verify is the last two rows above: the artifact is served and the host routes
answer):

| Feature | Tests covering it | What they assert |
|---|---|---|
| Composer attachment bridge (**implemented, unwired, no UI entry point**) | `test/composer.test.ts` (31); `test/view-actions.test.tsx` (7) asserts the **opposite** | Bridge level: target resolution (null without the conversation service, a current session or a scope), stored images re-read into `File`s, the `createDrafts` + `addAttachments` call sequence, drafts released on refusal, SVG skipped, the image cap honoured, the three text-write paths (scoped event → `insertText` → `setDraft`), the exact detect-span math (including a chip with empty clipboard text), and no invented success without a target or insertable images. UI level: **clicking a title copies and leaves the composer completely alone** (an image note too), with the same copy when no bridge exists |
| `@` reference + “Reference” | `test/reference.test.ts` (17) + `test/view-actions.test.tsx` (7) | `registerSource` registers exactly once and disposes, a refused registration retried within the budget and reported once it is exhausted, candidate filtering / ordering / the 8-row cap / the section, `onPick`'s chip and canonical mention, **serialization carrying the body and never the title**, a deleted note serializing to nothing, a real read failure propagating, and the row button inserting a reference or reporting `refUnavailable` |
| Auto-open for new sessions | `test/auto-open.test.ts` (11) + `test/tier-detect.test.ts` (16) + `test/native-tab-body.test.tsx` (3) | nothing for the session already current at activation, once per change (not per snapshot), nothing while the preference keeps its `false` default, retries at `0 / 200 / 500 / 1200 / 2500 ms` while the surface is unmounted and abandonment when the session changes again, silence without `ctx.sessions`, **each tier wiring its own open gesture** (native `openTab` / sidebar `openTab` / the self-drawn panel's `setOpen`), the native tab body reading visibility from the injected `useTabInfo()` hook (hidden really means no load and no polling), and `mergePrefs` applying only present keys |
| Capture: select → notebook (v0.2.0) | `test/selection-action.test.tsx` (35) + `test/capture.test.ts` (21) + `test/capture-surfaces.test.tsx` (19) | scope resolution through the real DOM hooks (and the “no known container ⇒ accept anywhere” degradation), the scope being cached while its element lives and re-resolved when the transcript mounts, the refusals (composer, editable, this plugin's own panel, whitespace-only, collapsed, unmeasurable geometry), the placement clamp at all four viewport edges **including a selection below the viewport**, the click that must not collapse the selection first (asserted through the note it saves), the saved text being the selection **verbatim**, the offer staying dismissed while the transcript keeps re-emitting `selectionchange` (one click, one note), and the pref gate following a live change |
| Capture: answer → notebook (v0.2.0) | `test/answer-action.test.ts` (18) + `test/capture-surfaces.test.tsx` (19) + `test/tier-detect.test.ts` (16) | the answer reader against both snapshot shapes and against version-skew shapes (a readable container with no match stays offered and reports; an unreadable container hides the action), an id-less interrupted answer never matching an empty requested id, `text` blocks joined in order with reasoning / tool-call / image blocks excluded, the session title used as the note title with the numbered default as its fallback, the empty-answer path reporting instead of writing, the shared toast on failure, the `order > 10` contract that puts the icon last in the band, and that a late tier upgrade never re-registers either capture surface |
| Title minting + write ordering (v0.2.0) | `test/capture.test.ts` (21) | `未命名n` being the smallest FREE number (not `count + 1`), no reuse across consecutive captures even when the note list is stale or unreadable, call-order serialization, a failed save releasing its number (retried on the SAME service, which is what makes the release observable), a failed title read not blocking the capture, the no-op for whitespace-only input, and the saved body being the user's exact text (padding included) |
| Body auto-grow (v0.2.1) | `test/auto-grow.test.ts` (12) + `test/editor-autogrow.test.tsx` (8) | Node half: the viewport-relative cap and its fallbacks, the `height: auto` reset that makes shrinking possible at all (asserted through the recorded style writes), the 120 px floor for empty content and for runtimes that cannot measure (`0` / `NaN`), the cap plus `overflowY: auto` past it (and no scrollbar for content that exactly fits), border compensation, idempotence (the property the `ResizeObserver` loop guard rests on), and a requested cap below the floor. DOM half, against the real `<textarea>` with a `scrollHeight` derived from its own value: growth while typing, the clamp at the cap, shrinking back on delete, an edited note opening already at its height, re-measure on a narrower panel, the width filter (a height-only notification does not re-measure), a viewport-height change re-clamping the cap with `ResizeObserver` present, the window-resize fallback when `ResizeObserver` is missing, the floor when measurement is impossible, `disconnect()` on close, and the title field staying untouched |
| Confirm dialogs + language (v0.2.2) | `test/editor.test.tsx` (15) + `test/locales.test.ts` (10) + `test/capture-surfaces.test.tsx` (19) | Delete raises the panel's own `alertdialog` with the note's title in it, removes nothing until it is confirmed, and is answered “no” by the Cancel button, by Escape and by a click on the backdrop; with `confirmDelete` off it deletes at once with no prompt; a note that vanishes elsewhere takes its question away; a failed delete is reported with the row kept; and a double click on the row fires exactly ONE request. The same for the editor's discard prompt (Keep editing / Escape hold the draft AND hand the keyboard back to the body box, Discard drops it unsaved). **Both delete tests spy on `window.confirm` and assert it is never called** — the freeze regression. The language half pins the read order (`getLocale` → `getSnapshot` → `get`), `zh`/`zh-CN`/`zh-Hans` → Chinese, `en-US` → English, an unshipped language → English, a missing/malformed/throwing service → `zh`, and that a refused dictionary registration never throws. At the surface level, the answer icon's `aria-label` and `title` are asserted to switch with the shell (English `Save this answer as a note` ↔ Chinese) |
| Preferences over HTTP (all versions) | `test/api.test.ts` (12) | the client half's own shaping rules: a document and a note normalized, a **missing** preference defaulting to ON rather than being dropped (an older host), a malformed document repaired, a pref patch sent verbatim and the server's answer re-normalized, note ids percent-encoded in every path, an attachment URL reduced to its last relPath segment, and the host's `{ error: { code, message } }` envelope (plus transport, non-JSON and missing-`fetch` failures) surfacing as `NotebookApiError`. This layer is where a dropped key would silently revert a setting to its default, so the new capture switches are asserted through it end to end |

One drift guard is worth naming: `test/routes.test.ts`'s “accepts EVERY preference key the plugin exposes” asserts that the
key set accepted by `PATCH /notebook/api/prefs` equals `Object.keys(DEFAULT_PREFS)` — it is what caught the real bug where
`/prefs` silently dropped `autoOpenOnNewSession`.

The DSH seams these features rely on (`ctx.sessions`, `ctx.conversation.createDrafts` / `input.for(actx)`, the
session-scoped `slash/input-insert-reference` / `slash/input-insert-text`, `ctx.inputTriggers.registerSource`) were read
from **DSH `0.1.5-rc.2`'s published client packages** (type declarations and implementation), not confirmed by clicking
through a live GUI: this machine also runs `0.1.5-rc.2` with `dsh-client-ui-conversation` /
`dsh-client-ui-input-trigger` / `dsh-client-ui-sidebar-right` all present, and the three features above are still guaranteed
by unit / component tests alone (the live checks covered the served artifact and the host endpoints, nothing more).

The same is true of v0.2.0's two capture surfaces. Their contracts were read from the installed
`0.1.5-rc.2` packages — `conversation.chat.assistant-actions` and `shell.overlay` as declared by
`dsh-client-ui-chat` / `dsh-client-ui-layout`, the answer's shape from `dsh-client-ui-chat`'s
`AssistantChatData` / `AssistantMessageNode`, and the session title from `dsh-session-title`'s
`useProjection('title')` — and are pinned by tests against those shapes plus the version-skew cases. The two surfaces have
**not been clicked through a live GUI**: a live pass needs a rebuilt `lib/client.js` loaded by a refreshed page, which is the
user's step, not something this repository's test suite can assert.

v0.2.1's body sizing is asserted from both sides — the arithmetic in the node project, the real `<textarea>` in jsdom — **and was
then confirmed in a real browser**: against the running 3080 instance (tier 1, Chromium, viewport 1920×929, expected cap
`round(929 × 0.6) = 557`) an empty editor measured **120 px** with `maxHeight: 557px` and `overflowY: hidden`; 6 lines measured
134 px, 20 lines 414 px, and 60 lines the 557 px cap with `overflowY: auto` and a reachable internal scroll; deleting back to one
line returned it to 120 px; a viewport-height-only change (929 → 600 → 929, no keystroke in between) moved the cap to 360 and back
to 557 and re-clamped the box each time; and an unrelated React re-render left the imperative `height` / `maxHeight` / `overflowY`
untouched with **zero** style writes, while a 3-second `MutationObserver` showed the resize writes settle instead of looping. That
pass was a probe, not a test: it used **Cancel** only, and `$DSH_HOME/storages/notebook.json` was byte-identical (sha1) before and
after. The patch needs no host change, no new route and no new preference, so replacing `lib/client.js` plus a page refresh is the
entire deployment.

## Contributing

Issues and pull requests are welcome. Two house rules come first:

- **pnpm only.** This repo does not support `npm` or `yarn`; a lockfile mismatch caused by another package manager is not something we can act on.
- **DSH source is never modified.** That is a hard constraint of the project, not a preference.

### The local gate

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm build
```

CI runs exactly these on Node 22 — pnpm 11 itself needs Node ≥ 22.13 for the toolchain, while the plugin still *runs* on
Node ≥ 20, which is what `engines` declares. CI additionally executes `lib/client.js` against a stub `require` to assert the
bundle shape, because a client bundle that quietly requires a `node:` builtin fails only at runtime in the browser.

### Reporting a bug

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md). The fields that decide how fast a report can be acted
on are the DSH version, the `dsh-better-sidebar` version (if installed), and **which tier was active** — `native`, `service`
or `standalone`. A report that names the tier it landed on removes the first round trip.

### Sending a PR

The [PR template](.github/pull_request_template.md) carries the checklist. In short:

- paste the real `typecheck` / `test` / `build` output — an unchecked box with a one-line reason beats a checked box nobody verified;
- say which parts the change touches: tier 1 `native`, tier 2 `service`, tier 3 `standalone`, the host half (`src/index.ts`, `src/store.ts`, `src/attachments.ts`, `src/routes.ts`), or build / CI / docs only;
- update both READMEs when user-visible behaviour or a setting changes.

### Constraints a PR must not break

- no video / audio support path — v1 explicitly excludes rich media, and both the client and the host enforce the rejection;
- `cordis` (bare) must never be added to `dependencies` / `peerDependencies` / `optionalDependencies`;
- no `preinstall` / `install` / `postinstall` / `prepare` script;
- in `src/client/**`: no `node:*` import, and no `@deepseek-ai/*` **value** import outside the shared module table
  (`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/dsh-client-ui-slots`,
  `@deepseek-ai/dsh-client-ui-primitives`);
- the registered client bundle id must stay equal to the package name (`dsh-notebook`).

## Version history

| Milestone | State | Highlights |
|---|---|---|
| **v0.1.0** | tagged | The notebook itself: create / edit / delete, title + body, images with videos rejected, click-a-title-to-copy, the single reusable editor container, three-tier adaptation, atomic writes with `.bak` recovery, loopback-only HTTP API. |
| **v1.1** | merged on `main`, **not yet tagged** | DSH session integration: `@` references and the in-row “Reference” button, auto-open for new sessions (off by default). The composer attachment bridge landed as code plus unit tests with **no UI entry point** — clicking a title stays a pure copy. |
| **v0.2.0** | released | Conversation → notebook capture: a floating “to notebook” action over a text selection (numbered `未命名n` titles), and a “save to notebook” icon at the end of every answer's action row (filed under the session's title). Both share one serialized write path with a shared toast, and both are switchable — and **on by default** — in settings. |
| **v0.2.1** | released | The editor's body box sizes itself to its content: it is re-measured on every edit, on open and when a panel resize re-wraps the text, growing line by line and shrinking back on delete, with a **120 px** floor and a **60 % of viewport height** cap past which it scrolls internally. The manual drag handle is gone; the title stays a single-line field. |

| **v0.2.2** | this release | Both confirm prompts move IN the panel: Delete asks in the notebook's own dialog and the editor's “discard unsaved changes?” in its own too, so no code path calls `window.confirm` any more — a native modal blocks the renderer thread and, in a host that never draws one (a webview, a sandboxed frame), froze the whole page. Alongside that, the active language is now read from DSH's `LocaleRuntime` (`getLocale()` / `getSnapshot()`), so tooltips and every other string follow the shell instead of being pinned to Chinese, and the answer action's hover hint is one short line (“Save this answer as a note”). |

`package.json` declares `0.2.2`; the v1.1 work shipped as part of v0.2.0 rather than under its own tag.

## License

[MIT](./LICENSE) © 2026 wyzh0117
