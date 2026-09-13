# dsh-notebook v1 — 设计与实现规格（权威版）

> 本文是实现的唯一权威依据。实现者不需要重新推导架构；遇到本文未覆盖的细节，先读
> `.recon/*.md`，再向编排者提问，不要自行发明接口。

---

## 0. 目标 / 非目标

### 目标（v1 必须全部达成）

| # | 需求 | 验收方式 |
|---|---|---|
| G1 | 有 sidebar 产品（如 dsh-better-sidebar）时，本插件**融入**它：展开 sidebar 后，在原有可选内容基础上**多出本产品**一项 | 设备 A（已装 better-sidebar 0.12.1）展开侧边栏，「+」菜单/标签列表出现 Notebook |
| G2 | 没有 sidebar 产品时，本插件**自带** sidebar 展开能力，UI 完全挪用 dsh-better-sidebar：展开按钮位置、展开后缩放、settings 自定义内容 | 隔离环境（未装 better-sidebar）实测 |
| G3 | side bar 页内「＋」按钮新建条目 | 点击后出现新条目编辑容器 |
| G4 | 新建后弹出**文本框容器**；容器内可放图片文件，**不可放视频** | 粘贴/拖入图片成功；视频被拒绝并有提示 |
| G5 | 可写**标题**和**正文** | 两个输入区 |
| G6 | 点「完成」关闭容器，内容以**标题**形式一条条陈列 | 列表出现该标题行 |
| G7 | 点**标题** → 正文（不含标题）自动同步到剪贴板 | 剪贴板内容 == 正文 |
| G8 | 点「编辑」→ 弹出**同一个容器**（不是新容器），继续编辑该条目 | DOM 中编辑器容器实例数为 1 |
| G9 | 上传到 `wyzh0117/dsh-notebook`（private） | `gh repo view` 显示 private |
| G10 | 向 dsh-market 提交注册本插件的 PR | PR URL |

### 非目标（v1 不做）

- 多用户/云同步；笔记分享；版本历史（只保留最近一次）。
- 视频、音频等富媒体（明确排除）。
- 实时协同、AI 自动整理。
- 修改 DSH 源码（**硬约束**）。
- 上架 npm（v1 走 GitHub 分发；dsh-market PR 按 `.recon/dsh-market-pr.md` 的要求执行）。

---

## 1. 已验证的环境事实（2026-09 实测，勿凭记忆推翻）

| 事实 | 值 | 证据 |
|---|---|---|
| 本机 DSH | `0.1.1-rc.2` | `node ~/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js --version` |
| npm 上 DSH | `latest=0.1.5-rc.1`、`next=0.1.5-rc.2` | registry.npmjs.org dist-tags |
| 本机 better-sidebar | `0.12.1`（自绘右侧栏） | `~/.dsh/profiles/web/package.json` |
| better-sidebar 最新 | `0.19.x`，**要求 DSH ≥ 0.1.5-rc.1**，不再自绘右栏 | 上游 README IMPORTANT 段 |
| 本机是否存在 `ctx.sidebarRightTabs` | **不存在**（0.1.1-rc.2 无右侧栏包） | 全量 grep `@deepseek-ai/*` 无命中 |
| `ctx.sidebarRightTabs` 属主 | `@deepseek-ai/dsh-client-ui-sidebar-right@0.1.5-rc.2` | 已下载 tarball 于 `/tmp/dsh-new/sr` |
| 本机可用 slots | `root` / `sidebar` / `conversation` / `details` / `shell.overlay` / `settings.plugin.item` / `tool.view.cordis` / `conversation.input.overlay` | 各包 `SlotMap` augmentation |
| DSH_HOME 可重定向 | 环境变量 `DSH_HOME` | `@deepseek-ai/dsh-home-paths` |
| DSH 存储约定 | `$DSH_HOME/storages/*.json` | 本机 `~/.dsh/storages/` |
| gh 登录账号 | `wyzh0117`（id 101866233） | `gh auth status`（用户已确认用它，`wyzh843` 不存在） |
| 用户已定决策 | 笔记**全局共享**；图片**存宿主磁盘+引用路径** | 会话内澄清 |

---

## 2. 架构：三层自适应注册（本设计的核心）

本插件在**客户端**必须能同时适配三种宿主情形，且**只注册一次**（不得重复挂载）。

### 2.1 三层定义与优先级

```
tier 1  native      ctx.sidebarRightTabs / ctx.sidebarRight 存在
                    → 注册 DSH 原生右侧栏 tab（IMPORTANT 段指定的方式）
tier 2  service     ctx.betterSidebar 存在（better-sidebar 0.4.0–0.18.x 及其它同类产品）
                    → ctx.betterSidebar.registerTab(...)
tier 3  standalone  二者皆无
                    → 自绘右侧栏（UI 完全对齐 better-sidebar）+ 自注册设置区
```

**优先级就是 1 > 2 > 3。** 理由（对应需求 5 的「合适的注册方式」）：
上游 IMPORTANT 段声明 v0.19.0 起右列完全属于 DSH，tab 类型与 tab 体通过
`ctx.sidebarRightTabs` / `ctx.sidebarRight` 注册，插件不再自绘右栏。因此当 DSH 提供原生右栏时，
**原生注册才是正解**；此时无论 better-sidebar 是 0.19（把 tab 转到原生栏）还是未安装，
我们的 tab 都会出现在用户展开的那一列里，天然满足 G1。

### 2.2 服务探测与"只注册一次"

- **不能用 `export const inject = ['betterSidebar']`**：服务不存在时插件将永远不激活，
  standalone 层就没机会跑。inject 只声明**必然存在**的核心服务。
- 探测顺序（`apply()` 内同步先行，异步兜底）：

```ts
export const inject = ['slots', 'locale']

type Tier = 'native' | 'service' | 'standalone'
```

1. 同步：`ctx.get('sidebarRightTabs')` → 有则 `registerNative()`，置 `tier='native'`。
2. 同步：`ctx.get('betterSidebar')` → 有则 `registerService()`，置 `tier='service'`。
3. 都没命中：注册两个 `ctx.inject` 监听（`ctx.inject(['sidebarRightTabs'], cb)` /
   `ctx.inject(['betterSidebar'], cb)`），并在 `ctx.effect` 内挂一个**兜底定时器**
   （`window.setTimeout(fn, 700)`，effect 的 disposer 里 `clearTimeout`）：
   定时器触发时若 `tier` 仍为 `undefined` → `mountStandalone()`，置 `tier='standalone'`。
4. **迟到升级**：若 `tier==='standalone'` 之后某个服务才出现，必须
   `unmountStandalone()` 再 `registerNative()`/`registerService()`，保证页面上只有一个 Notebook 入口。
5. 所有注册都包在 `ctx.effect(() => {...})` 内并返回 disposer（HMR / 禁用安全）。
   **不包 effect 会导致二次激活抛 "already registered"。**

### 2.3 tier 1 — 原生注册（DSH ≥ 0.1.5-rc.1）

原生注册是**两阶段**的（见 `dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts`）：

**阶段一：类型**
```ts
const TAB_ID = 'dsh-notebook'          // 同时是 kind 与 body 的注册 key
ctx.effect(() => ctx.sidebarRightTabs.register({
  id: TAB_ID,                          // 实现身份，全局唯一
  kind: TAB_ID,                        // 类型判别式，openTab 用它
  priority: 'extension',               // 外部插件默认档
  title: () => t('title'),             // 页面型：地址参数忽略
  guide: [{                            // 「新建标签页」列表里的入口
    order: 60,
    title: () => t('title'),
    description: () => t('description'),
    icon: NotebookGlyph,
  }],
}))
```

**阶段二：tab 体**注册进 keyed 槽 `sidebar.right.pane.tab`，key 用同一个 `id`。
槽的 `inject` 形状是 `{ hooks: { tabInfo: SlotHookFactory<...> } }`，props 形如
`SidebarRightTabInfo`（含 `panel.id` / `tab.actions` / `tab.visible` / `tab.navigation` / `sidebar.expanded`）。

> ⚠️ **实现前必读**：`.recon/dsh-plugin-architecture.md` 第 4 节给出 0.1.1-rc.2 的
> `ctx.slots.register` 确切签名；`sidebar.right.pane.tab` 属于 0.1.5+，
> 本机装不到，**tier 1 代码按类型声明写、用 fake ctx 做单测**，不追求本机真机跑通。
> 允许 tier 1 只在「类型定义 + 注册调用序列」层面被测试覆盖。

**打开方式**：`ctx.sidebarRight.openTab('dsh-notebook', { params })`，需要时
`ctx.sidebarRight.toggleExpanded()` 展开。

### 2.4 tier 2 — better-sidebar 服务注册

```ts
import type {} from 'dsh-better-sidebar/client/service'   // 触发 ctx.betterSidebar 类型合并
ctx.effect(() => ctx.betterSidebar.registerTab({
  id: 'dsh-notebook:notebook',
  title: () => t('title'),
  description: () => t('description'),
  icon: NotebookGlyph,      // ReactNode 或 (size:number)=>ReactNode
  order: 60,
  single: true,             // ≡ dedupeKey: () => id，打开时聚焦而非新开
  component: ({ ctx, scope, visible }) => <NotebookView host={...} scope={scope} visible={visible} />,
  settings: { /* 见 §5 */ },
}))
```

- `package.json` 里 `dsh-better-sidebar` 必须是 **peerDependency + optional: true**，
  **不能是 dependency**（避免两份实例），且代码里不得有对它的运行时 `import`（只用 `import type`）。
- 类型导入走 `dsh-better-sidebar/client/service` 子路径（纯浏览器侧，零 Node 依赖）。

### 2.5 tier 3 — 自绘右侧栏（无任何 sidebar 产品）

UI 必须**完全对齐 dsh-better-sidebar 0.12.1**（证据：`DSH-better-sidebar/src/client/`）：

| 项 | 规格 | 出处 |
|---|---|---|
| 展开按钮位置 | `toggleCluster` **固定在视口右上角**（`position: fixed; top/right` 贴角），面板打开时压在面板右上角内；16px 线性面板图标（右栏用 `IconPanelRightOutline16`，即"框架+右侧填充条"）；带 500ms 延迟 Tooltip | `Sidebar.tsx:713-737`、`icons.tsx:11` |
| 按钮行为 | 点击切换展开/收起；`aria-label` 随状态变化 | `Sidebar.tsx:730` |
| 面板位置 | 右侧，纵向从顶到（底栏之上）；收起时 `panelHidden` **保持挂载**并滑出，动画结束后隐藏 | `Sidebar.tsx:745+` |
| 面板宽度 | `PANEL_MIN=280` / `PANEL_MAX=640` / `PANEL_DEFAULT=400`；也可按视口百分比（20–60%，下限 280、上限 clamp 到视口） | `state.ts:92-94, 613-621, 743-747` |
| 宽度拖拽 | 左边缘 `panelResize` 拖拽条，`setPointerCapture` 后按 `clientX` 差值改宽 | `Sidebar.tsx:760+` |
| 窄屏 | `innerWidth < 768`（`NARROW_MAX_WIDTH`）时合并为全宽抽屉 `width: 100vw`，不提供拖拽条 | `breakpoints.ts:15-20`、`Sidebar.tsx:753` |
| 动画 | 滑入滑出（panel 位移过渡），收起后 `visibility` 隐藏 | `Sidebar.tsx` panel 样式 |
| 持久化 | 展开状态与宽度按 **localStorage** 记忆（v1 不做按会话隔离，笔记本身全局） | 本设计（简化） |
| 标题栏 | 面板顶部一行：图标 + 「Notebook」标题 + 「＋」新建按钮 + 收起按钮 | 本设计（对齐 better-sidebar 的 TabBar 观感） |
| 挂载方式 | `createPortal` 到 `document.body`，React `createRoot` 独立根；`ctx.effect` 卸载时 `root.unmount()` | 对齐 better-sidebar 做法 |

**样式隔离**：自绘面板必须用**内联 `style` 对象或注入 `<style>` 时给所有类名/选择器加
`dshnb-` 前缀 + 作用域根属性**，绝不污染 DSH 主界面。v1 采用 **inline style 对象**（不引 CSS 文件），避免构建期 CSS 处理。

**设置内容**：tier 3 时向 DSH 设置壳注册本插件的设置区（`settings.plugin.item` 槽或
`ctx.settingsScope` 等价物——以 `.recon/dsh-plugin-architecture.md` 第 6 节为准）；
其内容与 tier 2 的 `settings.pluginToggles` **保持同一份字段定义**（见 §5）。

### 2.6 自适应适配器接口（实现时的内部抽象）

```ts
/** 一个侧边栏承载面。三种 tier 各实现一个。 */
interface SidebarHost {
  readonly tier: 'native' | 'service' | 'standalone'
  /** 注册 Notebook 页面；返回 disposer。 */
  register(view: NotebookViewFactory): () => void
  /** 让用户看到 Notebook（展开侧边栏并激活它）。 */
  reveal(): void
  /** 注册/暴露插件设置面板。 */
  publishSettings(spec: NotebookSettingsSpec): () => void
}
```

`NotebookViewFactory = (props: { scope: SessionScope; visible: boolean }) => ReactNode`。

---

## 3. 数据模型与存储

### 3.1 类型（`src/shared/types.ts`，host 与 client 共用）

```ts
export interface NotebookAttachment {
  id: string            // nanoid/uuid
  name: string          // 原始文件名（清洗后）
  mime: string          // image/png | image/jpeg | image/gif | image/webp | image/svg+xml
  size: number          // bytes
  relPath: string       // 相对 attachments 根：'<noteId>/<id>.<ext>'
  width?: number
  height?: number
  createdAt: number
}

export interface NotebookNote {
  id: string
  title: string
  /** 正文：纯文本 + 图片占位标记 `![alt](attachment:<attachmentId>)` */
  body: string
  attachments: NotebookAttachment[]
  createdAt: number
  updatedAt: number
}

export interface NotebookDoc {
  version: 1
  notes: NotebookNote[]      // 按 updatedAt 倒序由 host 保证
  /** 插件偏好；三层 tier 共用同一份，由 host 持久化以保证跨 tier 一致 */
  prefs: NotebookPrefs
}
```

- 正文用**纯文本 + Markdown 图片标记**：剪切板复制时直接发纯文本（图片以文件名行呈现，
  见 §4.5），编辑时再解析回图片节点。v1 不引入富文本编辑器依赖。
- **视频一律拒绝**：client 端按 `mime.startsWith('video/')` 或扩展名（mp4/mov/webm/mkv/avi/m4v/ogv）
  拦截并提示；**host 端二次校验**同样的规则（不信任客户端），返回 415。

### 3.2 磁盘布局

```
$DSH_HOME/storages/notebook.json                 # NotebookDoc（原子写）
$DSH_HOME/storages/notebook.json.bak             # 上次成功版本
$DSH_HOME/storages/notebook-attachments/
    <noteId>/<attachmentId>.<ext>                # 图片字节
```

- **原子写**：写 `notebook.json.tmp` → `fsync` → `rename`；rename 前把旧文件复制成 `.bak`。
- **并发**：host 侧单进程内用一个串行化 Promise 队列（mutex）包住所有读写，避免竞态丢更新。
- 首次使用时目录/文件不存在 → 返回 `{version:1, notes:[]}` 并惰性创建。
- **删除笔记**时同时删除其附件目录。
- 若 `$DSH_HOME` 不可写，host 必须**降级为内存态**并在 API 响应里带 `degraded: true`，
  client 顶部显示一条非阻断提示（不允许静默丢数据）。

---

## 4. 功能规格（对应 G3–G8）

### 4.1 列表页（Notebook 主页）

```
┌───────────────────────────────────────────┐
│ 📓 Notebook                        [ ＋ ] │  ← 顶栏；＋ 在右上角
├───────────────────────────────────────────┤
│ ▸ 会议纪要 2026-09-14                     │  ← 点标题 = 复制正文
│   1 分钟前 · 2 张图片      [编辑] [删除]  │
│ ▸ 购物清单                                │
│   昨天                    [编辑] [删除]  │
└───────────────────────────────────────────┘
```

- 空态：居中插画位 + 文案「还没有记事，点右上角 ＋ 新建」+ 一个大的「＋ 新建记事」按钮。
- 「＋」按钮 = G3 的入口；点击 → 打开编辑容器（新建模式）。
- 标题行点击区域是**标题文字本身**（`<button>`，非整行），复制成功后给出 2s 的
  「已复制正文」toast；`编辑` / `删除` 是行尾的独立按钮。

### 4.2 编辑容器（一个容器，两种模式）

**必须是同一个 React 组件实例**（G8）：`<NotebookEditor>` 由列表页持有唯一一份状态，
`mode: {kind:'create'} | {kind:'edit', noteId}`。**不得**为 `edit` 另起一个组件/弹层。

```
┌───────────── 编辑记事 ─────────────────────┐
│ 标题  [_______________________________]    │
│ ┌────────────────────────────────────────┐ │
│ │ 正文（可直接粘贴 / 拖入图片）           │ │
│ │                                        │ │
│ │  [图片缩略图]  [图片缩略图]             │ │
│ └────────────────────────────────────────┘ │
│  [📎 插入图片]  图片 2 张 / 上限 20 张      │
│                   [ 取消 ]   [ 完成 ]      │
└────────────────────────────────────────────┘
```

- 呈现方式：面板内的**覆盖层**（对齐 DSH 视觉），tier 3 时同样在自绘面板内部；
  不新开浏览器窗口 / 不新开第二个 sidebar tab。
- 标题：单行 `<input>`；正文：`<textarea>` + 图片区共用一个可滚动容器。
- **图片插入**：三种入口 —— ① `onPaste` 取 `clipboardData.files`；② 拖放 `onDrop`；
  ③「插入图片」按钮走 `<input type="file" accept="image/*" multiple>`。
  全部走同一个 `acceptImage(file)` 校验：`type.startsWith('video/')` 或视频扩展名 → **拒绝**
  并弹出行内错误「不支持视频文件」；非图片 → 「只支持图片文件」。
- 图片先**本地预览**（`URL.createObjectURL`），点「完成」时随笔记一起 `POST` 上传；
  上传失败则该条保留为错误项并允许重试，**不得静默丢失**。
- 上限：单图 ≤ 10 MB，单条 ≤ 20 张（超限走同一行内错误）。
- 「完成」：标题与正文皆空 → 禁用按钮。保存成功 → 关闭容器 → 列表刷新（G6）。
- 「取消」：丢弃未保存改动（有改动时二次确认）。
- 键盘：`Cmd/Ctrl+Enter` = 完成；`Esc` = 取消。

### 4.3 陈列（G6）

保存后条目以**标题**为单位在列表里一条条陈列（倒序，最新在上）。正文不在列表展开，
仅显示「时间 · N 张图片」的次要信息。

### 4.4 编辑（G7/G8）

点「编辑」按钮 → 用**同一个** `<NotebookEditor>` 容器加载该 note（标题回填、正文回填、
图片从 `attachment:<id>` 标记还原为缩略图）；再次点「完成」→ `PATCH` 更新 → 关闭 → 列表刷新。

### 4.5 复制正文（G7）

点标题 → 把**正文**（**不含标题**）写入剪贴板：

1. 纯文本形态：把 `![alt](attachment:<id>)` 还原为 `[图片: <name>]` 一行；
   其余文本原样。**这是写入剪贴板的最终文本。**
2. 优先 `navigator.clipboard.writeText(text)`；
   失败（非安全上下文 / 权限被拒）→ 回退隐藏 `<textarea>` + `document.execCommand('copy')`。
3. 成功后 toast「已复制正文（N 字）」；正文为空时也复制空串并提示「正文为空」。

---

## 5. 设置项定义（三个 tier 共用一份）

```ts
/** 插件偏好：三层 tier 共用同一份定义，由 host 持久化在 NotebookDoc.prefs。 */
export interface NotebookPrefs {
  sortOrder: 'updated' | 'created' | 'title'   // 默认 'updated'
  copyImagesAsName: boolean                    // 默认 true（复制时图片写文件名行）
  maxImagesPerNote: number                     // 默认 20
  confirmDelete: boolean                       // 默认 true
  openOnStart: boolean                         // tier 3 专用：启动即展开，默认 false
}
```

- **单一数据源**：偏好的真值存在 host 的 `NotebookDoc.prefs`（跨 tier、跨浏览器一致）。
- tier 2：通过 `registerTab({ settings: { pluginToggles, render } })` 暴露 UI，
  读写仍走 `PATCH /notebook/api/prefs`（**不用** better-sidebar 的 `pluginSettings`，
  否则三层不一致）。
- tier 3：注册到 DSH 设置壳的插件设置区，同一份字段。
- tier 1：走 DSH 原生设置（`settings.plugin.item` 槽）。

---

## 6. 宿主 HTTP API

注册在 `ctx.webServer`（`kind: 'prefix'`, `path: '/notebook/api'`），JSON over HTTP。
**所有**响应都带 `Cache-Control: no-store`。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/notebook/api/state` | — | `{ doc, degraded? }` |
| POST | `/notebook/api/notes` | `{ title, body, attachments: [{name,mime,size,dataUrl}] }` | `{ note }` |
| PATCH | `/notebook/api/notes/:id` | `{ title?, body?, attachments? }` | `{ note }` |
| DELETE | `/notebook/api/notes/:id` | — | `{ ok: true }` |
| PATCH | `/notebook/api/prefs` | `Partial<NotebookPrefs>` | `{ prefs }` |
| GET | `/notebook/api/attachments/:noteId/:file` | — | 图片字节 + `Content-Type` |
| GET | `/notebook/api/health` | — | `{ ok, version, degraded }` |

- 图片以 **dataURL** 上传（client 用 `FileReader`），host 解码落盘；避免 multipart 解析依赖。
- **安全栅栏**：仅接受来自 loopback 的请求（`req.socket.remoteAddress` ∈ 127.0.0.1/::1），
  并校验 `Origin`/`Host` 属于允许的本地来源；否则 403。路径参数做防穿越校验
  （`path.resolve` 后必须仍在附件根内）。
- 体积上限：单请求 body ≤ 32 MB；超限 413。
- 404/400/415/500 都返回结构化 `{ error: { code, message } }`。

---

## 7. 仓库结构

```
dsh-notebook/
├── package.json              # name=dsh-notebook, type=module, dsh 字段见 §8.1
├── cordis.patch.yml          # - insert: [{ id: notebook, name: 'dsh-notebook' }]
├── dsh.plugin.json           # id/version/main/client.main/contributes
├── tsconfig.json
├── tsconfig.build.json
├── tsdown.config.ts          # host: src/index.ts → lib/index.js; client: src/client/index.tsx → lib/client.js
├── vitest.config.ts
├── README.md                 # 中文主 README（安装、截图位、FAQ）
├── README_EN.md              # 英文
├── LICENSE                   # MIT
├── .gitignore
├── .github/workflows/ci.yml  # typecheck + test + build
├── docs/specs/v1-design.md   # 本文
├── src/
│   ├── index.ts              # host 半入口（apply）
│   ├── config.ts             # schemastery 设置 schema
│   ├── store.ts              # 原子写 + mutex + CRUD
│   ├── attachments.ts        # 图片落盘/读取/校验（含视频拒绝）
│   ├── routes.ts             # ctx.webServer 路由
│   ├── shared/types.ts       # host/client 共用类型
│   └── client/
│       ├── index.tsx         # client 半入口：三层探测 + 注册 + 设置
│       ├── hosts/native.ts   # tier 1
│       ├── hosts/service.ts  # tier 2
│       ├── hosts/standalone.tsx  # tier 3（自绘右栏，UI 对齐 better-sidebar）
│       ├── NotebookView.tsx  # 列表 + 「＋」+ 条目行
│       ├── NotebookEditor.tsx# 唯一编辑容器（create/edit 共用）
│       ├── image.ts          # 图片校验/预览/dataURL
│       ├── clipboard.ts      # 复制正文（含 execCommand 回退）
│       ├── api.ts            # fetch 封装
│       ├── locales.ts        # zh/en 词典
│       └── icons.tsx         # 16px 线性图标（对齐 better-sidebar 观感）
└── test/
    ├── store.test.ts         # 原子写/CRUD/并发
    ├── attachments.test.ts   # 视频拒绝/穿越防护/大小上限
    ├── routes.test.ts        # HTTP 契约（node:http 起真实端口）
    ├── tier-detect.test.ts   # 三层探测与只注册一次
    ├── editor.test.tsx       # G3–G8（jsdom + @testing-library/react）
    └── clipboard.test.ts     # 正文→剪贴板文本转换 + 回退路径
```

---

## 8. 打包与挂载

### 8.1 `package.json` 关键字段

```jsonc
{
  "name": "dsh-notebook",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "dsh.plugin.json", "README.md", "LICENSE"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-ui-conversation"
      ],
      "platform": "web"
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-client-runtime": "*",
    "@deepseek-ai/dsh-client-ui-slots": "*",
    "react": "^18.2.0",
    "dsh-better-sidebar": "*"
  },
  "peerDependenciesMeta": { "dsh-better-sidebar": { "optional": true } }
}
```

> ⚠️ **市场硬约束**（`.recon/dsh-market-pr.md` 复核）：`dependencies` / `peerDependencies` /
> `optionalDependencies` 中**不得出现 `cordis`**；`scripts` 不得含 install 类钩子。
> 以 recon 报告为准做最终调整。

### 8.2 构建

- `pnpm typecheck` → `tsc --noEmit`
- `pnpm test` → `vitest run`
- `pnpm build` → `tsc -p tsconfig.build.json && tsdown`
- **产物必须真实存在**：`lib/index.js`、`lib/client.js`、`lib/types/**`。

### 8.3 本机挂载（用于真机验收）

```sh
# 1) 独立验收环境（不动用户正在用的 GUI）
DSH_HOME=/tmp/dshnb-home npx -y --package @deepseek-ai/dsh dsh web --port 3099
# 2) 在 /tmp/dshnb-home/profiles/web 内 link 本仓库并加进 dsh.profile.bundles
# 3) 用 ego-browser / Playwright 打开 http://127.0.0.1:3099 截图验收
```

**绝不重启用户当前 3080 端口的 DSH**（会杀掉本次会话）。

---

## 9. 验收清单（编排者逐条核对，缺一不可）

- [ ] `pnpm typecheck` / `pnpm test` / `pnpm build` 全绿，且 `lib/` 产物存在。
- [ ] G3：「＋」在 sidebar 页内，点击后出现编辑容器。
- [ ] G4：粘贴/拖入 png 成功并出现缩略图；粘贴 mp4 被拒并提示。
- [ ] G5：标题 + 正文都能写入。
- [ ] G6：点「完成」后容器关闭，条目以标题形式陈列。
- [ ] G7：点标题 → 剪贴板内容 == 正文（不含标题）。
- [ ] G8：点「编辑」→ DOM 中编辑器容器仍只有 1 个，内容为该条回填。
- [ ] G1：装 better-sidebar 的环境里，展开侧边栏后能看到并打开 Notebook（tier 2 实测）。
- [ ] G2：未装任何 sidebar 的环境里，右上角出现展开按钮，面板宽度可拖拽、窄屏全宽（tier 3 实测）。
- [ ] 设置项在对应 tier 的 settings 界面中可见可改。
- [ ] 无视频支持路径；无对 DSH 源码的修改。
- [ ] README 有安装说明、功能说明、与 better-sidebar 的关系说明。
- [ ] `wyzh0117/dsh-notebook` 为 **private**，代码已推送。
- [ ] dsh-market PR 已按 `.recon/dsh-market-pr.md` 的规范提交。
