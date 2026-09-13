/**
 * The plugin's zh/en dictionaries and the tiny `t()` used by every component.
 *
 * All user-visible copy lives here — JSX never hardcodes Chinese or English.
 * `t()` falls back to the key itself so a missing entry is a cosmetic bug, not
 * a crash, and supports `{name}` interpolation.
 *
 * Language comes from the DSH locale service handed to {@link attachLocale};
 * unknown or missing means `zh` (the plugin's primary locale).
 *
 * Purity: no `node:*`, no `@deepseek-ai/*` value imports (spec §00-context).
 */

export const LOCALE_NS = 'dsh-notebook'

/** Structural view of `ctx.locale` — we only need these two members. */
export interface LocaleLike {
  register(ns: string, lang: string, dict: Record<string, string>): () => void
  get?: () => string
}

export type Lang = 'zh' | 'en'

export const zh: Record<string, string> = {
  // ── identity ────────────────────────────────────────────────────────────
  title: 'Notebook',
  description: '侧边栏记事本：标题 + 正文，可插入图片，点标题复制正文',
  settingsSection: 'Notebook 记事本',
  settingsTitle: '记事本设置',

  // ── chrome / actions ────────────────────────────────────────────────────
  newNote: '新建记事',
  empty: '还没有记事，点右上角 ＋ 新建',
  emptyCta: '＋ 新建记事',
  loading: '加载中…',
  retry: '重试',
  close: '关闭',
  expand: '展开记事本',
  collapse: '收起记事本',

  // ── editor ──────────────────────────────────────────────────────────────
  editorCreate: '新建记事',
  editorEdit: '编辑记事',
  titleLabel: '标题',
  titlePlaceholder: '标题',
  bodyLabel: '正文',
  bodyPlaceholder: '正文（可直接粘贴 / 拖入图片）',
  insertImage: '插入图片',
  image: '图片',
  imageCount: '{n} 张图片',
  imageCountOf: '图片 {n} / 上限 {max} 张',
  imageLine: '[图片: {name}]',
  removeImage: '移除图片',
  done: '完成',
  cancel: '取消',
  edit: '编辑',
  delete: '删除',
  saved: '已保存',
  untitled: '无标题',
  copyHint: '点击标题复制正文',
  emptyBody: '（无正文）',

  // ── toasts ──────────────────────────────────────────────────────────────
  copied: '已复制正文（{n} 字）',
  copyEmpty: '正文为空',
  copyFailed: '复制失败，请手动选择文本',

  // ── errors (never silent) ───────────────────────────────────────────────
  errVideo: '不支持视频文件',
  errNotImage: '只支持图片文件',
  errTooLarge: '图片超过 {max} MB 上限',
  errTooMany: '图片数量已达上限（{max} 张）',
  errSave: '保存失败：{message}',
  errLoad: '加载失败：{message}',
  errDelete: '删除失败：{message}',
  errUpload: '有 {n} 张图片上传失败，条目已保留，可重试',
  degraded: '磁盘不可写，笔记暂存在内存中（重启会丢失）',
  confirmDelete: '确定删除「{title}」？',
  discardConfirm: '放弃未保存的改动？',

  // ── relative time ───────────────────────────────────────────────────────
  timeJustNow: '刚刚',
  timeMinutesAgo: '{n} 分钟前',
  timeHoursAgo: '{n} 小时前',
  timeYesterday: '昨天',
  timeDaysAgo: '{n} 天前',

  // ── settings (single definition shared by all three tiers, spec §5) ─────
  settingsSortOrder: '排序方式',
  settingsSortOrderDesc: '列表里条目的排列顺序',
  settingsSortUpdated: '最近更新',
  settingsSortCreated: '最近创建',
  settingsSortTitle: '标题',
  settingsCopyImages: '复制时写入图片名',
  settingsCopyImagesDesc: '复制正文时，图片写成一行 [图片: 文件名]；关闭则丢弃图片标记',
  settingsMaxImages: '单条图片上限',
  settingsMaxImagesDesc: '单条记事最多可插入多少张图片（1–100）',
  settingsConfirmDelete: '删除前确认',
  settingsConfirmDeleteDesc: '删除记事时先弹窗确认',
  settingsOpenOnStart: '启动即展开侧边栏',
  settingsOpenOnStartDesc: '仅在没有其它侧边栏产品的独立模式下生效',

  // Aliases: the declarative settings rows of the service tier address the same
  // four preferences by their bare field names.
  sortOrder: '排序方式',
  copyImagesAsName: '复制时写入图片名',
  maxImagesPerNote: '单条图片上限',
  confirmDeleteLabel: '删除前确认',
  openOnStart: '启动即展开侧边栏',
}

export const en: Record<string, string> = {
  title: 'Notebook',
  description: 'Sidebar notebook: title + body, inline images, click a title to copy its body',
  settingsSection: 'Notebook',
  settingsTitle: 'Notebook settings',

  newNote: 'New note',
  empty: 'No notes yet — use ＋ in the top right to create one',
  emptyCta: '＋ New note',
  loading: 'Loading…',
  retry: 'Retry',
  close: 'Close',
  expand: 'Show notebook',
  collapse: 'Hide notebook',

  editorCreate: 'New note',
  editorEdit: 'Edit note',
  titleLabel: 'Title',
  titlePlaceholder: 'Title',
  bodyLabel: 'Body',
  bodyPlaceholder: 'Body (paste or drop images here)',
  insertImage: 'Insert image',
  image: 'Image',
  imageCount: '{n} images',
  imageCountOf: 'Images {n} / max {max}',
  imageLine: '[Image: {name}]',
  removeImage: 'Remove image',
  done: 'Done',
  cancel: 'Cancel',
  edit: 'Edit',
  delete: 'Delete',
  saved: 'Saved',
  untitled: 'Untitled',
  copyHint: 'Click the title to copy the body',
  emptyBody: '(empty body)',

  copied: 'Body copied ({n} characters)',
  copyEmpty: 'The body is empty',
  copyFailed: 'Copy failed — please select the text manually',

  errVideo: 'Video files are not supported',
  errNotImage: 'Only image files are supported',
  errTooLarge: 'Image is larger than {max} MB',
  errTooMany: 'Image limit reached ({max})',
  errSave: 'Save failed: {message}',
  errLoad: 'Load failed: {message}',
  errDelete: 'Delete failed: {message}',
  errUpload: '{n} image(s) failed to upload — the note was kept, you can retry',
  degraded: 'The disk is not writable, notes live in memory only (lost on restart)',
  confirmDelete: 'Delete “{title}”?',
  discardConfirm: 'Discard unsaved changes?',

  timeJustNow: 'just now',
  timeMinutesAgo: '{n} min ago',
  timeHoursAgo: '{n} h ago',
  timeYesterday: 'yesterday',
  timeDaysAgo: '{n} days ago',

  settingsSortOrder: 'Sort order',
  settingsSortOrderDesc: 'How notes are ordered in the list',
  settingsSortUpdated: 'Recently updated',
  settingsSortCreated: 'Recently created',
  settingsSortTitle: 'Title',
  settingsCopyImages: 'Write image names when copying',
  settingsCopyImagesDesc: 'Copy each image as a “[Image: file name]” line; off drops image markers',
  settingsMaxImages: 'Images per note',
  settingsMaxImagesDesc: 'Maximum number of images in one note (1–100)',
  settingsConfirmDelete: 'Confirm before deleting',
  settingsConfirmDeleteDesc: 'Ask for confirmation when a note is deleted',
  settingsOpenOnStart: 'Expand the sidebar on start',
  settingsOpenOnStartDesc: 'Only used by the standalone tier (no other sidebar product installed)',

  sortOrder: 'Sort order',
  copyImagesAsName: 'Write image names when copying',
  maxImagesPerNote: 'Images per note',
  confirmDeleteLabel: 'Confirm before deleting',
  openOnStart: 'Expand the sidebar on start',
}

/** The last locale service handed to {@link attachLocale} (null = default zh). */
let attached: LocaleLike | null = null
let detach: Array<() => void> = []

/**
 * Bind the dictionaries to the host locale service. Called once per activation
 * from `src/client/index.tsx`; re-binding disposes the previous registrations so
 * HMR / double activation cannot stack dictionaries.
 */
export function attachLocale(locale: LocaleLike): void {
  for (const dispose of detach) {
    try {
      dispose()
    } catch {
      /* a stale disposer must never break activation */
    }
  }
  detach = []
  attached = locale ?? null
  if (!locale || typeof locale.register !== 'function') return
  for (const [lang, dict] of [
    ['zh', zh],
    ['en', en],
  ] as Array<[Lang, Record<string, string>]>) {
    try {
      const dispose = locale.register(LOCALE_NS, lang, dict)
      if (typeof dispose === 'function') detach.push(dispose)
    } catch {
      /* an uncooperative locale service must not break the plugin */
    }
  }
}

/** The language `t()` currently resolves against. */
export function currentLang(): Lang {
  let raw: string | undefined
  try {
    raw = attached?.get?.()
  } catch {
    raw = undefined
  }
  if (typeof raw !== 'string' || raw.length === 0) return 'zh'
  const normalized = raw.toLowerCase()
  if (normalized.startsWith('en')) return 'en'
  return 'zh'
}

/**
 * Translate `key`, interpolating `{name}` placeholders. A missing key resolves
 * to the key itself (and the zh dictionary is the last resort before that).
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const lang = currentLang()
  const dict = lang === 'en' ? en : zh
  let text = dict[key] ?? zh[key] ?? key
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value))
    }
  }
  return text
}
