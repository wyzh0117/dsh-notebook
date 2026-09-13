<div align="center">

# dsh-notebook

**DSH 侧边栏记事本** —— `＋` 新建 → 写标题与正文 → 贴图（拒视频）→ 「完成」以标题陈列 → 点标题复制正文 → 「编辑」复用同一个容器。

[![CI](https://github.com/wyzh0117/dsh-notebook/actions/workflows/ci.yml/badge.svg)](https://github.com/wyzh0117/dsh-notebook/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-3c873a.svg)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.1.1--rc.2-6b4fbb.svg)](#兼容性)
[![tests](https://img.shields.io/badge/tests-vitest-6da55f.svg)](./test)

`dsh-plugin` · `deepseek-harness` · `notebook` · `notes` · `sidebar`

</div>

> **GitHub topics（仓库设置里加）：** `dsh-plugin` `deepseek-harness` `notebook` `notes` `sidebar`

---

## 这是什么

`dsh-notebook` 是 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/dsh) 的 Web 插件：在侧边栏里放一个**记事本**。
它不引入富文本编辑器、不做云同步、不做版本历史——只解决一件事：随手记一条带标题、正文和图片的短笔记，
需要时点一下标题就把正文送进剪贴板。

笔记是**全局共享**的（不按会话隔离），图片以**文件形式落在宿主磁盘**上并由引用路径寻址。

## 功能

| 功能 | 说明 |
|---|---|
| **`＋` 新建条目** | 侧边栏页面内右上角的 `＋`，点击后在**面板内**弹出编辑容器（不新开窗口、不新开第二个 tab） |
| **文本框容器** | 单行标题 `<input>` + 正文 `<textarea>` + 图片缩略图区，共用一个可滚动容器 |
| **可放图片，不可放视频** | 三种入口全部走同一条校验：粘贴（`onPaste`）、拖放（`onDrop`）、「插入图片」按钮（`<input type="file" accept="image/*" multiple>`）。`video/*` MIME 或 `mp4/mov/webm/mkv/avi/m4v/ogv` 等扩展名一律拒收并给出行内提示「不支持视频文件」；非图片则提示「只支持图片文件」 |
| **标题 + 正文** | 标题用于陈列，正文是载体内容 |
| **「完成」后以标题陈列** | 容器关闭，列表里一条条以**标题**为单位显示（倒序，最新在上），次要信息是「时间 · N 张图片」 |
| **点标题复制正文** | 复制的是**正文本身**（**不含标题**）；图片标记会还原成 `[图片: <文件名>]` 一行。成功后 2s toast「已复制正文（N 字）」 |
| **「编辑」复用同一个容器** | 列表里点「编辑」，**同一个** `<NotebookEditor>` 实例载入该条（标题/正文/缩略图回填），DOM 中编辑器容器始终只有 1 个 |
| **图片落盘** | `dataURL` 上传，host 解码写入 `$DSH_HOME/storages/notebook-attachments/<noteId>/`，删除笔记时一并删除附件目录 |
| **原子写 + 串行化** | `notebook.json` 写临时文件 → `fsync` → 旧版备份为 `.bak` → `rename`；host 侧单进程 mutex 串行所有读改写 |
| **不静默丢数据** | `$DSH_HOME` 不可写时降级为内存态，API 响应带 `degraded: true`，客户端顶部显示非阻断提示 |
| **键盘** | `Cmd/Ctrl+Enter` = 完成，`Esc` = 取消 |

## 三层自适应行为（核心设计）

DSH 的右侧栏在 0.1.5-rc.1 前后换了主人：以前由 `dsh-better-sidebar` 这类插件自绘，之后由 DSH 内核自己拥有，
插件通过 `ctx.sidebarRightTabs` 注册 tab。所以本插件**在客户端做一次性探测**，按优先级落到三层之一，
**任何时刻页面上最多只有一个 Notebook 入口**：

| 优先级 | tier | 触发条件 | 注册方式 |
|---|---|---|---|
| 1 | **`native`** | `ctx.get('sidebarRightTabs')` 存在（DSH ≥ 0.1.5-rc.1） | 两阶段原生注册：`sidebarRightTabs.register({ id, kind, priority:'extension', title, guide })` + 把 tab 体注册进 keyed 槽 `sidebar.right.pane.tab`（key 用同一个 `id`） |
| 2 | **`service`** | `ctx.get('betterSidebar')` 存在（better-sidebar 0.4.0–0.18.x 及同类产品） | `ctx.betterSidebar.registerTab({ id:'dsh-notebook:notebook', …, single:true, settings:{ pluginToggles, render } })` |
| 3 | **`standalone`** | 二者皆无 | 自绘右侧栏（UI 完全对齐 `dsh-better-sidebar` 0.12.1），并自行注册设置区 |

几个刻意的选择：

- `export const inject = ['slots', 'locale']` —— **绝不**把 `betterSidebar` 写进 `inject`。服务不存在时插件会永不激活，tier 3 就死了。
- 探测是「同步先行 + 异步兜底」：两个 `ctx.get` 都不命中时，注册 `ctx.inject([...], cb)` 观察者，并挂一个 **700ms 兜底定时器**；定时器触发时仍无 tier 就挂载 standalone。
- **迟到升级**：若 standalone 已经挂上，之后某个服务才出现，会**先拆掉** standalone 再注册到该服务，绝不两个入口并存。
- 所有注册都包在 `ctx.effect(() => { …; return dispose })` 里，HMR / 禁用安全，二次激活不会抛 `already registered`。

### tier 3 的自绘面板（复刻 better-sidebar 0.12.1 的观感）

| 项 | 规格 |
|---|---|
| 展开按钮 | 固定在**视口右上角**的 28×28 按钮，16px 线性面板图标，约 500ms 延迟 tooltip，`aria-label` 随展开状态切换 |
| 面板几何 | `PANEL_MIN=280` / `PANEL_MAX=640` / `PANEL_DEFAULT=400`，钳制 `Math.min(max, Math.max(280, round(w)))` |
| 宽度拖拽 | 面板**左边缘** 6px 抓取条，`setPointerCapture` 后按 `clientX` 差值改宽 |
| 窄屏 | `innerWidth < 768` 时合并为全宽抽屉 `100vw`，不提供拖拽条 |
| 布局推挤 | 设置 `--dsh-notebook-width` 与 `data-dsh-notebook-collapsed` / `data-dsh-notebook-dragging`，由一份命名空间化、`dispose` 时移除的 `<style>` 消费 |
| 收起 | 面板**保持挂载**并滑出（`translateX(100%)`），过渡结束才 `visibility: hidden` |
| 持久化 | 展开状态与宽度记在 `localStorage`（键 `dsh-notebook:open` / `dsh-notebook:width`，每次访问 try/catch） |
| 减少动效 | 遵守 `@media (prefers-reduced-motion: reduce)` |

## 安装

要求：Node ≥ 20、DSH ≥ 0.1.1-rc.2、包管理器用 **pnpm**（本仓库不用 npm）。

### 方式一：从源码本地挂载（开发用）

```sh
git clone https://github.com/wyzh0117/dsh-notebook.git
cd dsh-notebook
pnpm install
pnpm build            # 产出 lib/index.js、lib/client.js、lib/types/**

# 挂进某个 DSH profile（示例用 web profile）
dsh plugin --profile web add "link:$PWD"
```

等价的纯手工做法：在 `~/.dsh/profiles/web/package.json` 里

```jsonc
{
  "dependencies": { "dsh-notebook": "link:/abs/path/to/dsh-notebook" },
  "dsh": { "profile": { "bundles": [ /* … */, "dsh-notebook" ] } }
}
```

然后在 profile 目录里 `pnpm install`。`dsh.profile.bundles` 必须包含 `dsh-notebook`，否则插件不会被加载。

### 方式二：从仓库安装

```sh
dsh plugin --profile web add github:wyzh0117/dsh-notebook
```

> 本地开发时**不要**重启你正在用的那个 DSH（比如 3080 端口的 Web GUI，重启会杀掉当前会话）。
> 需要真机验收时，另起一个隔离环境：
> ```sh
> DSH_HOME=/tmp/dshnb-home npx -y --package @deepseek-ai/dsh dsh web --port 3099
> ```

## 使用

1. 展开右侧栏，打开 **Notebook**。
2. 点右上角 **`＋`** → 面板内弹出编辑容器。
3. 写**标题**和**正文**；需要配图就**粘贴 / 拖入图片**，或点「插入图片」。
   - 视频会被拒绝并提示「不支持视频文件」；单图上限 10 MB，单条上限 20 张（可在设置里调）。
4. 点「完成」（或 `Cmd/Ctrl+Enter`）→ 容器关闭，条目以**标题**陈列。
5. 点**标题文字** → 正文（不含标题）进剪贴板，toast 提示「已复制正文（N 字）」。
6. 点行尾 **`编辑`** → **同一个容器**载入该条继续编辑；点 **`删除`** 删除该条及其附件目录。

## 架构

```
                     ┌──────────────────────── 浏览器 ────────────────────────┐
                     │ lib/client.js  (CJS 模块表工厂, id = "dsh-notebook")   │
                     │  三层探测 → native / service / standalone              │
                     │  NotebookView ─ NotebookEditor(唯一实例) ─ clipboard    │
                     └───────────────────────────┬───────────────────────────┘
                                    fetch JSON   │
                     ┌───────────────────────────┴───────────────────────────┐
                     │ lib/index.js   (cordis 插件, ctx.webServer prefix)     │
                     │  routes.ts ─ store.ts (原子写 + mutex) ─ attachments.ts│
                     └───────────────────────────┬───────────────────────────┘
                                                 │
                            $DSH_HOME/storages/notebook.json
                            $DSH_HOME/storages/notebook.json.bak
                            $DSH_HOME/storages/notebook-attachments/<noteId>/<attachmentId>.<ext>
```

### 宿主 HTTP API

注册在 `ctx.webServer`（`kind: 'prefix'`，`path: '/notebook/api'`），JSON over HTTP，
**所有**响应带 `Cache-Control: no-store`。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| `GET` | `/notebook/api/state` | — | `{ doc, degraded? }` |
| `POST` | `/notebook/api/notes` | `{ title, body, attachments: [{ name, mime, size, dataUrl }] }` | `{ note }` |
| `PATCH` | `/notebook/api/notes/:id` | `{ title?, body?, attachments? }` | `{ note }` |
| `DELETE` | `/notebook/api/notes/:id` | — | `{ ok: true }` |
| `PATCH` | `/notebook/api/prefs` | `Partial<NotebookPrefs>` | `{ prefs }` |
| `GET` | `/notebook/api/attachments/:noteId/:file` | — | 图片字节 + `Content-Type` |
| `GET` | `/notebook/api/health` | — | `{ ok, version, degraded }` |

- 图片用 **dataURL** 上传（客户端 `FileReader`），host 解码落盘——避免 multipart 解析依赖。
- **安全栅栏**：只接受来自 loopback 的请求（`req.socket.remoteAddress ∈ 127.0.0.1/::1`），
  并校验 `Origin`/`Host` 属于允许的本地来源，否则 `403`；路径参数做防穿越校验
  （`path.resolve` 后必须仍在附件根内）。单请求 body 上限 32 MB，超限 `413`。
- `400/403/404/413/415/500` 都返回结构化 `{ error: { code, message } }`。
- **host 端二次校验视频**（不信任客户端）：命中即 `415`。

### 数据落盘

| 路径 | 内容 |
|---|---|
| `$DSH_HOME/storages/notebook.json` | `NotebookDoc`（`version: 1`、`notes[]`、`prefs`），原子写 |
| `$DSH_HOME/storages/notebook.json.bak` | 上一次成功版本；JSON 损坏时先尝试用它恢复 |
| `$DSH_HOME/storages/notebook-attachments/<noteId>/<attachmentId>.<ext>` | 图片字节 |

`$DSH_HOME` 优先级：显式注入 > `process.env.DSH_HOME`（纯空白视为未设置）> `~/.dsh`。
`.bak` 也损坏时从空文档开始，并把坏文件改名为 `notebook.json.corrupt-<ts>`。

## 设置项

三层 tier **共用同一份定义**，真值存在 host 的 `NotebookDoc.prefs`（跨 tier、跨浏览器一致），
读写一律走 `PATCH /notebook/api/prefs`——tier 2 **不用** better-sidebar 自己的 `pluginSettings`，否则三层会不一致。

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `sortOrder` | `'updated' \| 'created' \| 'title'` | `'updated'` | 列表排序：最近更新 / 最近创建 / 标题升序 |
| `copyImagesAsName` | boolean | `true` | 复制正文时把图片写成 `[图片: <文件名>]` 一行 |
| `maxImagesPerNote` | number | `20` | 单条笔记图片数上限（1–100） |
| `confirmDelete` | boolean | `true` | 删除前二次确认 |
| `openOnStart` | boolean | `false` | **tier 3 专用**：DSH 启动即展开侧边栏 |

暴露位置：tier 1 走 DSH 原生设置（`settings.plugin.item` 槽）；tier 2 走
`registerTab({ settings: { pluginToggles, render } })`；tier 3 自注册设置区。

## 与 dsh-better-sidebar 的关系

- **我们不是它的 fork，也不依赖它。** `dsh-better-sidebar` 只在 `peerDependencies` 里以
  `optional: true` 出现，源码里对它是**零 import**（只用结构化鸭子类型调用 `ctx.betterSidebar`），
  所以永远不会出现两份实例。
- **装了它（0.4.0–0.18.x）**：走 tier 2。展开它绘制的右侧栏，里面会**多出** Notebook 这一项，
  与它原有的 editor / git / terminal / browser 等并列。我们有意避开它保留的 id
  （`editor` `git` `subagent` `sidechat` `terminal` `browser` `diff`），自己的 id 是 `dsh-notebook:notebook`。
- **装了它 0.19+（右栏已交给 DSH 内核）**：走 tier 1，tab 出现在内核绘制的那一列里。
- **没装任何 sidebar 产品**：走 tier 3，本插件自带展开式右侧栏，UI 对齐 better-sidebar 0.12.1 的观感
  （按钮位置、面板宽度与拖拽、窄屏全宽、收起动画）。

## 兼容性

| | |
|---|---|
| DSH | `>=0.1.1-rc.2`（本机实测版本）。tier 1 需要 DSH ≥ `0.1.5-rc.1` 且装有 `@deepseek-ai/dsh-client-ui-sidebar-right` |
| Node | `>=20`（开发与构建） |
| `dsh-better-sidebar` | 可选。tier 2 面向 0.4.0–0.18.x；0.19+ 归入 tier 1 |

## 已知限制（v1 有意不做的）

- **不支持视频 / 音频等富媒体**——这是需求明确排除项，client 与 host 双侧都拒绝。
- 不做多用户、云同步、分享、实时协同、AI 自动整理。
- **没有版本历史**，只保留最近一次内容。
- 笔记**全局共享**，不按会话隔离。
- 正文是**纯文本 + Markdown 图片标记**（`![name](attachment:<id>)`），不是富文本；不引入富文本编辑器依赖。
- tier 1 的代码按 0.1.5-rc.2 的类型声明编写，用假 ctx 做单测覆盖注册调用序列；本机（0.1.1-rc.2）没有右侧栏包，**无法真机验证 tier 1**。
- 不修改 DSH 源码（硬约束）。

## 开发

```sh
pnpm install        # 只用 pnpm，npm 在本仓库不受支持
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run（host 用 node 环境，*.test.tsx 用 jsdom）
pnpm build          # tsc -p tsconfig.build.json && tsdown → lib/index.js + lib/client.js + lib/types/**
pnpm watch          # tsdown --watch
```

仓库根的 `pnpm-workspace.yaml` 只有一条配置 `autoInstallPeers: false`。原因：`dsh-better-sidebar` 是
*optional* peer，pnpm 会去解析它并选中 0.19.x，而 0.19.x 的 `@deepseek-ai/*` peer 范围（`^0.1.5`）
在 npm 上只有预发布版（`0.1.5-rc.2`）可匹配——semver 不允许非预发布范围匹配预发布版本，安装会以
`ERR_PNPM_NO_MATCHING_VERSION` 失败。本仓库真正需要构建的 peer 全部是显式 `devDependencies`，关掉
peer 自动安装不影响任何东西。详见 [`docs/specs/scaffold-notes.md`](docs/specs/scaffold-notes.md)。

客户端产物不是普通 ESM，而是注册到全局模块加载器的 CJS 闭包工厂：

```js
window.__ModuleLoader__.load({ id: "dsh-notebook", factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  /* …打包后的 CJS 代码… */
  exports.apply = apply; exports.inject = inject;
  return module.exports;
} });
```

因此 `src/client/**` 里**禁止** `node:*` 导入，**禁止**除模块表外部项
（`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`cordis`、
`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-web-react`、
`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-schema-form`、
`@deepseek-ai/dsh-client-runtime/client`）之外的 `@deepseek-ai/*` **值导入**；
`codeSplitting: false` 也是必须的（工厂里的 `require` 无法解析相对 chunk URL）。

## 截图

> 以下均为**真机实测截图**（DSH `0.1.1-rc.2`，未装任何 sidebar 产品，即 tier 3 自绘面板）。

| | |
|---|---|
| ![Notebook 面板](docs/images/panel-open.png) | ![编辑容器](docs/images/editor.png) |
| 侧边栏里的 Notebook 列表（`＋` 在右上角），展开时把会话列推挤 400px | 编辑容器：标题 + 正文 + 图片缩略图（粘贴/拖入/按钮三种入口） |
| ![复制正文](docs/images/list-and-copy.png) | ![standalone 面板](docs/images/collapsed-button.png) |
| 点标题后 toast「已复制正文（67 字）」——复制的是正文，不含标题 | 未装 sidebar 产品时的自绘面板：开合按钮固定在视口右上角 |

## FAQ

**Q：我贴了 mp4，为什么没反应？**
A：v1 明确不支持视频。客户端与 host 双侧都会拒收，并给出行内提示「不支持视频文件」。

**Q：为什么点标题复制出来的正文里图片变成了 `[图片: 文件名]`？**
A：剪贴板里写的是纯文本。图片是磁盘上的文件，无法作为文本带走，所以还原成一行文件名占位。
可以在设置里把 `copyImagesAsName` 关掉，那样图片标记会整段略去。

**Q：笔记存在哪里？会上传吗？**
A：全部在本机 `$DSH_HOME/storages/` 下。没有任何远端上传；HTTP API 只监听 loopback。

**Q：图片会不会丢？**
A：不会静默丢。上传失败的条目会保留为错误项并允许重试；`$DSH_HOME` 不可写时降级为内存态并在
API 响应里带 `degraded: true`，界面顶部会显示非阻断提示。

**Q：能同时装 better-sidebar 和这个插件吗？**
A：能，这正是 tier 2 的场景——Notebook 会作为一项出现在它的右侧栏里。

**Q：tier 1 在我这台机器上能跑吗？**
A：如果你装的 DSH < 0.1.5-rc.1，就没有 `ctx.sidebarRightTabs`，会自动落到 tier 2 或 tier 3。

**Q：`pnpm install` 报 `ERR_PNPM_NO_MATCHING_VERSION: @deepseek-ai/dsh-*`？**
A：那是 pnpm 在自动安装 peer。本仓库根的 `pnpm-workspace.yaml` 已设 `autoInstallPeers: false`
（pnpm 11 从 `pnpm-workspace.yaml` 读项目配置，不再从 `.npmrc` 读）；若你在别处复刻包配置，加上同样的设置即可。

## 许可

[MIT](./LICENSE) © 2026 wyzh0117
