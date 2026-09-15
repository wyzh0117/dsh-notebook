---
name: Bug report
about: Something in dsh-notebook is broken or behaves unexpectedly
title: '[bug] '
labels: ['bug']
assignees: []
---

<!--
Before filing: run `pnpm typecheck && pnpm test && pnpm build` on the failing
checkout and paste the real output below. Reports without a reproduction are
much harder to act on.
-->

## Environment

| | |
|---|---|
| dsh-notebook version | <!-- e.g. 0.1.0, or the git commit you linked in --> |
| DSH version | <!-- `dsh --version`, e.g. 0.1.1-rc.2 --> |
| dsh-better-sidebar version | <!-- e.g. 0.12.1, or "not installed" --> |
| OS / Node | <!-- e.g. macOS 15, Node v22.23.2 --> |
| Install path | <!-- `dsh plugin --profile web add …` / manual `link:` / other --> |

## Which sidebar tier was active?

The plugin picks one of three tiers at runtime:

- [ ] **tier 1 `native`** — DSH exposes `ctx.sidebarRightTabs`
- [ ] **tier 2 `service`** — `ctx.betterSidebar` exists (better-sidebar 0.4.0–0.18.x)
- [ ] **tier 3 `standalone`** — no sidebar product installed, so the plugin draws its own panel
- [ ] not sure

## What happened

<!-- What you did, what you expected, what you got instead. -->

## Steps to reproduce

1.
2.
3.

## Expected behaviour

<!-- If this is about one of the documented behaviours, name it (e.g. "video should be rejected", from the Features table in the README). -->

## Actual behaviour

<!-- Include console output / the failing HTTP response body if there is one. -->

```
paste logs / `{ "error": { "code": …, "message": … } }` responses here
```

## Verification output

```
$ pnpm typecheck
$ pnpm test
$ pnpm build
```

## Screenshots

<!-- Drag images in. `docs/images/` is where the README screenshots live. -->
