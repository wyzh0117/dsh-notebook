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
| 本机 DSH（实现时） | `0.1.1-rc.2` | `node ~/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js --version`（**事后注记**：随后升级到 `0.1.5-rc.2`，见下方两条） |
| npm 上 DSH | `latest=0.1.5-rc.1`、`next=0.1.5-rc.2` | registry.npmjs.org dist-tags |
| 本机 better-sidebar | `0.12.1`（自绘右侧栏） | `~/.dsh/profiles/web/package.json` |
| better-sidebar 最新 | `0.19.x`，**要求 DSH ≥ 0.1.5-rc.1**，不再自绘右栏 | 上游 README IMPORTANT 段 |
| 本机是否存在 `ctx.sidebarRightTabs`（实现时） | **不存在**（0.1.1-rc.2 无右侧栏包） | 全量 grep `@deepseek-ai/*` 无命中（**事后注记**：升级到 `0.1.5-rc.2` 后 `@deepseek-ai/dsh-client-ui-sidebar-right` 随内核安装，该服务存在，tier 1 是本机生效层） |
| `ctx.sidebarRightTabs` 属主 | `@deepseek-ai/dsh-client-ui-sidebar-right@0.1.5-rc.2` | 已下载 tarball 于 `/tmp/dsh-new/sr` |
| 本机可用 slots | `root` / `sidebar` / `conversation` / `details` / `shell.overlay` / `settings.plugin.item` / `tool.view.cordis` / `conversation.input.overlay` | 各包 `SlotMap` augmentation |
| DSH_HOME 可重定向 | 环境变量 `DSH_HOME` | `@deepseek-ai/dsh-home-paths` |
| DSH 存储约定 | `$DSH_HOME/storages/*.json` | 本机 `~/.dsh/storages/` |
| gh 登录账号 | `wyzh0117`（id 101866233） | `gh auth status`（用户已确认用它，`wyzh843` 不存在） |
| 用户已定决策 | 笔记**全局共享**；图片**存宿主磁盘+引用路径** | 会话内澄清 |

> **事后注记（v1.1 期间复核，2026-09）：** 开发机已升级到 DSH **`0.1.5-rc.2`**，并且
> `@deepseek-ai/dsh-client-ui-sidebar-right`（连同 `dsh-client-ui-conversation`、`dsh-client-ui-input-trigger`）**都已安装**：
> `ctx.sidebarRightTabs` 存在，**tier 1 已成为本机实际生效层**，v1.1 用到的三个 seam 也都在场。
> 上表是 v1 设计时的 recon 记录，保留作历史依据；现状与验证口径见 §10.6。

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
> `ctx.slots.register` 确切签名；`sidebar.right.pane.tab` 属于 0.1.5+。
>
> **事后注记（v1.1）**：开发机现已运行 `0.1.5-rc.2` 并装有 `dsh-client-ui-sidebar-right`，**tier 1 是本机实际生效层**；
> 实现按 0.1.5-rc.2 的**真实类型声明**核对（见 `src/client/hosts/native.ts` 文件头），注册序列由
> `test/tier-detect.test.ts` 用假 ctx 覆盖。**没有人工点过 GUI**：tier 1 以及 v1.1 的三个功能都没有 GUI 点击验证，
> 真机只验证了「产物被服务」与「host 路由应答」，口径见 §10.6。

**打开方式**：`ctx.sidebarRight.openTab('dsh-notebook', { params })`，需要时
`ctx.sidebarRight.toggleExpanded()` 展开。

**可见性（v1.1 澄清）**：tab 体从槽注入的 `useTabInfo()` 钩子读 `tab.visible` —— 0.1.5-rc.2 的 seat 以**空 owner share**
（`renderSlot(seat, {}, …)`）渲染 tab，`props.tab.visible` 根本不会作为普通 prop 到达；两种情况各写一个组件分支以保持 hook 顺序稳定。
`visible === false` 时 `NotebookView` **不加载也不轮询**（隐藏的 tab 一次 host 请求都不发），覆盖在 `test/native-tab-body.test.tsx`。

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
  > **v1.1 变更（见 §10.3 / §10.4）**：行内新增「对话引用」按钮。点标题**仍是本节描述的纯复制**——
  > v1.1 一度把「含图片的记事」接到输入框，2026-09-15 的产品决定移除了那个入口：附件桥保留在 `composer.ts` 且仍有单测，
  > 但没有任何 UI 调用它，所以标题动作永远只写剪贴板。

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

> **v1.1 变更（见 §10.3）**：本节就是点标题的**唯一行为**——v1.1 一度在「记事含输入框能收的图片」时改走附件路径，
> 但 2026-09-15 的产品决定把入口移除，`NotebookView` 的标题动作回到 `handleCopyBody`（纯复制）。
> 附件桥的代码与单测保留，等一个属于它自己的显式动作接线；当前没有任何 UI 能触发它。

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
  autoOpenOnNewSession: boolean                // v1.1：新会话成为 current 时打开记事本，默认 false（三层 tier 都接，见 §10）
}
```

- **单一数据源**：偏好的真值存在 host 的 `NotebookDoc.prefs`（跨 tier、跨浏览器一致）。
- tier 2：通过 `registerTab({ settings: { pluginToggles, render } })` 暴露 UI，
  读写仍走 `PATCH /notebook/api/prefs`（**不用** better-sidebar 的 `pluginSettings`，
  否则三层不一致）。v1.1 起声明行是 5 项——**除 `openOnStart` 外的全部偏好**（`openOnStart` 只在独立层有意义）；
  `render` 渲染的仍是同一份 `<NotebookSettingsPanel>`（6 项偏好都在）。
- tier 1 / tier 3：v1.1 起注册**同一份**全局设置区（`settings.section` 槽，共用 `hosts/settingsSeat.ts`，
  id 固定 `dsh-notebook`），字段与文案完全一致；槽未声明时注册是安全的 no-op。

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
│       ├── hosts/settingsSeat.ts # v1.1：tier 1 / tier 3 共用的全局设置区（settings.section）
│       ├── hosts/autoOpen.ts # v1.1：新会话打开的监听（attachSessionAutoOpen，三层 tier 各接自己的手势）
│       ├── NotebookView.tsx  # 列表 + 「＋」+ 条目行（对话引用 / 编辑 / 删除）
│       ├── NotebookEditor.tsx# 唯一编辑容器（create/edit 共用）
│       ├── NotebookSettingsPanel.tsx # 三个 tier 共用的设置面板
│       ├── composer.ts       # v1.1：DSH 输入框桥（引用 chip 已接线；附件 / 正文路径已实现、未接线）
│       ├── reference.ts      # v1.1：`@` 引用源 + 记事目录缓存
│       ├── image.ts          # 图片校验/预览/dataURL
│       ├── clipboard.ts      # 复制正文（含 execCommand 回退）+ 正文/引用文本转换
│       ├── api.ts            # fetch 封装
│       ├── locales.ts        # zh/en 词典
│       └── icons.tsx         # 16px 线性图标（对齐 better-sidebar 观感）
└── test/
    ├── store.test.ts         # 原子写/CRUD/并发
    ├── attachments.test.ts   # 视频拒绝/穿越防护/大小上限
    ├── routes.test.ts        # HTTP 契约（node:http 起真实端口）
    ├── tier-detect.test.ts   # 三层探测与只注册一次（含 v1.1 设置区与自动打开）
    ├── composer.test.ts      # v1.1：输入框桥（目标解析/附件/三条写入路径/detect span 换算）
    ├── reference.test.ts     # v1.1：`@` 源（候选/chip/序列化只送正文/注册重试）
    ├── auto-open.test.ts     # v1.1：新会话打开的监听与重试
    ├── native-tab-body.test.tsx # v1.1：原生 tab 体经注入的 useTabInfo() 读可见性
    ├── view-actions.test.tsx # v1.1：条目行的标题动作与「对话引用」按钮
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

> **事后注记（DSH `0.1.5-rc.2` 起）：** `@deepseek-ai/dsh-client-runtime` 在 `0.1.1-rc.2` 之后已停止发布，
> `0.1.5-rc.2` 中不存在该包（`@deepseek-ai/dsh-client-web-react`、`@deepseek-ai/dsh-client-schema-form` 同样已消失）。
> 上面的 `dsh.client.inject` 与 `peerDependencies` 现已不再包含前者。本节作为 v1 设计的历史记录保留。

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
- [ ] G7：点标题 → 剪贴板内容 == 正文（不含标题）。（**始终成立**：v1.1 的附件桥没有 UI 入口，见 §10.3 / §10.6）
- [ ] G8：点「编辑」→ DOM 中编辑器容器仍只有 1 个，内容为该条回填。
- [ ] G1：装 better-sidebar 的环境里，展开侧边栏后能看到并打开 Notebook（tier 2 实测）。
- [ ] G2：未装任何 sidebar 的环境里，右上角出现展开按钮，面板宽度可拖拽、窄屏全宽（tier 3 实测）。
- [ ] 设置项在对应 tier 的 settings 界面中可见可改。
- [ ] 无视频支持路径；无对 DSH 源码的修改。
- [ ] README 有安装说明、功能说明、与 better-sidebar 的关系说明。
- [ ] `wyzh0117/dsh-notebook` 为 **private**，代码已推送。
- [ ] dsh-market PR 已按 `.recon/dsh-market-pr.md` 的规范提交。

---

## 10. v1.1 · 对话联动

v1.1 在 v1 之上加三处接缝——两处用户可见（C2 / C3），一处已实现但保留未接线（C1）；**不改动 v1 的任何既有契约**（数据模型、HTTP API、三层注册、G1–G10 全部保留）：

| # | 能力 | 一句话 |
|---|---|---|
| C1 | 输入框附件桥（**已实现、未接线**） | 桥能把落盘图片注册成输入框草稿附件、把正文（图片标记已移除）追加进草稿；但产品决定（2026-09-15）移除了它唯一的入口，**点标题只复制**。§10.3 记录保留的能力与决定 |
| C2 | `@` 引用记事 + 「对话引用」按钮 | 输入框里 `@` 能列出记事；插入的原子 chip 在发送时只序列化**正文**（标题绝不发给模型） |
| C3 | 新会话自动打开侧边栏 | 新偏好 `autoOpenOnNewSession`（默认 `false`）；开启后每进入一个新会话就打开 Notebook 页——三层 tier 各用自己的打开手势 |

用户可见的只有 C2 与 C3；C1 的代码与测试**刻意保留**（见 §10.3），等一个属于它自己的显式动作来接线。

### 10.1 硬约束（决定了所有实现选择）

1. **客户端 bundle 不能 import DSH 的 UI 包。** `lib/client.js` 是 CJS 闭包工厂，`require` 只解析模块表
   （`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/dsh-client-ui-slots`、
   `@deepseek-ai/dsh-client-ui-primitives`），`package.json` 的 `dsh.client.inject` 也只有 `locale` 与 `slots`。
   因此 `ctx.conversation` / `ctx.sessions` / `ctx.inputTriggers` **一律鸭子类型 + 逐成员可选 + 每次调用都 try/catch**：
   宿主版本不同或服务缺席时，能力静默关闭并退回 v1 行为，绝不抛错、绝不阻塞激活。
2. **不修改 DSH 源码**（v1 既有硬约束），只走公开 seam。
3. **SVG 不能作为输入框附件。** 附件桥只收 `image/png` / `image/jpeg` / `image/webp` / `image/gif`
   （`COMPOSER_IMAGE_MIMES`）；记事本身允许的 `image/svg+xml` 在桥上只能计入 `skipped`。
   （这是桥的性质，不是「点标题时会跳过」——标题动作已经不接这条桥，见 §10.3。）
4. **模型永远拿不到标题。** chip 的标签是标题（给人看），序列化只输出正文；这是明确的产品要求，不是遗漏。

### 10.2 使用的公开 seam

| seam | 形态 | 用途 | 缺席时 |
|---|---|---|---|
| `ctx.sessions` | `list.getSnapshot().current`、`list.subscribe(fn)`、`scope(id)` | 定位「当前会话」及其 Agent 作用域 ctx；订阅会话切换 | 没有输入框目标；自动打开静默 |
| `ctx.conversation` | `createDrafts(sessionId, files)`、`releaseDraftAttachments(drafts)`、`input.for(actx)` | 生成 / 归还浏览器侧草稿附件（**只有未接线的附件桥用它**）；解析 per-session input facade（`@` 引用用它拿 `insertReference`） | 附件桥整体不可用（无 UI 入口）；`@` 引用退化为插入正文文本 |
| input facade | `state.getSnapshot()`、`addAttachments(ids)`、`insertText(text, span)`、`insertReference(ref, span)`、`setDraft(text)` | 读草稿状态、放附件、写文本 / chip（`insertReference` 是 `@` 引用在用的那一个） | 同上 |
| 会话作用域事件 | `actx.bail(actx, 'slash/input-insert-text' \| 'slash/input-insert-reference', payload)` | 在 caret span 上拼接（chip 保真），与触发管线选中菜单行时的调用完全一致 | 退到 facade 方法 |
| `ctx.inputTriggers` | `registerSource(source)` | 注册 `@` 源 | 菜单里没有记事本分组 |

`InputState.draft` 是**剪贴板投影**（chip 展开成整段 clipboardText），而编辑器 detect 投影里一个 chip 只占 1 个字符
（U+FFFC）。`endOfDraftSpan()` 用 `draftRev` + 两种投影的长度差算出文末 caret span，
**保证追加不会落进已有 chip 内部**；`phase` 不是 `plain` / `claimed`（例如正在提交）时一律拒绝写入。

### 10.3 C1 — 输入框附件桥（**已实现，未接线**）

> **产品决定（2026-09-15）：** 点标题**只复制**，绝不自己往输入框里写东西。
> v1.1 曾把「含图片的记事」接到输入框（图片作附件、正文进草稿、够不到输入框再退回复制），
> 该入口随后被这条决定移除：`NotebookView` 的标题动作现在是 `handleCopyBody`
> （`buildClipboardText` + `copyText`，toast `copied` / `copyEmpty` / `copyFailed`），不再引用 composer 桥。
> **桥与单测刻意保留**（接缝才是贵的那部分，且已有覆盖），等一个属于它自己的显式动作来接线。

当前 UI 行为（也是测试断言的行为）：**点标题 = 纯复制**，含图片的记事也一样；没有 composer 桥时同样复制。

保留的桥能力（对未来的调用方而言；`composer.ts` 的 `NotebookComposer` 文档注释记着同一条 WIRING NOTE）：

| 成员 | 契约 |
|---|---|
| `attachImages(note, { max })` | 解析目标（`ctx.sessions` 有 current 会话 + `ctx.conversation` 在 + 该会话 input facade 可用）→ 逐个附件读字节：`GET /notebook/api/attachments/<noteId>/<file>`（`cache: 'no-store'`、`credentials: 'same-origin'`）包成 `File`（名字用存储名，缺失时按 MIME 合成 `image.<ext>`；张数上限取 `prefs.maxImagesPerNote`）→ `createDrafts(sessionId, files)` → `input.addAttachments(ids)`。图片只活在草稿里，发送时才上传 |
| 附件格式 | 只收 `image/png` / `image/jpeg` / `image/webp` / `image/gif`（`COMPOSER_IMAGE_MIMES`）：记事里允许的 `image/svg+xml` 计入 `skipped`，读取失败计入 `failed`；一张都插不进去时返回 `no-target` / `no-images` / `fetch-failed`，**不谎报成功** |
| 拒收 | `addAttachments` 返回 false 或抛 → `releaseDraftAttachments(drafts)` 归还草稿（不留 object URL / 上传残留），返回 `reason: 'refused'`；调用方若要回退，需自己执行复制 |
| `appendText(text)` | 把 `buildBodyText(note)`（图片标记整段移除，避免与附件栏重复）写进草稿：优先会话作用域 `slash/input-insert-text`，其次 `input.insertText`，最后 `input.setDraft` 整篇重写（唯一会降级已有 chip 的路径）；`phase` 不是 `plain` / `claimed` 时拒绝写入 |
| `reference(note, fallbackText?)` | **唯一被 UI 调用的成员**（见 §10.4） |

随入口一并下线的东西：`attached` / `attachedPartial` / `attachSkipped` / `attachReadFailed` / `attachedBodySkipped` 这些提示文案
已从 `locales.ts` 全部删除（含最后一个遗留键 `attachFailed`，最终产物里不再出现任何附件提示文案）；标题按钮 tooltip `copyHint` 回到「点击标题复制正文」。
`endOfDraftSpan()` 的 detect-span 换算仍然被 `appendText` / `reference` 用到，因此它的单测（含空 clipboardText 的 chip）继续保留。

### 10.4 C2 — `@` 引用与「对话引用」

**`@` 源**（`reference.ts`，`registerNoteReferenceSource`）：

| 项 | 值 |
|---|---|
| 名称 | `dsh-notebook`（`NOTE_REFERENCE_SOURCE`，同时是 chip 序列化的路由键） |
| `trigger` | `'@'` |
| `order` | `20`（内置源在 0） |
| 候选 | 标题 + 正文摘要（标记去掉、空白压行、60 字截断），`section` = 本地化 `refSection`（记事本 / Notebook） |
| 过滤 | 输入内容 trim + 小写后匹配标题或正文（大小写不敏感） |
| 排序 / 上限 | `updatedAt` 倒序；最多 8 条（`NOTE_CANDIDATE_LIMIT`） |
| 缓存 | 目录读一次服务 1500ms（`NOTE_CACHE_TTL_MS`），并发命中共享同一个 in-flight 读；`peek` 供同步取标签 |
| 异常 | 查询 abort 或读取失败 → 该源返回空列表（不打断文件 / 会话菜单） |
| 装配 | `ctx.inject(['inputTriggers'], …)` + `inputCtx.effect(() => service.registerSource(source))`。**注册被拒时重试**：source 名同时是序列化路由键，不能改成唯一名，所以 HMR 期上一个激活还没卸载导致的重复注册按 `REFERENCE_RETRY_MS = 500ms` 重试，超过 `REFERENCE_RETRY_LIMIT = 5` 次才告警放弃（一个消失的「记事本」分组对用户是不可见的故障）；dispose 时注销并丢弃目录缓存 |

**chip 与序列化**：

1. `onPick` → `{ insert: { source: 'dsh-notebook', ref: <noteId>, label: <标题｜无标题>, appearance: 'file', clipboardText } }`，
   插入后是原子 inline chip（与 `@session` 同级）。
2. `clipboardText` / 持久化形式是规范 mention `@[<标题>](dsh-notebook:<noteId>)`（标题里的 `[` `]` 剔除）。
3. 发送时管线按 source 名调 `codec.serialize(ref)`：`catalog.read(ref)` → `buildReferenceText(note)`，
   即**正文**（每个图片标记写成一行 `[图片: <name>]`），**不含标题**。
4. 失败策略：`read` 返回 `null`（记事已删除）→ 序列化为空串；`read` 抛（真实读取失败）→ 异常冒泡，
   发送被拦下并显示错误，**不**降级成 `@标题`。

**行内「对话引用」按钮**（`NotebookView.handleReference`）：

- 只有 composer 桥存在时才渲染；点击 → `composer.reference(note, buildBodyText(note))`：
  先走 `slash/input-insert-reference` 插 chip（其次 facade 的 `insertReference`），都不行时追加正文文本。
- 够不到输入框（`composer.available() === false`）→ toast `refUnavailable`（zh「当前没有可用的输入框」），不假装成功。
- 成功 toast `referenced`({title})，失败 `refFailed`。
- 行内动作区改为 `flexWrap`，标题 `flex: 1 1 140px`、按钮 `flex: 0 0 auto` + `nowrap`，
  窄面板下三个按钮与标题都不被压扁。

### 10.5 C3 — 新会话自动打开（默认关闭）

- 偏好 `autoOpenOnNewSession`（`NotebookPrefs`，默认 `false`，host 持久化；host 与 client 两侧都做类型收窄，
  `PATCH /notebook/api/prefs` 逐 key 校验——`test/routes.test.ts` 的 allowlist 守卫断言接受的 key 集合 == `Object.keys(DEFAULT_PREFS)`）。
- **三层 tier 都接**，但各接自己的打开手势：监听本身是与宿主无关的 `attachSessionAutoOpen(ctx, runtime, open, options)`，
  偏好闸门只在它里面出现一次；原生 tier 的 `attachAutoOpen` 是它在右侧栏上的薄封装。
  某个载体打不开（例如 sidebar 产品没有 `openTab`）时该层的 `open()` 恒返回 false，监听静默失效，不假装成功。
- 每层的手势：

  | tier | `open()` 做什么 |
  |---|---|
  | native | `sidebarRight.openTab('dsh-notebook')`，并在 `isExpanded() === false` 时补一次 `toggleExpanded()`（打开一个用户看不见的 tab 不算打开） |
  | service | `service.openTab({ type: 'dsh-notebook:notebook', title: t('title') })` |
  | standalone | 自绘面板的 `control.setOpen(true)`（等价于点展开按钮） |

- `createAutoOpenWatcher` 规则：

  1. 激活时先把「已经是 current」的会话记为 seen —— **页面加载不弹面板**；
  2. 订阅 `ctx.sessions.list.subscribe`，只有 current **变成另一个**才动作（同一会话的快照重复发布不算）；
  3. `next === null`（hero 页）不动作；
  4. 只有 `runtime.getPrefs().autoOpenOnNewSession === true` 才开；
  5. `openTab` 在会话 surface 还没挂载时会抛 —— 按 `AUTO_OPEN_RETRY_MS = [0, 200, 500, 1200, 2500]` 重试，
     会话再次变化或 dispose 立即放弃；
  6. `open()` 返回 `false` 同样触发下一次重试（这就是 surface 未挂载的信号）。

- `ctx.sessions` 缺席时静默；服务迟到时用 `ctx.inject(['sessions'], …)` 补上，并把「补上那一刻的 current」同样记为 seen。
- 设置入口：`hosts/settingsSeat.ts` 的 `registerSettingsSection(ctx, runtime)` 注册全局 `settings.section` 槽
  （id `dsh-notebook`，order 100），tier 1 与 tier 3 共用（§5）；tier 2 的 `pluginToggles` 声明 5 项
  （除 `openOnStart` 外的全部偏好，`autoOpenOnNewSession` 在列），其 `render` 仍是同一份设置面板。
  文案 key：`settingsAutoOpen`（zh「新会话自动打开记事本」/ en “Open the notebook for new sessions”）与 `settingsAutoOpenDesc`。

### 10.6 交付物与验证

| 类别 | 文件 |
|---|---|
| 新增实现 | `src/client/composer.ts`、`src/client/reference.ts`、`src/client/hosts/autoOpen.ts`、`src/client/hosts/settingsSeat.ts` |
| 改动实现 | `NotebookView.tsx`、`hosts/native.ts`、`hosts/service.ts`、`hosts/standalone.tsx`、`index.tsx`、`clipboard.ts`（`buildBodyText` / `buildReferenceText`）、`locales.ts`、`NotebookSettingsPanel.tsx`、`icons.tsx`（`QuoteIcon`）、`src/shared/types.ts`、`src/store.ts` 与 `src/client/api.ts`、`src/routes.ts`（prefs 逐 key 校验） |
| 测试 | `test/composer.test.ts`（31，桥级别，含未接线路径）、`test/reference.test.ts`（17）、`test/view-actions.test.tsx`（7，断言点标题只复制、不碰输入框）、`test/auto-open.test.ts`（11）、`test/native-tab-body.test.tsx`（3，新增），以及更新的 `test/tier-detect.test.ts`（14）与 `test/routes.test.ts`（24，含 prefs allowlist 守卫） |

`pnpm test` 全绿：**164 passed (12 files)**。其中 `test/routes.test.ts` 的「accepts EVERY preference key the plugin exposes」
断言 `PATCH /notebook/api/prefs` 接受的 key 集合 == `Object.keys(DEFAULT_PREFS)`——正是这条守卫抓出了 `/prefs`
真实存在过的 bug（静默丢掉 `autoOpenOnNewSession`）。

诚实声明：以上 seam 是**读 DSH `0.1.5-rc.2` 已发布的 client 包**（类型声明与实现）对齐出来的；开发机运行的也是 `0.1.5-rc.2`，
且 `dsh-client-ui-conversation` / `dsh-client-ui-input-trigger` / `dsh-client-ui-sidebar-right` 均在场（tier 1 是实际生效层）。
**C2 / C3 没有人工在真实 GUI 里点过**，C1 更是没有任何 UI 入口，全部行为只由单元 / 组件测试保证；
已在运行中的实例上核对的只有两点：这份构建产物确实被服务
（rev = `sha1("plugin-artifact" ‖ \0 ‖ len:lib/client.js ‖ len:lib/client.js.map)` 前 12 位，**每次重新构建都会变**，需按当前 `lib/` 现算；写这份文档时构建得到 `f2b51cf68d61`。`GET /plugins/??dsh-notebook/client.js&rev=…` 返回 200，
字节里带 `slash/input-insert-reference` / `slash/input-insert-text` / `autoOpenOnNewSession` / `noteReferenceInsert` / `useTabInfo`，以及保留未接线的桥所用符号；已下线的 `attachSkipped` / `attachReadFailed` **不再出现**），
以及 host 侧 `GET /notebook/api/state` 返回 200（真实文档）与 `GET /notebook/api/attachments/<noteId>/<file>` 返回 200 `image/png`（663081 字节）——即附件桥每张图要走的取字节路径（桥未接线，当前无 UI 调用）。

### 10.7 已知限制（v1.1 有意留下）

1. **未发送的 `@` 引用在刷新后退化成字面 mention。** DSH 把未发送草稿按**剪贴板投影**持久化在 `localStorage`
   （`dsh.conversation`，按会话）。刷新后 chip 只剩 `@[标题](dsh-notebook:<noteId>)` 字面文本，而本插件**没有 host 半侧的
   mention 解析器**——`dsh-session:` 那类 mention 由 `@deepseek-ai/dsh-session-reference` 在 `agent/pre-step` 展开，
   我们没有接这条 seam——所以模型会收到字面 mention 而不是记事正文。
   规避：发送前别刷新，或刷新后重新插入引用。**已确定的修法**是在 host 半侧接同一条 `agent/pre-step` seam 做展开；
   v1.1 有意不做。
2. **没有打开手势的载体上监听失效**：三层 tier 都接同一个监听，但 sidebar 产品若不提供 `openTab`（或宿主没有
   `ctx.sessions`），该层静默不打开——不会假装成功。
3. **能力随宿主而变**：宿主缺 `ctx.conversation` / `ctx.inputTriggers` / `ctx.sessions` 时，对应能力关闭并退回 v1 行为。
