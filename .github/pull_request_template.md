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

## Feature coverage

The user-visible contract is the **Features** table in
[`README.md`](../README.md#features). If this PR touches behaviour, name the
rows it affects and say whether they still hold.

| Feature row | Status |
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
- [ ] `lib/client.js` still registers itself through `window.__ModuleLoader__.load({ id: "dsh-notebook", factory: … })` and the registered id still equals the package name (assert it by **executing** the bundle — the banner whitespace is not stable, which is why CI does not grep it)
- [ ] No new `node:*` import and no new non-module-table `@deepseek-ai/*` **value** import in `src/client/**`
- [ ] No modification to DSH source (hard constraint)
- [ ] No video/audio support path added (v1 explicitly excludes rich media)
- [ ] No `cordis` (bare) added to `dependencies` / `peerDependencies` / `optionalDependencies`
- [ ] No `preinstall` / `install` / `postinstall` / `prepare` script added
- [ ] Docs updated if user-visible behaviour or settings changed (both `README.md` and `README.zh-CN.md`)

## Verification output

```
$ pnpm typecheck
$ pnpm test
$ pnpm build
$ ls -l lib
```

## Notes for the reviewer

<!-- Anything surprising, any intentional deviation from the documented behaviour, any follow-up you deliberately left out. -->
