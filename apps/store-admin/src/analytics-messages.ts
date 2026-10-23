export const en = {
  title: "Usage analytics", subtitle: "Internal · anonymous usage · UTC days",
  range: "Period", region: "Region", metric: "Rank by", feature: "Feature", language: "Language", refresh: "Refresh",
  all: "All regions", cn: "Mainland China", apac: "Asia Pacific", eu: "Europe", na: "North America", other: "Other",
  days7: "7 days", days30: "30 days", days90: "90 days", duration: "Active minutes", uses: "Uses",
  active: "Active anonymous IDs today", periodActive: "Active anonymous IDs in period", overview: "Daily overview",
  overviewHint: "Switch metrics in the legend. Gaps are days without data; the shaded day is still in progress.",
  ranking: "Feature ranking", rankingHint: "Top features in the period. Click one to open its trend.",
  detail: "Feature daily trend", features: "All features", share: "Share", perDay: "per day",
  day: "UTC day", activeIds: "Active anonymous IDs", dailyData: "Daily data", today: "Today (incomplete)",
  empty: "No usage data in this period and region.", failed: "Could not load usage data. Check the configured endpoints and migrations, then retry.",
  invalid: "Invalid filters.", latest: "Latest event received", none: "No events", retention: "Next-day retention",
  retentionHint: "Of the IDs first seen on a day, the share that came back the next day.",
  cohort: "IDs first seen in selected period", returned: "Returned next day", rate: "Return rate",
  note: "Counts describe anonymous installations, not people. Cross-deployment counts are added without joining IDs. Missing days are gaps, not measured zeroes. Today is incomplete.",
  pending: "Pending", average: "Daily average over selected period", minutes: "min"
};
export const zh: typeof en = {
  title: "使用分析", subtitle: "内部使用 · 匿名统计 · UTC 日期",
  range: "时间范围", region: "地区", metric: "排序指标", feature: "功能", language: "语言", refresh: "刷新",
  all: "全部地区", cn: "中国大陆", apac: "亚太", eu: "欧洲", na: "北美", other: "其他",
  days7: "7 天", days30: "30 天", days90: "90 天", duration: "有效使用分钟数", uses: "使用次数",
  active: "今日活跃匿名 ID", periodActive: "期间活跃匿名 ID", overview: "每日概览",
  overviewHint: "在图例中切换指标。空缺表示当天没有数据；阴影标出的今天尚未结束。",
  ranking: "功能排行", rankingHint: "期间内排名靠前的功能，点击查看它的趋势。",
  detail: "功能每日趋势", features: "全部功能", share: "占比", perDay: "每天",
  day: "UTC 日期", activeIds: "活跃匿名 ID", dailyData: "每日数据", today: "今天（未结束）",
  empty: "此时间范围和地区暂无使用数据。", failed: "无法加载使用数据，请检查端点配置与数据库迁移后重试。",
  invalid: "筛选条件无效。", latest: "最新事件接收时间", none: "暂无事件", retention: "次日留存",
  retentionHint: "当天首次出现的 ID 中，第二天再次使用的比例。",
  cohort: "所选期间首次出现的 ID", returned: "次日再次使用", rate: "返回比例",
  note: "计数代表匿名安装，不代表人数。跨部署只相加计数，不关联 ID。缺失日期保留空缺，不表示实测为零。今日数据尚不完整。",
  pending: "待观察", average: "所选期间的日均值", minutes: "分钟"
};
export type MessageKey = keyof typeof en;
export const translator = (lang: "en" | "zh") => (key: MessageKey): string => (lang === "zh" ? zh : en)[key];
