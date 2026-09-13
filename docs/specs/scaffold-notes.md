# 脚手架实现说明与版本偏差（brief 01 交付记录）

本文记录 `package.json` / tsconfig / tsdown / vitest / CI 等脚手架文件的实现细节，
以及**所有偏离 `docs/specs/v1-design.md` §7–§8 或 `.briefs/01-scaffold.md` 的地方**及其理由。

---

## 1. 依赖版本（实际安装结果）

`pnpm install` 的实际解析结果（`pnpm-lock.yaml` 为准）：

### DSH 运行时包（全部锁到本机 DSH 版本 `0.1.1-rc.2`）

| 包 | 版本 | 位置 |
|---|---|---|
| `@deepseek-ai/dsh-host-webserver` | `0.1.1-rc.2` | devDependencies |
| `@deepseek-ai/dsh-client-runtime` | `0.1.1-rc.2` | devDependencies（同时是 peerDependency） |
| `@deepseek-ai/dsh-client-ui-slots` | `0.1.1-rc.2` | devDependencies（同时是 peerDependency） |
| `@deepseek-ai/dsh-client-locale` | `0.1.1-rc.2` | devDependencies |
| `@deepseek-ai/dsh-settings` | `0.1.1-rc.2` | devDependencies |
| `@deepseek-ai/dsh-client-ui-settings` | `0.1.1-rc.2` | devDependencies |
| `@deepseek-ai/dsh-client-ui-primitives` | `0.1.1-rc.2` | devDependencies |
| `@deepseek-ai/dsh-home-paths` | `0.1.1-rc.2` | devDependencies |
| `@deepseek-ai/dsh-atomic-write` | `0.1.1-rc.2` | devDependencies |

**偏差：无。** brief 列出的九个包在 npm 上**都有** `0.1.1-rc.2`（逐包实测
`registry.npmjs.org/@deepseek-ai/<pkg>` 的 `versions`），因此没有发生任何版本降级/近似替换。

### 非 DSH 依赖

| 包 | 声明范围 | 实际解析 |
|---|---|---|
| `@deepseek-ai/cordis` | `^4.0.1` | `4.0.2` |
| `@deepseek-ai/schemastery` | `^3.18.2` | `3.18.2` |
| `react` / `react-dom` | `^18.3.1` | `18.3.1` |
| `@types/react` | `~18.3.1` | `18.3.31` |
| `@types/react-dom` | `~18.3.1` | `18.3.7` |
| `@types/node` | `^22.0.0` | `22.20.2` |
| `typescript` | `^5.9.0` | `5.9.3` |
| `tsdown` | `^0.22.2` | `0.22.14` |
| `vitest` | `^4.1.8` | `4.1.11` |
| `jsdom` | `^30.0.1` | `30.0.1` |
| `@testing-library/react` | `^16.3.3` | `16.3.3` |
| `@testing-library/dom` | `^10.4.1` | `10.4.1` |

**刻意不取 `latest` 的四个包**（`latest` 已跨大版本，会引入与本项目无关的破坏性变更）：

| 包 | `latest` | 我们取 | 理由 |
|---|---|---|---|
| `typescript` | `7.0.2` | `5.9.3` | 参考实现（`DSH-better-sidebar`）用 `^5.6.0`；TS 7 是新大版本，未验证 |
| `vitest` | `5.0.0` | `4.1.11` | 参考实现用 `^4.1.8`；且下方 §4 的配置是按 v4/v3 都成立的写法给的 |
| `react` / `react-dom` | `19.3.0` | `18.3.1` | DSH 的 `@deepseek-ai/dsh-client-ui-primitives` 等 peer 明确要求 `^18.2.0`，必须留在 18 |
| `@types/react` / `@types/react-dom` | `19.3.0` | `18.3.x` | 必须与 React 18 对齐 |

`tsdown` 的 `^0.22.2` 解析到 `0.22.14`（`0.23.0` 已发布，但 caret 对 `0.x` 不上跨 minor，
且本配置的字段形状是从用 `^0.22.2` 的参考实现照搬的，保持不变最稳）。

---

## 2. 偏离与判断性决定

### 2.1 新增 `pnpm-workspace.yaml`：`autoInstallPeers: false`（**必要**，非可选）

这是本次唯一一处**超出 brief 文件清单**的新增仓库文件（brief 本身已授权「需要时可写 `pnpm-workspace.yaml`」），
也是让 `pnpm install` 能通过的**唯一**办法。

> ⚠️ 踩坑记录：pnpm **11** 已不再从项目 `.npmrc` 读取项目级配置（`.npmrc` 只用于 registry/auth）。
> 我最初按 brief 的提示写了 `.npmrc` 的 `auto-install-peers=false`，`pnpm config get auto-install-peers`
> 返回 `undefined`，安装依旧失败。实测只有把设置写进 `pnpm-workspace.yaml`（键名 **camelCase**
> `autoInstallPeers`）才会被读取：`pnpm config list` 里随即出现 `"autoInstallPeers": false`，安装通过。
> 因此最终**删除了那个无效的 `.npmrc`**，只保留 `pnpm-workspace.yaml`。

`package.json` 里 `dsh-better-sidebar` 按规格以 `"*"` + `peerDependenciesMeta.optional=true` 声明
（规格 §8.1 / brief「peerDependencies」节要求）。但 pnpm 的 peer 自动安装（默认 `true`）**会去解析这个
optional peer**，于是：

1. pnpm 把 `"*"` 解析成 `dsh-better-sidebar@0.19.1`；
2. `0.19.1` 的 peer 里有 `@deepseek-ai/dsh-agent@^0.1.5`、`dsh-llm@^0.1.5`、`dsh-session@^0.1.5` 等；
3. 而 npm 上这些包在 `0.1.5` 系列**只有预发布版**（`0.1.5-rc.2`、`0.1.5-alpha.2`），
   npm 发布的 `latest` 标签还是 `0.1.0-rc.6`；
4. semver 规则：**非预发布范围（`^0.1.5`）不匹配预发布版本** → `ERR_PNPM_NO_MATCHING_VERSION`，安装直接失败。

实测（在 `/tmp` 临时工程里逐一验证）：

| peer 范围 | 结果 |
|---|---|
| 完全不写 `dsh-better-sidebar` | ✅ 成功 |
| `"*"` | ❌ `No matching version found for @deepseek-ai/dsh-agent@>=0.1.5 <0.2.0-0` |
| `">=0.4.0 <0.19.0"`（落到 0.18.1） | ❌ `No matching version found for @deepseek-ai/dsh-llm@>=0.1.2 <0.2.0-0` |
| `"^0.12.0"`（落到 0.12.3） | ❌ `No matching version found for @deepseek-ai/dsh-invariants@>=0.1.1 <0.2.0-0` |
| `"*"` + 关闭 peer 自动安装 | ✅ 成功（240 个包） |

结论：**不是范围写错，而是 pnpm 无法在这套「预发布为主」的 registry 状态下解析 better-sidebar 的 peer 闭包**。
所以保留规格要求的 `"*"`，改用仓库级 `pnpm-workspace.yaml` 关掉 peer 自动安装。

为什么关掉是安全的：本仓库真正需要参与构建的 peer（`react`、`react-dom`、`@deepseek-ai/cordis`、
`@deepseek-ai/dsh-client-runtime`、`@deepseek-ai/dsh-client-ui-slots`）**全部是显式 `devDependencies`**，
自动安装 peer 对它们没有任何增量。package.json 的 `peerDependencies` 声明本身完全不变——
消费者看到的包关系仍然正确。

> 消费者侧提示：如果你在没有装 better-sidebar 的 profile 里遇到同样的
> `ERR_PNPM_NO_MATCHING_VERSION`，在 profile 目录的 `pnpm-workspace.yaml` 里加
> `autoInstallPeers: false`（pnpm ≤10 则写 `.npmrc` 的 `auto-install-peers=false`）即可。README FAQ 已写明。

### 2.2 `vitest.config.ts` 用 `test.projects` 而非 `test.environmentMatchGlobs`

brief 允许「`environmentMatchGlobs`（或 `projects`）」。实测装到的 **vitest 4.1.11 已移除
`environmentMatchGlobs`**（在 `node_modules/vitest/dist/**/*.d.ts` 里全量 grep 零命中），
所以必须用 `test.projects`（在 v3.2+ / v4 都是受支持写法）：

- project `host`：`environment: 'node'`，`include: ['test/**/*.test.ts']`
- project `client`：`environment: 'jsdom'`，`include: ['test/**/*.test.tsx']`

**JSX 不需要额外配置**：vitest 4 用 **oxc** 做转换，直接从 `tsconfig.json` 读 `jsx: "react-jsx"`。
我最初在该 project 上照搬了 `esbuild: { jsx: 'automatic' }`，结果每次运行都打印
`Both esbuild and oxc options were set. oxc options will be used and esbuild options will be ignored.`
——既然被忽略就删掉，`test/editor.test.tsx` 实测照常通过（见 §3）。

两个 project 都设 `globals: true`。这不只是方便：**React Testing Library 只有在存在全局 `afterEach` 时
才会自动 `cleanup()`**，而 G8（「DOM 中编辑器容器实例数为 1」）的断言会被上一个用例残留的 render 污染。
测试文件仍按 brief 要求显式 `import { describe, it, expect, vi } from 'vitest'`。

### 2.3 `tsconfig.json` 的 `include` 只有 `src` + `test`

按 brief 原文执行（`include src + test`），因此 `tsdown.config.ts` / `vitest.config.ts`
不参与 `tsc --noEmit`。这两个文件改用「实际执行/实际构建」来验证（见 §3），而不是靠类型检查。

`tsconfig.build.json` 额外显式写了 `rootDir: "src"`：不加它时 `outDir: lib/types` 的产物会带一层
多余的 `src/` 前缀（`lib/types/src/index.d.ts`），而 `package.json` 的 `exports.types` 指向
`./lib/types/index.d.ts` —— 加上 `rootDir` 后两级路径才对得上（含 `./lib/types/client/index.d.ts`）。

### 2.4 `tsdown.config.ts`

**host 半用函数式 `external`**。brief 说 host 半「`external` 列出所有 dependencies/peerDependencies
（可用函数形式 `(id) => !id.startsWith('.') && !path.isAbsolute(id)` 之外再白名单）」。这里采用**函数形式**：
host 是 node 侧 ESM，裸导入（node 内建 + `@deepseek-ai/*` peer）全部交给 DSH profile 的
`node_modules` 解析，正是想要的语义；显式白名单反而会随 peer 列表漂移。
（`tsdown@0.22` 的 `UserConfig.external` 类型是 `ExternalOption`，即 rolldown 的可函数形式，已核对。）

**host 半必须显式钉住扩展名 `outExtensions: () => ({ js: '.js' })`**。这是实测踩到的真坑：
tsdown 0.22 对 `format: 'esm'` 的**默认扩展名是 `.mjs`**，第一次 `pnpm build` 产出的是
`lib/index.mjs`，而 `package.json` 的 `main`/`exports`/`dsh.plugin.json` 的 `main` 全部指向
`lib/index.js` —— 装到 profile 里会直接解析失败。加上 `outExtensions` 之后产物是 `lib/index.js`。

**client 半逐字照搬 brief 的配置**：`format: 'cjs'` + `codeSplitting: false` + 模块表 `CLIENT_EXTERNALS`
+ `noExternal` 白名单 + `banner`/`intro`/`footer` 三件套，`banner` 里的 id 是 `"dsh-notebook"`（= 包名）。

tsdown 0.22.14 会打印两条弃用警告：`` `external` is deprecated. Use `deps.neverBundle` instead. `` 与
`` `noExternal` is deprecated. Use `deps.alwaysBundle` instead. ``。**故意不改**：这两个旧字段仍被完整支持
（构建通过、产物正确，见 §3），而 `deps.*` 的语义边界未经本项目验证；模块表外置是本项目最不能出错的一环，
不拿它冒险。等上游正式移除时再迁移。

> 注意 rolldown 会**重新打印 banner / footer**，产物里它们是缩进过的多行文本，而不是原样的单行字符串：
> ```js
> window.__ModuleLoader__.load({
> 	id: "dsh-notebook",
> 	factory: (require) => {
> ```
> 所以**不能靠 grep 断言产物形态**（我第一版 CI 就是这么写的，实测必然失败）。CI 改成真的求值一次
> bundle（见 §2.6）。

### 2.5 `.github/pull_request_template.md` 放在 `.github/` 根（不是 `.github/ISSUE_TEMPLATE/`）

GitHub 只认 `.github/pull_request_template.md`（或 `.github/PULL_REQUEST_TEMPLATE/`）。
放在 ISSUE_TEMPLATE 目录里不会生效，所以放在仓库根 `.github/` 下。

### 2.6 CI 用 Node 20/22 矩阵

brief 说「Node 22」。这里以 **22 为必需**并额外加 20（`package.json` 声明 `engines.node >= 20`）。
两个 job 都会跑 typecheck / test / build。CI 里还加了两步**结构性断言**，因为产物形态是本项目最容易踩的坑：

① **产物必须真实存在**：`lib/index.js`、`lib/client.js`、`lib/types/index.d.ts`、`lib/types/client/index.d.ts`。

② **client bundle 必须真的能被模块加载器吃下去**：这一步**不是 grep**，而是用 node 求值一次产物——
把 `globalThis.window` 换成 `{ __ModuleLoader__: { load(entry){…} } }`，用 `new Function('window', code)` 执行
`lib/client.js`，然后断言：
- 注册到了 `load()`，且 `id === 'dsh-notebook'`（= 包名，client-modules 的 compose key）；
- `factory` 是函数，且用**桩 require**（只认模块表条目，其它一律抛错）调用后返回带 `apply` 函数的对象，
  `inject` 恰为 `["slots","locale"]`；
- 产物里不出现 `require("node:*")`（工厂的 `require` 解析不到 node 内建，一旦泄漏就是运行时死路）。

本机对照真实产物运行该脚本的输出：`client bundle ok: id=dsh-notebook exports=apply,inject,mergePrefs,reveal,tierOf`。

### 2.7 未创建的文件

- `docs/specs/scaffold-notes.md`：brief 标为「可选」，但 §2.1 的偏差必须留档，因此创建。
- `.npmrc`：**刻意不创建**。brief 原来建议用 `.npmrc` 的 `minimumReleaseAgeExclude` / `--config.minimumReleaseAge=0`
  绕「发布不足 24 小时」，实测没有任何 `minimumReleaseAge` 报错；而我的第一版 `.npmrc`（`auto-install-peers=false`）
  在 pnpm 11 下**完全无效**（见 §2.1），留着只会误导，故删除，改用 `pnpm-workspace.yaml`。

### 2.8 已创建但未在 brief 清单里的文件

| 文件 | 理由 |
|---|---|
| `pnpm-workspace.yaml` | §2.1，让 `pnpm install` 可复现（`pnpm-lock.yaml` 的 `settings.autoInstallPeers: false` 与之一致，CI 的 `--frozen-lockfile` 才成立） |
| `pnpm-lock.yaml` | `pnpm install` 的必然产物，也是 CI `--frozen-lockfile` 的前提 |

---

## 3. 实际执行的验收命令与输出

全部在 `/Users/youngi/Documents/MiniWork/dsh插件/dsh-notebook` 下执行（pnpm 11.21.0 / Node v22.23.2 / macOS arm64）。

| # | 命令 | 结果 |
|---|---|---|
| 1 | `pnpm install`（删掉 lockfile 后重新解析） | exit 0；`Packages: +240`，`Done in 18.5s` |
| 2 | `pnpm install --frozen-lockfile`（CI 走的那条） | exit 0；`Done in 766ms` |
| 3 | `ls node_modules/.bin` | `cordis  tsc  tsdown  tsserver  vitest` —— `tsdown` / `vitest` / `tsc` 三个都在 |
| 4 | `pnpm-lock.yaml` 头部 | `lockfileVersion: '9.0'` / `settings: autoInstallPeers: false` |
| 5 | `pnpm typecheck` | exit 0（`tsc --noEmit`，无输出） |
| 6 | `pnpm test` | **6 test files passed (6)，88 tests passed (88)**，Duration 5.54s |
| 7 | `pnpm build` | exit 0；`lib/index.js` 51.55 kB、`lib/client.js` 111.51 kB、`lib/client.js.map` |
| 8 | `lib/types` | `index.d.ts` / `client/index.d.ts` / `shared/types.d.ts` 均在（`rootDir: src` 生效，无多余 `src/` 层） |
| 9 | `node -e 'import("./lib/index.js")'` | host 产物可被 node 当 ESM 加载，`exports: Config,apply,name` |
| 10 | 从 `ci.yml` 抽出并执行产物校验脚本 | `client bundle ok: id=dsh-notebook exports=apply,inject,mergePrefs,reveal,tierOf`，exit 0 |
| 11 | `node --input-type=module -e 'import("./tsdown.config.ts")'` + 15 条断言 | 两个配置全部字段符合预期（entry/format/platform/external/codeSplitting/banner/intro/footer/externals 列表） |
| 12 | `node -e 'JSON.parse(...)'` 校验 `package.json` | 30 条结构断言全 PASS（含「无裸 `cordis`」「无 install 钩子」「banner id == 包名」） |

`pnpm test` 的逐文件结果（**两个 project 都真的跑到了**，这就是 `test.projects` 生效的证据）：

```
 ✓ |host|   test/tier-detect.test.ts  (11 tests)
 ✓ |host|   test/attachments.test.ts  (17 tests)
 ✓ |host|   test/routes.test.ts       (22 tests)
 ✓ |host|   test/store.test.ts        (19 tests)
 ✓ |host|   test/clipboard.test.ts    (10 tests)
 ✓ |client| test/editor.test.tsx      (9 tests)   ← jsdom project
 Test Files  6 passed (6)
      Tests  88 passed (88)
```

> 说明：第 5–7 项是**脚手架收尾时**的结果。中途（`src/` 还没写完时）`pnpm typecheck` 曾报过
> `test/attachments.test.ts:143 TS2339` 等 2 个错误、`pnpm test` 曾有过 4 个失败
> ——那些都属于 brief 02/03 负责的源码/测试，不在脚手架范围内，现已由对应 agent 修好。
> 本文件记录的是**我自己**交付物的验收：#1–#4、#9–#12 与脚手架强相关，任何时候都应成立。

### 产物形态（`lib/client.js`，节选）

```js
window.__ModuleLoader__.load({
	id: "dsh-notebook",
	factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
…
		exports.apply = apply;
		exports.inject = inject;
		exports.mergePrefs = mergePrefs;
		exports.reveal = reveal;
		exports.tierOf = tierOf;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
```

产物里的外部 `require` 只有两个（当前源码实际用到的那两个）：
`require("react")`、`require("react/jsx-runtime")`；`require("node:…")` 命中数为 **0**；
`import(` / `__vitePreload` 命中数为 **0**（即确实没有 code splitting）。
