<div align="center">

# dsh-notebook

**DSH 侧边栏里的记事本。**

`＋` 新建 → 写标题与正文 → 贴图 → 点**完成**，条目以标题陈列。
点标题复制正文 · 打 `@` 引用记事 · 点**编辑**复用同一个容器。

[![CI](https://github.com/wyzh0117/dsh-notebook/actions/workflows/ci.yml/badge.svg)](https://github.com/wyzh0117/dsh-notebook/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-3c873a.svg)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.1.1--rc.2-6b4fbb.svg)](#兼容性)
[![tests](https://img.shields.io/badge/tests-vitest-6da55f.svg)](./test)

`dsh-plugin` · `deepseek-harness` · `notebook` · `notes` · `sidebar`

</div>

[English](./README.md) · **中文**

**本次更新**

- **v0.2.0** —— 会话也能往记事本里写：选中文字浮现「进记事本」动作；每条回答末尾的记事本图标可把整条回复存成一条记事。两个都默认开启。
- **v0.2.1** —— 正文框随内容自动缩放：写着变高、删掉变矮，最高到窗口高度的 60%。
- **v0.2.2** —— 去掉所有原生确认框（原生模态可能把嵌入式宿主卡死）；所有文案跟随 shell 语言。
- **v0.2.3** —— 「新会话自动打开记事本」现在真的会打开侧边栏。

**快速跳转** · [功能](#功能) · [安装](#安装) · [使用](#使用) · [兼容性](#兼容性) · [设置项](#设置项) · [实现细节](#实现细节) · [已知限制](#已知限制) · [FAQ](#faq) · [开发](#开发)

> **GitHub topics（仓库设置里加）：** `dsh-plugin` `deepseek-harness` `notebook` `notes` `sidebar`

---

## 这是什么

`dsh-notebook` 是 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/dsh) 的 Web 插件，在侧边栏里放一个**记事本**。

它只解决一件事：随手记一条带标题、正文和图片的短笔记，然后在输入框里用起来——点一下标题就把正文送进剪贴板，打 `@` 能引用某条记事。

不引入富文本编辑器、不做云同步、不做版本历史。笔记是**全局共享**的（不按会话隔离），图片以**文件形式落在宿主磁盘**上。

## 功能

| 功能 | 说明 |
|---|---|
| **`＋` 新建条目** | 面板右上角的 `＋`，点击后在**面板内**弹出编辑器——不新开窗口、不新开 tab |
| **标题 + 正文 + 图片** | 单行标题、随内容缩放的正文、图片缩略图区，共用一个可滚动容器 |
| **可放图片，不可放视频** | 粘贴、拖放、「插入图片」三种入口走同一条校验：`video/*` 与 `mp4/mov/webm/mkv/avi/m4v/ogv` 一律行内拒收 |
| **「完成」后以标题陈列** | 列表一条一条以**标题**为单位显示，最新在上，次要信息是「时间 · N 张图片」 |
| **点标题复制正文** | 复制的是**正文本身**、**不含标题**；图片还原成 `[图片: 文件名]` 一行，并 toast「已复制正文（N 字）」。它**永远不往输入框里写东西** |
| **`@` 引用记事** | 输入框里打 `@`，在本地化的「记事本」分组下多出记事条目（标题 + 摘要，最新在前，最多 8 条）；选中插入原子 chip，发送时只有**正文**交给模型 |
| **行内「对话引用」按钮** | 作用同 `@` 选中，从列表行里直接插；够不到输入框时如实提示，不假装成功 |
| **选中文字 →「进记事本」**（v0.2.0，默认开） | 选区旁的浮动动作，把选区**原文**存成一条记事，标题是 `未命名1`、`未命名2`……输入框内与面板自身的选区有意不提供 |
| **每条回答 →「存入记事本」**（v0.2.0，默认开） | 回答动作行末尾的一个图标，一点把整条回复存成一条记事，标题用**该会话自己的标题** |
| **两个捕获功能都可开关** | 设置里的 `selectionToNotebook` / `messageToNotebook`，下一次渲染即生效，不需重新加载 |
| **新会话自动打开**（默认关闭） | 每有会话变成当前就打开 Notebook——包括页面加载恢复出来的那个；三层 tier 都生效 |
| **「编辑」复用同一个容器** | DOM 里编辑器始终只有 1 个 |
| **图片落盘** | `dataURL` 上传，host 解码写入 `$DSH_HOME/storages/notebook-attachments/<noteId>/`；删除记事时一并删除 |
| **原子写，不静默丢数据** | 临时文件 → `fsync` → `.bak` → `rename`，并由 mutex 串行化。`$DSH_HOME` 不可写时降级为内存态，每个响应带 `degraded: true`，界面顶部显示非阻断提示 |
| **键盘** | `Cmd/Ctrl+Enter` = 完成，`Esc` = 取消（草稿有改动时先问一句） |

更深入的设计说明见〈[实现细节](#实现细节)〉。

## 截图

> 均为真机实测截图：tier 3 那几张来自**没装任何 sidebar 产品**的环境。

| | |
|---|---|
| ![Notebook 面板](docs/images/panel-open.png) | ![编辑容器](docs/images/editor.png) |
| 侧边栏里的 Notebook 列表（`＋` 在右上角），展开时把会话列推挤 400px | 编辑容器：标题 + 正文 + 图片缩略图（粘贴 / 拖入 / 按钮三种入口） |
| ![复制正文](docs/images/list-and-copy.png) | ![standalone 面板](docs/images/collapsed-button.png) |
| 点标题后 toast「已复制正文（67 字）」——复制的是正文，不含标题 | 自绘面板（tier 3）：开合按钮固定在视口右上角 |

另一种形态是融入 `dsh-better-sidebar`（tier 2），见〈[兼容性](#兼容性)〉：

![在 better-sidebar 中打开 Notebook](docs/images/tier2-better-sidebar.png)

## 安装

| | |
|---|---|
| DSH | `>=0.1.1-rc.2` |
| Node | `>=20` |
| 包管理器 | **pnpm**——本仓库不支持 npm |

**从仓库安装：**

```sh
dsh plugin --profile web add github:wyzh0117/dsh-notebook
```

**从源码本地挂载（开发用）：**

```sh
git clone https://github.com/wyzh0117/dsh-notebook.git
cd dsh-notebook
pnpm install
pnpm build            # 产出 lib/index.js、lib/client.js、lib/types/**

dsh plugin --profile web add "link:$PWD"
```

等价的纯手工做法——在 `~/.dsh/profiles/web/package.json` 里：

```jsonc
{
  "dependencies": { "dsh-notebook": "link:/abs/path/to/dsh-notebook" },
  "dsh": { "profile": { "bundles": [ /* … */, "dsh-notebook" ] } }
}
```

然后在 profile 目录里 `pnpm install`。`dsh.profile.bundles` 必须包含 `dsh-notebook`，否则插件不会被加载。

> **本地开发时不要重启你正在用的那个 DSH**（比如 3080 端口的 Web GUI，重启会杀掉当前会话）。需要真机验收时，另起一个隔离环境：
> ```sh
> DSH_HOME=/tmp/dshnb-home npx -y --package @deepseek-ai/dsh dsh web --port 3099
> ```

## 使用

1. 展开右侧栏，打开 **Notebook**。
2. 点右上角 **`＋`** → 编辑器在面板内弹出。
3. 写**标题**和**正文**。正文框随内容缩放（最高到窗口高度的 60%，再长就在框内滚动）。配图可以**粘贴 / 拖入图片**，或点「插入图片」——视频会被拒绝；单图上限 10 MB，单条上限 20 张（都可在设置里调）。
4. 点「完成」（或 `Cmd/Ctrl+Enter`）→ 条目以**标题**陈列。
5. 点**标题文字** → 正文进剪贴板。
6. 想让模型读某条记事：输入框里打 **`@`** 选它，或点该行末尾的 **`对话引用`**。发送时只有**正文**交给模型；页面刷新后需要重新插入引用。
7. 点行尾 **`编辑`** → **同一个容器**载入该条；点 **`删除`** 会先用面板自己的对话框问一次。
8. **让会话替你写一条记事**（v0.2.0）：
   - **在会话里选中文字** → 点选区旁浮现的 **「进记事本」**。
   - **点回答末尾的记事本图标** → 整条回复按会话标题存成一条记事。

   两者都用同一个 toast 确认，也都可以在设置里关掉。

## 兼容性

| | |
|---|---|
| DSH | 最低支持 `>=0.1.1-rc.2`；开发机运行 `0.1.5-rc.2` 并装有 `@deepseek-ai/dsh-client-ui-sidebar-right`，**tier 1 是本机实际生效层** |
| Node | `>=20` |
| `dsh-better-sidebar` | 可选。tier 2 面向 0.4.0–0.18.x；0.19+ 归入 tier 1 |
| DSH 侧可选插件 | 缺 `conversation`、`inputTriggers` 或 `sessions` 时，对应的联动能力自动关闭并退回 v1 行为 |
| 旧版 shell | 每个功能都注册在可选接缝上，只会降级不会坏：槽位不存在则捕获入口根本不出现；读不到 locale 就用插件自带的 `zh` 字典；面板不依赖 `window.confirm` 或任何 dialog API |

### 版本自适应：三层 tier

DSH 的右侧栏在 `0.1.5-rc.1` 前后换了主人：以前由 `dsh-better-sidebar` 这类插件自绘，之后由 DSH 内核自己拥有、插件注册 tab。所以本插件**在客户端做一次性探测**，按优先级落到三层之一，**任何时刻页面上最多只有一个 Notebook 入口**：

| 优先级 | tier | 触发条件 | 注册方式 |
|---|---|---|---|
| 1 | **`native`** | `ctx.get('sidebarRightTabs')` 存在（DSH ≥ 0.1.5-rc.1） | `sidebarRightTabs.register({ id, kind, priority:'extension', title, guide })` + 把 tab 体注册进 keyed 槽 `sidebar.right.pane.tab` |
| 2 | **`service`** | `ctx.get('betterSidebar')` 存在（better-sidebar 0.4.0–0.18.x 及同类产品） | `ctx.betterSidebar.registerTab({ id:'dsh-notebook:notebook', single:true, settings:{…} })` |
| 3 | **`standalone`** | 二者皆无 | 自绘右侧栏，UI 对齐 `dsh-better-sidebar` 0.12.1 |

几个刻意的选择：

- **绝不**把 `betterSidebar` 写进 `export const inject`——`inject` 里缺服务会让插件永不激活，tier 3 就死了。
- 探测是「同步先行 + 异步兜底」：两个 `ctx.get` 都不命中时观察 `ctx.inject`，并挂一个 **700ms 兜底定时器**来挂载 standalone。
- **迟到升级**：standalone 已挂上之后某个服务才出现，会**先拆掉** standalone 再注册到该服务，绝不两个入口并存。
- 所有注册都包在 `ctx.effect(() => { …; return dispose })` 里，HMR / 禁用安全。

### tier 3 的自绘面板

| 项 | 规格 |
|---|---|
| 展开按钮 | 固定在视口右上角的 28×28 按钮，16px 线性图标，延迟 tooltip，`aria-label` 随展开状态切换 |
| 面板几何 | `PANEL_MIN=280` / `PANEL_MAX=640` / `PANEL_DEFAULT=400`，按视口钳制 |
| 宽度拖拽 | 面板左边缘 6px 抓取条（`setPointerCapture` + `clientX` 差值） |
| 窄屏 | `innerWidth < 768` 时合并为全宽 `100vw` 抽屉，不提供拖拽条 |
| 布局推挤 | 设置 `--dsh-notebook-width` 与 `data-dsh-notebook-collapsed` / `-dragging`，由一份命名空间化、`dispose` 时移除的 `<style>` 消费 |
| 收起 | 保持挂载并滑出（`translateX(100%)`），过渡结束才 `visibility: hidden` |
| 持久化 | 展开状态与宽度记在 `localStorage`（`dsh-notebook:open` / `dsh-notebook:width`） |
| 减少动效 | 遵守 `@media (prefers-reduced-motion: reduce)` |

## 设置项

三层 tier **共用同一份定义**，真值存在 host 的 `NotebookDoc.prefs`——读写一律走 `PATCH /notebook/api/prefs`（tier 2 **不用** better-sidebar 自己的 `pluginSettings`，否则三层会不一致）。

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `sortOrder` | `'updated' \| 'created' \| 'title'` | `'updated'` | 列表排序 |
| `copyImagesAsName` | boolean | `true` | 复制正文时把图片写成 `[图片: <文件名>]` 一行 |
| `maxImagesPerNote` | number | `20` | 单条记事图片数上限（1–100） |
| `confirmDelete` | boolean | `true` | 删除前用面板自己的对话框确认；关闭则点一下直接删 |
| `openOnStart` | boolean | `false` | **tier 3 专用**：DSH 启动即展开侧边栏 |
| `autoOpenOnNewSession` | boolean | `false` | 每当有会话变成当前就打开 Notebook |
| `selectionToNotebook` | boolean | `true` | 在会话里选中文字时显示浮动的「进记事本」动作 |
| `messageToNotebook` | boolean | `true` | 在每条回答的动作行末尾显示「存入记事本」图标 |

tier 1 与 tier 3 注册**同一份**全局设置区（`settings.section` 槽，共用 `hosts/settingsSeat.ts`），所以两边字段与文案完全一致；tier 2 走 `registerTab({ settings })`，声明行是 7 项——除只在独立层有意义的 `openOnStart` 外的全部偏好。

## 实现细节

以下内容面向读代码或改代码的人。只想用插件的话可以直接跳到〈[已知限制](#已知限制)〉。

### 架构

```
                     ┌──────────────────────── 浏览器 ────────────────────────┐
                     │ lib/client.js  (CJS 模块表工厂, id = "dsh-notebook")   │
                     │  三层探测 → native / service / standalone              │
                     │  NotebookView ─ NotebookEditor(唯一实例) ─ clipboard    │
                     │  capture (v0.2.0)：选区浮动条 + 回答图标 → capture.ts  │
                     │  正文缩放 (v0.2.1)：textarea → autoGrow.ts             │
                     │  确认框 (v0.2.2)：面板内对话框 → locales.ts            │
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

- `src/client/autoGrow.ts` 是正文框几何唯一的决定处：它测量 `<textarea>` 的内容并写 `height` / `maxHeight` / `overflowY`，而「什么时候测」由 `NotebookEditor` 决定（挂载时、文本变化、宽度变化、视口高度变化）。
- 原生 tier 的 tab 体从槽注入的 `useTabInfo()` 钩子读可见性，所以**隐藏的 tab 真的不加载、不轮询**。
- 图片用 **dataURL** 上传（客户端 `FileReader`），host 解码落盘——避免 multipart 解析依赖。

### 宿主 HTTP API

注册在 `ctx.webServer`（`kind: 'prefix'`，`path: '/notebook/api'`），JSON over HTTP，所有响应带 `Cache-Control: no-store`。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| `GET` | `/notebook/api/state` | — | `{ doc, degraded? }` |
| `POST` | `/notebook/api/notes` | `{ title, body, attachments: [{ name, mime, size, dataUrl }] }` | `{ note }` |
| `PATCH` | `/notebook/api/notes/:id` | `{ title?, body?, attachments? }` | `{ note }` |
| `DELETE` | `/notebook/api/notes/:id` | — | `{ ok: true }` |
| `PATCH` | `/notebook/api/prefs` | `Partial<NotebookPrefs>` | `{ prefs }` |
| `GET` | `/notebook/api/attachments/:noteId/:file` | — | 图片字节 + `Content-Type` |
| `GET` | `/notebook/api/health` | — | `{ ok, version, degraded }` |

- **安全栅栏**：只接受 loopback 请求（`req.socket.remoteAddress ∈ 127.0.0.1/::1`），并校验 `Origin`/`Host` 属于允许的本地来源，否则 `403`；路径参数做防穿越校验；单请求 body 上限 32 MB（超限 `413`）。
- `400/403/404/413/415/500` 都返回结构化 `{ error: { code, message } }`。
- **host 端二次校验视频**（不信任客户端）：命中即 `415`。

### 数据落盘

| 路径 | 内容 |
|---|---|
| `$DSH_HOME/storages/notebook.json` | `NotebookDoc`（`version: 1`、`notes[]`、`prefs`），原子写 |
| `$DSH_HOME/storages/notebook.json.bak` | 上一次成功版本；JSON 损坏时先尝试用它恢复 |
| `$DSH_HOME/storages/notebook-attachments/<noteId>/<attachmentId>.<ext>` | 图片字节 |

`$DSH_HOME` 优先级：显式注入 > `process.env.DSH_HOME`（纯空白视为未设置）> `~/.dsh`。`.bak` 也损坏时从空文档开始，并把坏文件改名为 `notebook.json.corrupt-<ts>`。

### 与 DSH 会话联动（v1.1）

这里的接缝都只走**公开 seam** 且**全部可选**：客户端 bundle 只能 require 模块表里的包，import 不了 DSH 的 UI 包，所以一律鸭子类型 + 逐调用守卫。

**`@` 引用。** 插件通过 `ctx.inputTriggers.registerSource` 注册名为 `dsh-notebook` 的 `@` 源（`order: 20`），输入 `@` 时与文件、会话并列。候选按输入**大小写不敏感**匹配标题与正文，最新在前、最多 8 条；查询被 abort 或读取失败时返回空列表，而不是打断整个菜单。选中一行插入原子 chip，其剪贴板形式是 `@[标题](dsh-notebook:<noteId>)`。**发送时只序列化正文**（标题绝不发给模型），每个图片标记写成一行 `[图片: <文件名>]`：**记事已删除**则这段引用自然消失，**真实读取失败**则拦下发送并给出可见错误，而不是把 mention 悄悄降级。

**自动打开。** 触发条件是会话列表里**当前会话变成另一个**——同一会话的快照重复发布不算，激活那一刻已经是当前的会话也不算。`openTab` 在席位还没持有 binding 时会抛，所以按 `0 / 200 / 500 / 1200 / 2500 ms` 重试，会话再次变化即放弃。由于插件在会话列表到达之前就已激活，页面加载恢复出来的选中项同样算「变成当前」。

**输入框附件桥：已实现、有单测、但没有接线。** 点标题必须**只复制**、绝不自己往输入框里写，所以它唯一的入口被移除了（产品决定，2026-09-15）。接缝才是贵的那部分且已有覆盖，因此 `composer.ts` 与它的单测被刻意保留，等一个属于它自己的显式动作来接。当前**没有任何 UI 能触发它**。

**为什么「打开」本身就是「展开」（v0.2.2 的 bug，v0.2.3 的修复）。** `sidebarRight.openTab(kind)` 在打开的同时就展开这一列（store 计划里的第一个操作就是 `planSetExpanded(state, true)`），而 `isExpanded()` 回答的是席位在**上一次已提交渲染**时绑定的 surface——所以与 `openTab()` 处于同一个同步块里的读取落后一次 React 提交。v0.2.2 读到那个过期的 `false`，又用 `toggleExpanded()` 去「纠正」，而它翻的是**实时**值，于是把刚被打开揭示出来的那一列收了回去。DSH 在 `ctx.sidebarRight` 上没有幂等的 `setExpanded()`，外部没有安全的纠正手段，所以现在只调 `openTab`；`test/auto-open.test.ts` 按宿主真实语义建模，并断言最终是展开的、且 `isExpanded` / `toggleExpanded` 一次都没被调用。

### 从对话里捕获（v0.2.0）

会话有两条路可以往记事本里写，二者都**与 tier 无关**（它们属于 shell，不属于任何侧栏载体）也都**默认开启**。它们共用同一条写入路径——`client/capture.ts`——所以标题编号、保存顺序与 toast 不会各走各的。

```
selection ──► selectionAction.ts ─┐
                                  ├──► capture.ts ──► POST /notebook/api/notes ──► NotebookDoc.notes
assistant answer ──► answerAction.ts ─┘        (标题编号 · 串行写入 · 订阅者 · toast)
```

| | 选中文字 → 记事本 | 回答 → 记事本 |
|---|---|---|
| 入口 | 选区旁的浮动小条（`shell.overlay`） | 已定稿消息动作行末尾多出来的一个图标 |
| 偏好 | `selectionToNotebook` | `messageToNotebook` |
| 标题 | 编号默认名 `未命名n`——取没有任何既有标题占用的最小 `n`，所以删掉 `未命名2` 之后下一次捕获会补上这个号 | **该会话自己的标题**；会话还没有标题时用编号默认名，而不是一个用户从没选过的占位标题 |
| 正文 | 选区**逐字原文**（不 trim） | 回答里每个 `text` 块按顺序拼接、中间空一行；`reasoning`、`tool-call`、`image` 块一律略去 |
| 拒收 | 空或纯空白的选区；落在输入框、任何可编辑控件、或本插件面板内的选区；会话之外的选区 | 读不到快照时不提供；行上没有可用 message id 时也隐藏（被打断的回答本来就不带 id） |

**这个动作落在行里的哪一格。** DSH 的槽位渲染在消息行的扩展带里，也就是硬编码的**复制**与**分支**按钮之间。`order: 20` 让本插件排在官方那对好评按钮之后，所以这个图标是*这个槽位能表达*的最后一项——它不可能排到「分支」之后。

**编号归捕获服务所有。** 一个标题由「宿主当前持有的记事」**加上**「这次激活已经铸出的标题」共同决定，并一直占着直到那次请求落定：即便记事列表读不到，连续捕获也不会撞号；而保存失败会释放编号，重试仍铸同一个。保存是串行的，所以这个读改写不会交错。

**选区范围，如实说。** DSH 没有暴露选区服务，所以这个功能自己盯着 document，并从 shell 的语义化 DOM 钩子（`[data-chat-flow]`、`[data-conversation-scroll]`，再到 `[data-slot=…]`）判断什么算「在会话里」。将来的 shell 若改掉这些名字，该功能会降级为「输入框之外、也不在我们自己面板里的任意选区」，而不是静默地永不触发。

## 已知限制

以下为 v1 / v1.1 / v0.2.0–v0.2.3 有意不做的部分。

- **不支持视频 / 音频等富媒体**——需求明确排除项，client 与 host 双侧都拒绝。
- 不做多用户、云同步、分享、实时协同、AI 自动整理，也**没有版本历史**（只保留最近一次内容）。
- 笔记**全局共享**，不按会话隔离。
- **正文框最高只到视口高度的 60%**：更长的记事在框内滚动。不封顶就会把标题和「完成 / 取消」挤出面板，代价是编辑超长记事时无法一次看全。手调高度随拖拽把手一起移除，没有做成按记事保存的偏好。
- 正文是**纯文本 + Markdown 图片标记**（`![name](attachment:<id>)`），不是富文本。
- **引用只送正文，不送标题**——`@[标题](…)` 里的标题是给人看的标签，序列化时被有意丢弃。
- **未发送的 `@` 引用在页面刷新后会退化成字面 mention**：DSH 把未发送的草稿按剪贴板投影存进 `localStorage`，而本插件没有 host 半侧的 mention 解析器，所以模型收到的是字面文本 `@[标题](dsh-notebook:<noteId>)`。规避：发送前别刷新，或刷新后重新插入引用。在 `agent/pre-step` 接同一条 seam 做展开是已确定的修法，v1.1 有意不做。
- **SVG 走不了输入框附件桥**（只收 png/jpeg/webp/gif）。记事本身仍支持 SVG，而这条桥当前也没有 UI 入口。
- **「新会话自动打开」在没有打开手势的载体上失效**；极窄的窗口上 DSH 还会在放进 tab 后强制收起右栏——这是宿主的空间规则，本插件有意不与它较劲。
- **回答图标排不到「分支」之后**：槽位渲染在扩展带里，`order: 20` 已经是它所能表达的最后一位。
- **回答是按正文存的，不是按对话记录存的**：只有 `text` 块会被存下来，回答里渲染出来的图片也**不会**复制进记事。
- **选区浮动条跟着 shell 的 DOM 钩子走**：将来的 shell 改掉这些名字只会让范围降级而不是坏掉；但对于浏览器已经报不出几何信息的*陈旧选区*，它无法提供这个动作。
- **捕获到的记事是立即写入的，没有确认步骤**：这正是这两个动作的意义，但也意味着一次误点就会落一条记事，用户随后得手工删掉。
- **v1.1 的会话联动与 v0.2.0 的两个捕获入口没有人工点过 GUI**：契约是读已发布的 `0.1.5-rc.2` 包对齐出来的，并由单元 / 组件测试钉住（见〈[验证状态](#验证状态)〉）。
- 不修改 DSH 源码（硬约束）。

## FAQ

**我贴了 mp4，为什么没反应？**
不支持视频。客户端与 host 双侧都会拒收，并提示「不支持视频文件」。

**为什么点标题复制出来的正文里图片变成了 `[图片: 文件名]`？**
剪贴板里写的是纯文本，而图片是磁盘上的文件。把设置里的 `copyImagesAsName` 关掉，图片标记就会整段略去。

**点标题会把记事里的图片送进输入框吗？**
不会。附件桥已实现但未接线，当前**没有任何 UI 能触发它**：点标题永远只把正文复制到剪贴板。

**`@` 引用发出去的是什么？**
只有正文——chip 上显示标题，但标题**不会**交给模型。被引用的记事如果已删除，这段引用什么都不贡献；读取真失败时发送会被拦下并报错。

**为什么刷新页面后，之前插的 `@` 引用变成了 `@[标题](dsh-notebook:xxx)`？**
DSH 把未发送的草稿按剪贴板投影存进 `localStorage`，而本插件没有 host 半侧的 mention 解析器，所以 chip 退化成字面文本。发送前别刷新，或刷新后重新插入引用。

**笔记存在哪里？会上传吗？**
全部在本机 `$DSH_HOME/storages/` 下。没有任何远端上传，HTTP API 只监听 loopback。

**我在会话里选了文字，为什么没有出现「进记事本」按钮？**
有四种刻意的拒收：选区是空的或纯空白；选区落在输入框或任何可编辑控件里（提示词草稿不是记事）；选区落在记事本面板自身内；浏览器报不出它的几何信息。只要 shell 暴露了自己的对话记录容器，*会话之外*的选区同样不提供。若始终不出现，也可能是被关掉了：到设置里看「选中文字可存入记事本」。

**回答里的哪一部分会被存下来？标题从哪来？**
存的是正文：每个 `text` 块按顺序拼接、中间空一行（整条回答只有工具调用时会如实说明，而不是写一条空记事）。标题取**该会话自己的标题**，会话还没有标题时用编号默认名。存下来之后它和别的记事一样。

**图片会不会丢？**
不会静默丢。上传失败的条目会保留为错误项并可重试；`$DSH_HOME` 不可写时降级为内存态，每个响应带 `degraded: true`，界面顶部显示非阻断提示。

**能同时装 better-sidebar 吗？tier 1 在我这台机器上能跑吗？**
能，那正是 tier 2。至于 tier 1：DSH < 0.1.5-rc.1 就没有 `ctx.sidebarRightTabs`，插件会自动落到 tier 2 或 tier 3。

**`pnpm install` 报 `ERR_PNPM_NO_MATCHING_VERSION: @deepseek-ai/dsh-*`？**
那是 pnpm 在自动安装 peer。本仓库根的 `pnpm-workspace.yaml` 已设 `autoInstallPeers: false`（pnpm 11 从此处读项目配置）；若你在别处复刻包配置，加上同样的设置即可。

## 开发

```sh
pnpm install        # 只用 pnpm，npm 在本仓库不受支持
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run（host 用 node 环境，*.test.tsx 用 jsdom）
pnpm build          # tsc -p tsconfig.build.json && tsdown → lib/index.js + lib/client.js + lib/types/**
pnpm watch          # tsdown --watch
```

`pnpm-workspace.yaml` 只有一条配置 `autoInstallPeers: false`。原因：`dsh-better-sidebar` 是 *optional* peer，pnpm 会去解析它并选中 0.19.x，而 0.19.x 的 `@deepseek-ai/*` peer 范围（`^0.1.5`）在 npm 上只有预发布版，semver 不允许非预发布范围匹配预发布版本，安装会以 `ERR_PNPM_NO_MATCHING_VERSION` 失败。本仓库真正需要构建的 peer 全部是显式 `devDependencies`，关掉 peer 自动安装不影响任何东西。

客户端产物不是普通 ESM，而是注册到全局模块加载器的 CJS 闭包工厂：

```js
window.__ModuleLoader__.load({ id: "dsh-notebook", factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  /* …打包后的 CJS 代码… */
  exports.apply = apply; exports.inject = inject;
  return module.exports;
} });
```

因此 `src/client/**` 里**禁止** `node:*` 导入，**禁止**除模块表外部项（`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`）之外的 `@deepseek-ai/*` **值导入**；`codeSplitting: false` 也是必须的（工厂里的 `require` 无法解析相对 chunk URL）。

### 验证状态

| 项 | 方式 | 结果 |
|---|---|---|
| `tsc --noEmit` | 全仓 | 0 错误 |
| 单元 / 组件测试 | `vitest run` | **312 passed (20 files)** |
| 构建 | `tsc -p tsconfig.build.json && tsdown` | `lib/index.js`（ESM）+ `lib/client.js`（CJS）+ map + `lib/types/**` |
| 客户端 bundle 形态 | CI 里用 stub `require` 实际执行 `lib/client.js` | `id=dsh-notebook`、`inject===['slots','locale']`、零 `node:` require |
| **tier 3**（无 sidebar 产品） | 真浏览器实测 | 开合按钮钉在视口右上角；展开后 `--dsh-notebook-width: 400px` 且 `#root` 被推挤 400px；左边缘 6px 拖拽条；收起时滑出且推挤归零 |
| **tier 3 核心流程** | 真浏览器逐条实测 | 编辑器容器恰好 1 个；png 贴入成功、mp4 被拒；「完成」后条目以标题陈列；点标题 → 剪贴板拿到**正文（不含标题）**且图片变 `[图片: nb-test-image.png]`；「编辑」仍复用同一个容器且内容全部回填 |
| **tier 2**（装 `dsh-better-sidebar@0.12.1`） | 真浏览器实测 | 自绘面板完全不挂载；better-sidebar 的「New tab」里多出 **Notebook**，读到同一份全局笔记 |
| 持久化 | 重启 + 换安装通道后复测 | `notebook.json`、`.bak`、附件目录落盘正确，换成 release tarball 安装后数据仍在 |
| 发布产物 | 用 release tarball 装进干净 profile | `dsh plugin` 挂载成功，host 路由与客户端 bundle 均正常 |
| CI | GitHub Actions | 绿 |
| **v1.1 产物已上线**（运行中的 3080 实例） | `GET /plugins/??dsh-notebook/client.js&rev=<hash>` | **200**，含 v1.1 的符号；已下线的附件提示文案不再出现 |
| **host 路由在线** | `GET /notebook/api/state`、`…/attachments/<noteId>/<file>` | `state` → `200 application/json` 返回真实文档；附件 → `200 image/png` |

tier 1（DSH ≥ 0.1.5-rc.1 的原生右侧栏）**没有人工点过 GUI**：注册序列由 `test/tier-detect.test.ts` 用假 ctx 覆盖，并已按 `0.1.5-rc.2` 的**真实类型声明**核对（记录在 `src/client/hosts/native.ts` 文件头）。v1.1 的用户可见功能（`@` 引用、新会话自动打开）与 v0.2.0 的两个捕获入口同样如此——实机走一遍需要重新构建 `lib/client.js` 再由刷新后的页面加载，这是用户侧的步骤，不是本仓库测试套件能断言的。相对地，v0.2.1 的正文缩放**在真浏览器里确认过**：空编辑器 120px、60 行正好顶到 `round(929 × 0.6) = 557px` 上限并改为框内滚动、删回 1 行回到 120px、只改视口高度时上限重新钳制、一次无关的 React 重渲染零次 style 写入。

<details>
<summary>各功能对应的测试覆盖</summary>

| 功能 | 测试 | 断言到哪一步 |
|---|---|---|
| 输入框附件桥（**未接线，无 UI 入口**） | `composer.test.ts`（31）；`view-actions.test.tsx`（7）断言的是**相反**的行为 | 目标解析、落盘图片读回成 `File`、`createDrafts` + `addAttachments` 调用序列、拒收时释放草稿、SVG 跳过、张数上限、三条文本写入路径、不谎报成功。UI 级别：点标题只复制并把输入框完全放在一边 |
| `@` 引用 + 「对话引用」 | `reference.test.ts`（17）+ `view-actions.test.tsx`（7） | 只注册一次且可 dispose、注册被拒时按预算重试、过滤 / 排序 / 8 条上限、chip 与规范 mention、**序列化只含正文不含标题**、已删除的记事序列化为空、真实读取失败向上抛、`refUnavailable` |
| 新会话自动打开 | `auto-open.test.ts`（16）+ `tier-detect.test.ts`（16）+ `native-tab-body.test.tsx`（3） | 激活时已存在的会话不触发、会为页面加载恢复出来的会话打开、同一会话的快照不重复触发、席位无 binding 时按 `0 / 200 / 500 / 1200 / 2500 ms` 重试、三层 tier 各接自己的手势，以及原生手势**只有** `openTab`——最终展开、`isExpanded` 一次未读、`toggleExpanded` 一次未调 |
| 捕获：选中 → 记事本 | `selection-action.test.tsx`（35）+ `capture.test.ts`（21）+ `capture-surfaces.test.tsx`（19） | 经真实 DOM 钩子做范围判定、各种拒收、四边位置钳制、点击时不能先取消选区、正文是逐字原文、一次点击只产生一条记事、偏好即时生效 |
| 捕获：回答 → 记事本 | `answer-action.test.ts`（18）+ `capture-surfaces.test.tsx`（19）+ `tier-detect.test.ts`（16） | 两种快照形态与版本错配形态、无 id 回答绝不被空 id 匹配、只拼 `text` 块、会话标题与其兜底、空回答如实提示、`order > 10` |
| 标题编号 + 写入顺序 | `capture.test.ts`（21） | 取**最小空闲序号**、连续捕获不复用、按调用顺序串行化、保存失败释放编号、纯空白输入 no-op |
| 正文自动缩放 | `auto-grow.test.ts`（12）+ `editor-autogrow.test.tsx`（8） | 上限与兜底、让「能缩回去」成为可能的 `height: auto` 复位、120px 下限、超上限切 `overflowY: auto`、幂等，以及驱动真实 `<textarea>` 的变高 / 缩回 / 重测 |
| 确认框与语言 | `editor.test.tsx`（15）+ `locales.test.ts`（10）+ `capture-surfaces.test.tsx`（19） | 面板自己的 `alertdialog`、三种「不删」、关闭确认时直接删、连点两下只发一次请求，以及 **`window.confirm` 从未被调用**；语言读取顺序与全部兜底 |
| 偏好的 HTTP 往返 | `api.test.ts`（12） | 规范化、**缺失**的偏好回落到开启而不是被丢掉、id 百分号编码、错误信封 |

另有一条防漂移守卫：`test/routes.test.ts` 的「accepts EVERY preference key the plugin exposes」断言 `PATCH /notebook/api/prefs` 接受的 key 集合等于 `Object.keys(DEFAULT_PREFS)`——正是它抓出了 `/prefs` 静默丢掉 `autoOpenOnNewSession` 的真实 bug。

</details>

## 参与贡献

欢迎提 issue 和 PR。先说两条硬规矩：

- **只用 pnpm。** 本仓库不支持 `npm` / `yarn`；由其它包管理器造成的 lockfile 不一致，我们无法处理。
- **绝不修改 DSH 源码。** 这是项目的硬约束，不是个人偏好。

**本地验收门槛**——CI 在 Node 22 上跑的正是这四条（pnpm 11 自身需要 Node ≥ 22.13，而插件本身仍运行在 `engines` 声明的 Node ≥ 20），外加用 stub `require` 实际执行 `lib/client.js` 断言产物形态：

```sh
pnpm install && pnpm typecheck && pnpm test && pnpm build
```

**报 bug**——请用 [bug report 模板](.github/ISSUE_TEMPLATE/bug_report.md)。真正决定处理速度的字段是 DSH 版本、已安装的 `dsh-better-sidebar` 版本，以及**当时生效的是哪一层 tier**（`native` / `service` / `standalone`）。

**提 PR**——清单在 [PR 模板](.github/pull_request_template.md) 里。要点：贴上真实的 `typecheck` / `test` / `build` 输出；说明改动触及哪些部分（tier 1 / tier 2 / tier 3、host 半侧，或仅构建 / CI / 文档）；用户可见行为或设置项有变化时，两份 README 都要更新。

**PR 不能破坏的约束：**

- 不新增视频 / 音频支持路径——v1 明确排除富媒体，双侧都在拦截；
- `cordis`（裸包名）绝不能进 `dependencies` / `peerDependencies` / `optionalDependencies`；
- 不新增 `preinstall` / `install` / `postinstall` / `prepare` 脚本；
- `src/client/**` 里不得导入 `node:*`，也不得在共享模块表之外新增 `@deepseek-ai/*` 的**值导入**；
- 客户端 bundle 注册的 id 必须始终等于包名（`dsh-notebook`）。

## 版本历史

| 里程碑 | 状态 | 内容 |
|---|---|---|
| **v0.1.0** | 已打 tag | 记事本本体：新建 / 编辑 / 删除、标题 + 正文、图片（拒视频）、点标题复制正文、唯一的可复用编辑容器、三层 tier 自适应、原子写与 `.bak` 恢复、仅监听 loopback 的 HTTP API。 |
| **v1.1** | 已并入 `main`，**尚未打 tag** | `@` 引用与行内「对话引用」按钮、新会话自动打开。输入框附件桥以代码 + 单测形式落地，但**没有任何 UI 入口**。 |
| **v0.2.0** | 已发布 | 会话 → 记事本捕获：选区上的浮动「进记事本」动作、每条回答末尾的「存入记事本」图标；两者共用同一条串行写入路径，都可开关。 |
| **v0.2.1** | 已发布 | 正文框随内容自动缩放，下限 120px、上限视口高度的 60%；手动拖拽把手移除。 |
| **v0.2.2** | 已发布 | 两个确认框搬进面板内部（代码里不再有任何 `window.confirm`），所有文案跟随 shell 语言。 |
| **v0.2.3** | 本次发布 | 「新会话自动打开记事本」真的会打开侧边栏——把刚打开的列收回去的「先读后翻」已删除；偏好还在加载时变成当前的会话也不再被丢掉。 |

`package.json` 声明的是 `0.2.3`；v1.1 的改动作为 v0.2.0 的一部分一起发布，没有单独打 tag。

## 许可

[MIT](./LICENSE) © 2026 wyzh0117
