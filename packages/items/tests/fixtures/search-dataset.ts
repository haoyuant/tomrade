/**
 * A synthetic backlog with labelled queries, for measuring title/body search.
 * Every item is either one of a topic's four surface forms (all relevant to
 * that topic's queries: the words adjacent in the title, reordered, split
 * across title and body, or paraphrased without them) or a decoy built from a
 * vocabulary that includes every topic word, so single words collide the way
 * they do in a real project. Deterministic per seed; sized by `n`.
 */

export type Lang = "en" | "zh";
export type Variant = "phrase" | "reordered" | "split" | "paraphrase";
export type Category =
  | "en-phrase"
  | "en-reordered"
  | "en-single"
  | "zh-phrase"
  | "zh-words"
  | "zh-single-2"
  | "zh-single-3"
  | "key"
  | "short"
  | "mixed"
  | "typo"
  | "synonym";

export interface BenchItem {
  key: number;
  title: string;
  body: string;
  lang: Lang;
  topic: string | null;
  variant: Variant | null;
}

export interface BenchQuery {
  id: string;
  text: string;
  category: Category;
  /** Keys of the items a person would call an answer. */
  relevant: number[];
}

interface Topic {
  id: string;
  lang: Lang;
  words: [string, string];
  phrase: string;
  reordered: string;
  split: [string, string];
  paraphrase: string;
  /** A word from the paraphrase that a person might search instead. */
  synonym?: string;
  typo?: string;
  /** For zh topics: an English term the split body also carries, for mixed-script queries. */
  mixed?: string;
}

const EN_TOPICS: Topic[] = [
  { id: "login-timeout", lang: "en", words: ["login", "timeout"], phrase: "Login timeout on slow networks", reordered: "Timeout kicks in halfway through login", split: ["Login fails silently on retry", "The token request hits a timeout after 30 seconds and nothing is shown."], paraphrase: "Sign-in never completes on flaky wifi", synonym: "sign-in", typo: "logn timeout", mixed: undefined },
  { id: "dark-mode", lang: "en", words: ["dark", "mode"], phrase: "Dark mode toggle resets on reload", reordered: "Mode switch flickers when going dark", split: ["Dark theme leaves the header white", "Only happens in mode 'system' when the OS is dark at night."], paraphrase: "Night theme has unreadable contrast", synonym: "night theme", typo: "drak mode" },
  { id: "csv-export", lang: "en", words: ["csv", "export"], phrase: "CSV export drops the header row", reordered: "Export to csv escapes commas twice", split: ["CSV download is empty for filtered views", "The export job finishes but the file has no rows."], paraphrase: "Spreadsheet download loses the first line", synonym: "spreadsheet", typo: "csv exprot" },
  { id: "webhook-retry", lang: "en", words: ["webhook", "retry"], phrase: "Webhook retry storms after a 5xx", reordered: "Retry schedule for a failing webhook is too aggressive", split: ["Webhook deliveries pile up on outage", "There is no backoff on retry so the queue never drains."], paraphrase: "Callback redelivery hammers the endpoint", synonym: "redelivery", typo: "webhok retry" },
  { id: "avatar-upload", lang: "en", words: ["avatar", "upload"], phrase: "Avatar upload fails above 2MB", reordered: "Upload progress bar hides the new avatar", split: ["Avatar stays stale after change", "The upload succeeds but the cached image is served for an hour."], paraphrase: "Profile picture change never shows up", synonym: "profile picture" },
  { id: "password-reset", lang: "en", words: ["password", "reset"], phrase: "Password reset email never arrives", reordered: "Reset link expires before the password form loads", split: ["Password rules differ between pages", "Reset flow asks for the old one which the user does not have."], paraphrase: "Forgotten credential recovery is broken", synonym: "credential" },
  { id: "notification-badge", lang: "en", words: ["notification", "badge"], phrase: "Notification badge count is stale", reordered: "Badge still shows after every notification is read", split: ["Notification centre loads slowly", "The red badge on the bell shows 3 with nothing inside."], paraphrase: "Unread dot on the bell never clears", synonym: "unread dot" },
  { id: "keyboard-shortcut", lang: "en", words: ["keyboard", "shortcut"], phrase: "Keyboard shortcut for search collides with the browser", reordered: "Shortcut map should be configurable from the keyboard settings", split: ["Keyboard navigation skips the sidebar", "Cmd+K shortcut is swallowed by Safari."], paraphrase: "Hotkeys are hijacked by Chrome" },
  { id: "offline-sync", lang: "en", words: ["offline", "sync"], phrase: "Offline sync drops the last edit", reordered: "Sync runs twice after coming back from offline", split: ["Offline banner is barely visible", "The sync queue stalls once the network returns."], paraphrase: "Changes made without network vanish later" },
  { id: "rate-limit", lang: "en", words: ["rate", "limit"], phrase: "Rate limit headers are missing", reordered: "Limit is hit at a lower rate than documented", split: ["Rate of 429s spikes at midnight", "The per-user limit resets on a different clock than the docs say."], paraphrase: "Throttling kicks in far too early" },
  { id: "invoice-pdf", lang: "en", words: ["invoice", "pdf"], phrase: "Invoice PDF renders the wrong currency", reordered: "PDF for a voided invoice still downloads", split: ["Invoice totals differ from the dashboard", "The generated pdf uses the billing address from the previous month."], paraphrase: "Billing document shows euros for a dollar account" },
  { id: "search-index", lang: "en", words: ["search", "index"], phrase: "Search index misses items created today", reordered: "Index rebuild after import makes search slow", split: ["Search returns archived items", "The index is not updated when a title changes through the API."], paraphrase: "Finding recent tickets by title fails" },
  { id: "drag-drop", lang: "en", words: ["drag", "drop"], phrase: "Drag drop reorders the wrong column", reordered: "Drop target highlight lingers after a cancelled drag", split: ["Drag handle missing on touch", "Cards jump back when you drop them on an empty column."], paraphrase: "Moving cards with the mouse scrambles the board" },
  { id: "calendar-invite", lang: "en", words: ["calendar", "invite"], phrase: "Calendar invite lands in the wrong timezone", reordered: "Invite email lacks the calendar attachment", split: ["Calendar week starts on Sunday for EU users", "The invite ICS has no organiser field."], paraphrase: "Meeting request shows up eight hours off" },
  { id: "markdown-preview", lang: "en", words: ["markdown", "preview"], phrase: "Markdown preview mangles nested lists", reordered: "Preview pane ignores markdown tables", split: ["Markdown code fences lose their language", "The preview is rendered with a different parser than the saved body."], paraphrase: "Rich text rendering breaks bullet points" },
  { id: "sidebar-collapse", lang: "en", words: ["sidebar", "collapse"], phrase: "Sidebar collapse state is not remembered", reordered: "Collapse animation stutters when the sidebar has many views", split: ["Sidebar resize handle is hard to grab", "After a collapse the tree reopens at full width."], paraphrase: "Left navigation forgets it was folded" },
  { id: "oauth-callback", lang: "en", words: ["oauth", "callback"], phrase: "OAuth callback returns state mismatch", reordered: "Callback URL for oauth is hardcoded to localhost", split: ["OAuth consent screen shows the wrong app name", "The callback fires twice on Firefox."], paraphrase: "Third-party sign-in bounces back with an error" },
  { id: "cache-invalidation", lang: "en", words: ["cache", "invalidation"], phrase: "Cache invalidation misses the settings page", reordered: "Invalidation of the cache is per-tab instead of global", split: ["Cache serves yesterday's fields", "No invalidation happens after a bulk import."], paraphrase: "Stale data shown after saving preferences" },
  { id: "timezone-conversion", lang: "en", words: ["timezone", "conversion"], phrase: "Timezone conversion is off by an hour in March", reordered: "Conversion helper assumes the server timezone", split: ["Timezone picker lists deprecated zones", "Date conversion on the due field ignores DST."], paraphrase: "Due dates shift across daylight saving" },
  { id: "bulk-delete", lang: "en", words: ["bulk", "delete"], phrase: "Bulk delete has no confirmation", reordered: "Delete of many selected rows times out in bulk", split: ["Bulk actions bar is disabled with filters on", "After a delete the list does not refresh."], paraphrase: "Removing many tickets at once hangs" },
  { id: "audit-log", lang: "en", words: ["audit", "log"], phrase: "Audit log omits the actor", reordered: "Log entries for audit are out of order", split: ["Audit export is empty for last month", "The log retention period should be configurable."], paraphrase: "History trail does not say who changed what" },
  { id: "autosave-draft", lang: "en", words: ["autosave", "draft"], phrase: "Autosave draft loses the last paragraph", reordered: "Draft version goes backwards after autosave", split: ["Autosave interval is too long", "The draft list sorts by created instead of edited."], paraphrase: "Half-written comment disappears on refresh" },
  { id: "emoji-picker", lang: "en", words: ["emoji", "picker"], phrase: "Emoji picker search finds nothing", reordered: "Picker categories for emoji are misaligned", split: ["Emoji panel is slow to open", "Focus is lost when the picker closes."], paraphrase: "Smiley palette cannot find the reaction I want" },
  { id: "onboarding-checklist", lang: "en", words: ["onboarding", "checklist"], phrase: "Onboarding checklist cannot be dismissed", reordered: "Checklist progress during onboarding resets on logout", split: ["Onboarding tour points at a moved button", "The checklist shows 4 of 3 steps done."], paraphrase: "New user walkthrough will not go away" }
];

const ZH_TOPICS: Topic[] = [
  { id: "zh-login-timeout", lang: "zh", words: ["登录", "超时"], phrase: "登录超时后无法重试", reordered: "超时导致登录失败", split: ["登录页面白屏", "接口在30秒后超时,前端没有任何提示。"], paraphrase: "会话过期无法进入系统", typo: "登陆超时", mixed: "timeout" },
  { id: "zh-export-report", lang: "zh", words: ["导出", "报表"], phrase: "导出报表缺少表头", reordered: "报表页面点击导出没有反应", split: ["导出功能异常", "财务报表数据为空,下载的 csv 只有一行。"], paraphrase: "下载的Excel文件是空的", mixed: "csv" },
  { id: "zh-dark-mode", lang: "zh", words: ["暗黑", "模式"], phrase: "暗黑模式下字体看不清", reordered: "模式切换到暗黑后闪烁", split: ["暗黑主题按钮失效", "切换模式时页面重载,dark 主题丢失。"], paraphrase: "夜间主题下对比度不足", mixed: "dark" },
  { id: "zh-avatar-upload", lang: "zh", words: ["头像", "上传"], phrase: "头像上传失败提示413", reordered: "上传大图后头像不刷新", split: ["头像显示为默认图", "上传接口返回超时,upload 进度条卡在99%。"], paraphrase: "个人照片无法更换", mixed: "upload" },
  { id: "zh-password-reset", lang: "zh", words: ["密码", "重置"], phrase: "密码重置邮件收不到", reordered: "重置链接过期后密码没有更新", split: ["密码校验规则不一致", "重置流程缺少二次确认。"], paraphrase: "找回口令的邮件迟迟不到" },
  { id: "zh-notification-badge", lang: "zh", words: ["通知", "角标"], phrase: "通知角标数字不更新", reordered: "角标在读完通知后仍然显示", split: ["通知中心加载缓慢", "红点角标计数错误。"], paraphrase: "未读提醒的小红点不消失" },
  { id: "zh-shortcut-conflict", lang: "zh", words: ["快捷键", "冲突"], phrase: "快捷键冲突导致无法输入", reordered: "冲突的快捷键需要可配置", split: ["快捷键面板缺少说明", "与浏览器默认行为冲突。"], paraphrase: "键盘组合键被浏览器抢占" },
  { id: "zh-offline-sync", lang: "zh", words: ["离线", "同步"], phrase: "离线同步丢失最后一条记录", reordered: "同步在离线恢复后重复执行", split: ["离线状态提示不明显", "网络恢复后同步队列卡住,sync 日志无报错。"], paraphrase: "断网期间的修改回到线上就消失", mixed: "sync" },
  { id: "zh-db-migration", lang: "zh", words: ["数据库", "迁移"], phrase: "数据库迁移脚本失败", reordered: "迁移到新版本后数据库锁表", split: ["数据库连接池耗尽", "迁移工具版本不兼容。"], paraphrase: "升级建表脚本报错回滚" },
  { id: "zh-calendar-invite", lang: "zh", words: ["日历", "邀请"], phrase: "日历邀请时区错误", reordered: "邀请他人时日历不显示空闲时间", split: ["日历视图周起始日错误", "邀请邮件没有ics附件。"], paraphrase: "会议邀约的时间显示偏了八小时" },
  { id: "zh-sidebar-collapse", lang: "zh", words: ["侧边栏", "折叠"], phrase: "侧边栏折叠状态不记忆", reordered: "折叠后重新打开侧边栏宽度异常", split: ["侧边栏拖拽卡顿", "折叠动画掉帧。"], paraphrase: "左侧导航收起后再展开变宽了" },
  { id: "zh-cache-invalidation", lang: "zh", words: ["缓存", "失效"], phrase: "缓存失效策略不一致", reordered: "失效的缓存仍被读取", split: ["缓存命中率下降", "配置变更后没有失效。"], paraphrase: "改了设置页面还是老数据" },
  { id: "zh-bulk-delete", lang: "zh", words: ["批量", "删除"], phrase: "批量删除没有二次确认", reordered: "删除多选项目时批量操作超时", split: ["批量操作按钮禁用", "删除后列表不刷新。"], paraphrase: "一次勾选多条记录移除后卡死" },
  { id: "zh-audit-log", lang: "zh", words: ["审计", "日志"], phrase: "审计日志缺少操作人", reordered: "日志中的审计事件时间错乱", split: ["审计页面导出为空", "日志保留期限需要可配置。"], paraphrase: "操作留痕里看不到是谁改的" },
  { id: "zh-draft-autosave", lang: "zh", words: ["草稿", "自动保存"], phrase: "草稿自动保存丢失内容", reordered: "自动保存后草稿版本回退", split: ["草稿列表排序错误", "自动保存间隔过长。"], paraphrase: "写了一半的文字刷新后没了" },
  { id: "zh-emoji-picker", lang: "zh", words: ["表情", "选择器"], phrase: "表情选择器搜索无结果", reordered: "选择器里的表情分类错位", split: ["表情面板加载慢", "选择器关闭后焦点丢失。"], paraphrase: "emoji面板找不到想要的图案" }
];

export const TOPICS: Topic[] = [...EN_TOPICS, ...ZH_TOPICS];

const EN_NOUNS = [
  "button", "page", "table", "dialog", "modal", "filter", "column", "header", "footer", "banner", "tooltip", "icon", "font", "spacing", "color", "layout", "scroll", "focus", "cursor", "hover", "animation", "transition", "loader", "spinner", "toast", "alert", "error", "warning", "message", "label", "input", "form", "field", "checkbox", "radio", "dropdown", "select", "menu", "tab", "panel", "card", "list", "grid", "chart", "graph", "report", "dashboard", "settings", "profile", "account", "team", "member", "role", "permission", "token", "session", "cookie", "request", "response", "endpoint", "api", "query", "mutation", "schema", "migration", "database", "index", "cache", "queue", "worker", "job", "cron", "schedule", "email", "sms", "push", "webhook", "retry", "timeout", "latency", "memory", "cpu", "disk", "log", "trace", "metric", "deploy", "release", "version", "build", "test", "lint", "ci", "docker", "config", "env", "secret", "key", "certificate", "ssl", "dns", "cdn", "storage", "bucket", "upload", "download", "import", "export", "csv", "json", "xml", "pdf", "image", "video", "audio", "file", "folder", "path", "url", "link", "redirect", "route", "router", "view", "component", "hook", "state", "store", "reducer", "action", "event", "listener", "handler", "callback", "promise", "stream", "socket", "websocket", "polling", "sync", "offline", "online", "mobile", "desktop", "tablet", "browser", "login", "logout", "signup", "dark", "mode", "avatar", "password", "reset", "notification", "badge", "keyboard", "shortcut", "rate", "limit", "invoice", "search", "drag", "drop", "calendar", "invite", "markdown", "preview", "sidebar", "collapse", "oauth", "invalidation", "timezone", "conversion", "bulk", "delete", "audit", "autosave", "draft", "emoji", "picker", "onboarding", "checklist", "UI", "db", "QA", "2FA", "ios", "id",
  "breadcrumb", "pagination", "sorting", "grouping", "timeline", "milestone", "sprint", "epic", "story", "subtask", "comment", "mention", "reaction", "attachment", "thumbnail", "gallery", "carousel", "wizard", "stepper", "progress", "skeleton", "placeholder", "empty state", "onboarding email", "digest", "reminder", "snooze", "archive", "restore", "duplicate", "template", "preset", "theme", "locale", "translation", "currency", "number format", "date picker", "time picker", "range", "slider", "switch", "avatar group", "presence", "typing indicator", "read receipt", "thread", "reply", "quote", "forward", "share link", "embed", "iframe", "sandbox", "plugin", "extension", "marketplace", "billing", "subscription", "trial", "coupon", "tax", "receipt", "refund", "payout", "ledger", "quota", "usage", "seat", "workspace", "organisation", "domain", "sso", "saml", "scim", "audit trail", "retention", "backup", "snapshot", "replica", "shard", "partition", "vacuum", "analyze", "explain", "plan", "lock", "deadlock", "transaction", "rollback", "commit", "branch", "merge", "rebase", "conflict", "diff", "patch", "review", "approval", "checklist item", "label", "priority", "status", "assignee", "reporter", "watcher", "due date", "estimate", "velocity", "burndown"
];
const EN_VERBS = ["fails", "breaks", "flickers", "hangs", "crashes", "disappears", "overflows", "misaligns", "duplicates", "regressed", "is slow", "is blank", "is missing", "is clipped", "does nothing"];
const EN_PLATFORMS = ["Safari", "Chrome", "Firefox", "iOS", "Android", "Windows", "macOS", "Linux", "the desktop app", "mobile web", "the API", "the CLI"];
const EN_NAMES = ["Priya", "Tomás", "Wei", "Amara", "Jonas", "Yuki", "Fatima", "Noah", "Ines", "Kwame", "Leila", "Marco"];
const EN_TITLE_TEMPLATES = [
  (a: string, b: string, v: string, p: string) => `${cap(a)} ${b} ${v} on ${p}`,
  (a: string, b: string, _v: string, p: string) => `${cap(a)} ${b} not working after ${p} update`,
  (a: string, b: string, _v: string, p: string) => `Fix ${a} ${b} in ${p} view`,
  (a: string, b: string, v: string) => `${cap(a)} ${b} ${v}`,
  (a: string, b: string) => `Investigate ${a} ${b} regression`,
  (a: string, b: string, _v: string, p: string) => `${cap(a)} should not affect ${b} on ${p}`,
  (a: string, b: string) => `Add ${a} support to the ${b}`
];
const EN_BODY_TEMPLATES = [
  (r: Rng, a: string, b: string, p: string) => `Steps: open the ${a} ${b}, click ${r.pick(EN_NOUNS)}, wait for the ${r.pick(EN_NOUNS)}. Expected the ${a} to update. Actual: the ${b} ${r.pick(EN_VERBS)}. Seen on ${p}.`,
  (r: Rng, a: string, b: string, p: string) => `Reported by ${r.pick(EN_NAMES)} on ${p}. The ${b} ${r.pick(EN_VERBS)} whenever the ${a} changes. Happens on every ${r.pick(EN_NOUNS)} since the last ${r.pick(EN_NOUNS)} release.`,
  (r: Rng, a: string, b: string) => `Regression from the ${r.pick(EN_NOUNS)} refactor. The ${a} used to work with the ${b}; now the ${r.pick(EN_NOUNS)} ${r.pick(EN_VERBS)}. Needs a test around the ${r.pick(EN_NOUNS)} handler.`,
  (r: Rng, a: string, b: string, p: string) => `Customer on ${p} reports the ${a} ${r.pick(EN_VERBS)} after using the ${b}. Logs show a ${r.pick(EN_NOUNS)} ${r.pick(EN_NOUNS)} error. Workaround: reload the ${r.pick(EN_NOUNS)}.`
];
const EN_CLEAN_BODIES = [
  "Repro is consistent on the staging account. Screenshots attached in the thread. Needs a regression test before release.",
  "Happens for about a third of the beta group. No errors in the console; the network tab looks normal. Suspect a race in the renderer.",
  "First noticed after the September build. Rolling back the renderer fixes it, so the change is on our side.",
  "Low effort fix but touches shared code, so it needs a review from the platform owner. Add to the next patch release.",
  "Reproduced on two machines. Clearing site data does not help. The server logs show nothing unusual for those requests."
];

const ZH_NOUNS = [
  "页面", "按钮", "列表", "弹窗", "表单", "字段", "筛选", "排序", "分页", "加载", "刷新", "卡顿", "崩溃", "报错", "提示", "文案", "翻译", "图标", "字体", "颜色", "布局", "间距", "滚动", "焦点", "动画", "权限", "角色", "成员", "团队", "账号", "会话", "令牌", "接口", "请求", "响应", "参数", "校验", "配置", "环境", "部署", "发布", "版本", "构建", "测试", "监控", "告警", "指标", "性能", "内存", "磁盘", "网络", "移动端", "桌面端", "浏览器", "兼容", "邮件", "短信", "推送", "定时任务", "队列", "重试", "超时", "延迟", "导入", "导出", "附件", "图片", "视频", "文件", "文件夹", "路径", "链接", "跳转", "路由", "组件", "状态", "事件", "回调", "登录", "注册", "密码", "头像", "通知", "快捷键", "离线", "同步", "数据库", "迁移", "日历", "邀请", "侧边栏", "折叠", "缓存", "失效", "批量", "删除", "审计", "日志", "草稿", "自动保存", "表情", "选择器", "报表", "模式", "暗黑", "冲突", "角标", "重置", "上传",
  "面包屑", "分组", "时间线", "里程碑", "迭代", "史诗", "子任务", "评论", "提及", "附件", "缩略图", "向导", "进度条", "骨架屏", "空状态", "摘要", "提醒", "归档", "恢复", "复制", "模板", "主题", "语言", "货币", "日期选择", "滑块", "开关", "在线状态", "话题", "回复", "引用", "转发", "分享链接", "嵌入", "插件", "扩展", "账单", "订阅", "试用", "优惠券", "发票", "退款", "配额", "用量", "席位", "工作区", "组织", "域名", "单点登录", "保留期", "备份", "快照", "副本", "分片", "事务", "回滚", "提交", "分支", "合并", "变基", "差异", "补丁", "评审", "审批", "标签", "优先级", "负责人", "报告人", "关注人", "截止日期", "估算", "燃尽图"
];
const ZH_PREDICATES = ["不生效", "报错", "很慢", "错位", "闪烁", "重复", "丢失", "不刷新", "白屏", "卡死", "被截断", "没有反应"];
const ZH_PLATFORMS = ["Safari", "Chrome", "微信内置浏览器", "iOS", "安卓", "Windows", "macOS", "桌面端", "移动端", "API"];
const ZH_NAMES = ["小王", "李工", "张姐", "阿明", "老周", "陈总", "小林", "赵老师"];
const ZH_TITLE_TEMPLATES = [
  (a: string, b: string, v: string) => `${a}${b}时${v}`,
  (a: string, b: string, v: string) => `${a}的${b}${v}`,
  (a: string, b: string) => `${a}${b}后列表不刷新`,
  (a: string, b: string, v: string, p: string) => `${p}上${a}${b}${v}`,
  (a: string, b: string) => `${a}页面${b}异常`,
  (a: string, b: string, v: string) => `修复${a}${b}${v}的问题`,
  (a: string, b: string) => `${a}需要支持${b}`
];
const ZH_BODY_TEMPLATES = [
  (r: Rng, a: string, b: string, p: string) => `复现步骤:打开${a},点击${b},观察${r.pick(ZH_NOUNS)}。预期:${a}正常更新。实际:${b}${r.pick(ZH_PREDICATES)}。环境:${p}。`,
  (r: Rng, a: string, b: string, p: string) => `${r.pick(ZH_NAMES)}在${p}上反馈,${a}变化后${b}${r.pick(ZH_PREDICATES)}。上个${r.pick(ZH_NOUNS)}版本发布后开始出现。`,
  (r: Rng, a: string, b: string) => `${r.pick(ZH_NOUNS)}重构后的回归。以前${a}和${b}配合正常,现在${r.pick(ZH_NOUNS)}${r.pick(ZH_PREDICATES)}。需要补一个${r.pick(ZH_NOUNS)}的测试。`,
  (r: Rng, a: string, b: string, p: string) => `客户在${p}上反馈${a}${r.pick(ZH_PREDICATES)},之后${b}也不对。日志里有${r.pick(ZH_NOUNS)}相关报错。临时方案:刷新${r.pick(ZH_NOUNS)}。`
];
const ZH_CLEAN_BODIES = [
  "测试环境稳定复现,截图见群里。发布前需要补回归测试。",
  "大约三分之一的内测用户遇到。控制台没有报错,网络请求也正常,怀疑是渲染层的竞争条件。",
  "九月的构建之后开始出现,回滚渲染层就好了,问题在我们这边。",
  "改动不大但涉及公共代码,需要平台负责人审核,排进下一个补丁版本。",
  "两台机器上都复现了,清缓存没用,服务端日志里对应请求没有异常。"
];

export const SHORT_TOKENS = ["UI", "db", "QA", "2FA", "ios"];

class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    // mulberry32
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  shuffle<T>(xs: T[]): T[] {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    }
    return xs;
  }
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

function decoy(r: Rng, lang: Lang, n: number): Omit<BenchItem, "key"> {
  if (lang === "en") {
    const a = r.pick(EN_NOUNS);
    const b = r.pick(EN_NOUNS);
    const p = r.pick(EN_PLATFORMS);
    const title = r.pick(EN_TITLE_TEMPLATES)(a, b, r.pick(EN_VERBS), p);
    let body = r.pick(EN_BODY_TEMPLATES)(r, r.pick(EN_NOUNS), r.pick(EN_NOUNS), p);
    body += ` ${r.pick(EN_CLEAN_BODIES)}`;
    if (r.chance(0.4)) body += ` ${r.pick(EN_BODY_TEMPLATES)(r, r.pick(EN_NOUNS), r.pick(EN_NOUNS), r.pick(EN_PLATFORMS))}`;
    if (r.chance(0.3)) body += ` Ref TOM-${1 + r.int(n)}.`;
    return { title, body, lang, topic: null, variant: null };
  }
  const a = r.pick(ZH_NOUNS);
  const b = r.pick(ZH_NOUNS);
  const p = r.pick(ZH_PLATFORMS);
  const title = r.pick(ZH_TITLE_TEMPLATES)(a, b, r.pick(ZH_PREDICATES), p);
  let body = r.pick(ZH_BODY_TEMPLATES)(r, r.pick(ZH_NOUNS), r.pick(ZH_NOUNS), p);
  body += r.pick(ZH_CLEAN_BODIES);
  if (r.chance(0.4)) body += r.pick(ZH_BODY_TEMPLATES)(r, r.pick(ZH_NOUNS), r.pick(ZH_NOUNS), r.pick(ZH_PLATFORMS));
  if (r.chance(0.3)) body += `相关工单 TOM-${1 + r.int(n)}。`;
  return { title, body, lang, topic: null, variant: null };
}

function topicItems(r: Rng, t: Topic): Omit<BenchItem, "key">[] {
  const clean = () => (t.lang === "en" ? r.pick(EN_CLEAN_BODIES) : r.pick(ZH_CLEAN_BODIES));
  const [splitTitle, splitBody] = t.split;
  return [
    { title: t.phrase, body: clean(), lang: t.lang, topic: t.id, variant: "phrase" },
    { title: t.reordered, body: clean(), lang: t.lang, topic: t.id, variant: "reordered" },
    { title: splitTitle, body: `${splitBody} ${clean()}`, lang: t.lang, topic: t.id, variant: "split" },
    { title: t.paraphrase, body: clean(), lang: t.lang, topic: t.id, variant: "paraphrase" }
  ];
}

export interface Dataset {
  items: BenchItem[];
  queries: BenchQuery[];
}

/** `n` items in total; the topics' items are shuffled in among the decoys. */
export function generateDataset(n: number, seed = 42): Dataset {
  const r = new Rng(seed);
  const relevant = TOPICS.flatMap((t) => topicItems(r, t));
  if (n < relevant.length) throw new Error(`n must be at least ${relevant.length}`);
  const raw: Omit<BenchItem, "key">[] = [...relevant];
  while (raw.length < n) raw.push(decoy(r, r.chance(0.65) ? "en" : "zh", n));
  r.shuffle(raw);
  const items: BenchItem[] = raw.map((it, i) => ({ ...it, key: i + 1 }));

  const byTopic = new Map<string, number[]>();
  for (const it of items) if (it.topic) byTopic.set(it.topic, [...(byTopic.get(it.topic) ?? []), it.key]);
  const queries: BenchQuery[] = [];
  const push = (id: string, text: string, category: Category, rel: number[]) => queries.push({ id, text, category, relevant: rel });

  for (const t of TOPICS) {
    const rel = byTopic.get(t.id)!;
    const [w1, w2] = t.words;
    if (t.lang === "en") {
      push(`${t.id}/phrase`, `${w1} ${w2}`, "en-phrase", rel);
      push(`${t.id}/reordered`, `${w2} ${w1}`, "en-reordered", rel);
      push(`${t.id}/single`, w1, "en-single", rel);
    } else {
      push(`${t.id}/phrase`, `${w1}${w2}`, "zh-phrase", rel);
      push(`${t.id}/words`, `${w1} ${w2}`, "zh-words", rel);
      push(`${t.id}/single`, w1, [...w1].length >= 3 ? "zh-single-3" : "zh-single-2", rel);
    }
    if (t.typo) push(`${t.id}/typo`, t.typo, "typo", rel);
    if (t.synonym) push(`${t.id}/synonym`, t.synonym, "synonym", rel);
    if (t.mixed) push(`${t.id}/mixed`, `${w1} ${t.mixed}`, "mixed", rel);
  }

  // Keys and short tokens have no semantic label; a person searching them wants every mention.
  const mentions = (needle: string) => items.filter((it) => (it.title + " " + it.body).toLowerCase().includes(needle.toLowerCase())).map((it) => it.key);
  const keysMentioned = [...new Set(items.flatMap((it) => [...it.body.matchAll(/TOM-(\d+)/g)].map((m) => m[0])))].sort();
  for (const k of keysMentioned.filter((_, i) => i % Math.max(1, Math.floor(keysMentioned.length / 5)) === 0).slice(0, 5)) push(`key/${k}`, k, "key", mentions(k));
  for (const tok of SHORT_TOKENS) push(`short/${tok}`, tok, "short", mentions(tok));

  return { items, queries };
}
