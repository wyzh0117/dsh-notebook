<!--
Thanks for contributing to dsh-notebook. Keep the checklist honest — an
unchecked box with a one-line reason is always better than a checked box that
was not actually verified.
-->

## What does this PR change?

<!-- One paragraph. Link the issue it closes, if any (`Closes #12`). -->

## Type

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / internal cleanup
- [ ] Docs / build / CI only

## Requirement coverage

dsh-notebook's v1 requirements are numbered `G1`–`G10` in
[`docs/specs/v1-design.md`](../docs/specs/v1-design.md). If this PR touches
behaviour, say which ones it affects.

| Requirement | Status |
|---|---|
| | |

## Which tiers does this touch?

- [ ] tier 1 `native` (`ctx.sidebarRightTabs`, DSH ≥ 0.1.5-rc.1 — not installable on a 0.1.1-rc.2 host)
- [ ] tier 2 `service` (`ctx.betterSidebar`, better-sidebar 0.4.0–0.18.x)
- [ ] tier 3 `standalone` (self-drawn panel)
- [ ] host half (`src/index.ts`, `src/store.ts`, `src/attachments.ts`, `src/routes.ts`)
- [ ] build / CI / docs only

## Checklist

- [ ] `pnpm install` succeeds (never use `npm` in this repo)
- [ ] `pnpm typecheck` passes — real output pasted below
- [ ] `pnpm test` passes — real output pasted below
- [ ] `pnpm build` passes and `lib/index.js`, `lib/client.js`, `lib/types/**` all exist
- [ ] `lib/client.js` still starts with `window.__ModuleLoader__.load({ id: "dsh-notebook", factory: (require) => {` and the registered id still equals the package name
- [ ] No new `node:*` import and no new non-module-table `@deepseek-ai/*` **value** import in `src/client/**`
- [ ] No modification to DSH source (hard constraint)
- [ ] No video/audio support path added (v1 explicitly excludes rich media)
- [ ] No `cordis` (bare) added to `dependencies` / `peerDependencies` / `optionalDependencies`
- [ ] No `preinstall` / `install` / `postinstall` / `prepare` script added
- [ ] Docs updated if user-visible behaviour or settings changed (`README.md` + `README_EN.md`)

## Verification output

```
$ pnpm typecheck
$ pnpm test
$ pnpm build
$ ls -l lib
```

## Notes for the reviewer

<!-- Anything surprising, any intentional deviation from the spec, any follow-up you deliberately left out. -->
