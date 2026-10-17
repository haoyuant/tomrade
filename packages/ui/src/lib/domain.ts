import type { BuiltinFieldId, FieldDef, FieldType, FilterOp, Item, ItemStatus, Layout, OplogEntry, Priority, Provenance } from "@tomradex/domain";
import { ICON_IDS, type IconId } from "~/components/icons";
import type { Locale } from "./i18n";

/**
 * Vocabulary shared by nearly every screen (status, priority, field, layout
 * and provenance words; relative timestamps) lives here as mutable tables
 * rather than routed through the generic `t()` key system — `setDomainLocale`
 * swaps the values in place, so every existing `STATUS[k].label` /
 * `timeAgo(...)` call site picks up the active language with no change of its
 * own. Any component that reads one of these should also call `useI18n()` for
 * something else on the same render, so it re-renders when the locale flips.
 */
let currentLocale: Locale = "en";

/** The tag `Intl` and `<html lang>` take for each locale. */
export const INTL_TAG: Record<Locale, string> = { en: "en", zh: "zh-CN", "zh-Hant": "zh-TW", ja: "ja", es: "es", de: "de", fr: "fr" };

const STATUS_LABEL: Record<Locale, Record<ItemStatus, string>> = {
  en: { backlog: "Backlog", todo: "To Do", doing: "Doing", verifying: "Verifying", done: "Done", cancelled: "Cancelled" },
  zh: { backlog: "待处理", todo: "待办", doing: "进行中", verifying: "验证中", done: "已完成", cancelled: "已取消" },
  "zh-Hant": { backlog: "待處理", todo: "待辦", doing: "進行中", verifying: "驗證中", done: "已完成", cancelled: "已取消" },
  ja: { backlog: "バックログ", todo: "未着手", doing: "進行中", verifying: "検証中", done: "完了", cancelled: "キャンセル" },
  es: { backlog: "Backlog", todo: "Por hacer", doing: "En curso", verifying: "Verificando", done: "Hecho", cancelled: "Cancelado" },
  de: { backlog: "Backlog", todo: "Zu erledigen", doing: "In Arbeit", verifying: "In Prüfung", done: "Erledigt", cancelled: "Abgebrochen" },
  fr: { backlog: "Backlog", todo: "À faire", doing: "En cours", verifying: "En vérification", done: "Terminé", cancelled: "Annulé" }
};

/** Status marks are shape-coded: each is legible in greyscale. */
export const STATUS: Record<ItemStatus, { label: string; mark: IconId }> = {
  backlog: { label: STATUS_LABEL.en.backlog, mark: "s-backlog" },
  todo: { label: STATUS_LABEL.en.todo, mark: "s-todo" },
  doing: { label: STATUS_LABEL.en.doing, mark: "s-doing" },
  verifying: { label: STATUS_LABEL.en.verifying, mark: "s-verifying" },
  done: { label: STATUS_LABEL.en.done, mark: "s-done" },
  cancelled: { label: STATUS_LABEL.en.cancelled, mark: "s-cancelled" }
};

export const STATUS_KEYS = Object.keys(STATUS) as ItemStatus[];

/** One hue stepped light to dark — a status ramp is not six accents. */
export const STATUS_FILL: Record<ItemStatus, string> = {
  backlog: "var(--tag-bg-soft)",
  todo: "var(--tag-bg-base)",
  doing: "var(--accent-light)",
  verifying: "var(--accent)",
  done: "var(--accent-active)",
  cancelled: "var(--meta)"
};

export const PRIORITIES: Priority[] = [0, 1, 2, 3, 4];
const PRIORITY_LABEL_BY_LOCALE: Record<Locale, readonly string[]> = {
  en: ["None", "Low", "Medium", "High", "Urgent"],
  zh: ["无", "低", "中", "高", "紧急"],
  "zh-Hant": ["無", "低", "中", "高", "緊急"],
  ja: ["なし", "低", "中", "高", "緊急"],
  es: ["Ninguna", "Baja", "Media", "Alta", "Urgente"],
  de: ["Keine", "Niedrig", "Mittel", "Hoch", "Dringend"],
  fr: ["Aucune", "Basse", "Moyenne", "Haute", "Urgente"]
};
export const PRIORITY_LABEL: string[] = [...PRIORITY_LABEL_BY_LOCALE.en];

const PROVENANCE_BY_LOCALE: Record<Locale, Record<Provenance, string>> = {
  en: { ai: "Agent", human: "Human", sync: "Git", locked: "Locked" },
  zh: { ai: "智能体", human: "人工", sync: "Git 同步", locked: "已锁定" },
  "zh-Hant": { ai: "代理", human: "人工", sync: "Git 同步", locked: "已鎖定" },
  ja: { ai: "エージェント", human: "人", sync: "Git", locked: "ロック中" },
  es: { ai: "Agente", human: "Persona", sync: "Git", locked: "Bloqueado" },
  de: { ai: "Agent", human: "Mensch", sync: "Git", locked: "Gesperrt" },
  fr: { ai: "Agent", human: "Humain", sync: "Git", locked: "Verrouillé" }
};

export const PROVENANCE: Record<Provenance, string> = { ...PROVENANCE_BY_LOCALE.en };

const BOARD_GLYPH_LABEL: Record<Locale, readonly string[]> = {
  en: ["Panel", "Stack", "Plug", "Monitor", "Board", "Filter", "Bug", "Bars", "Graph", "Clock", "Tag"],
  zh: ["面板", "堆叠", "插头", "显示器", "看板", "筛选", "缺陷", "柱状", "关系图", "时钟", "标签"],
  "zh-Hant": ["面板", "堆疊", "插頭", "顯示器", "看板", "篩選", "缺陷", "長條", "關係圖", "時鐘", "標籤"],
  ja: ["パネル", "スタック", "プラグ", "モニター", "ボード", "フィルター", "バグ", "棒グラフ", "グラフ", "時計", "タグ"],
  es: ["Panel", "Pila", "Enchufe", "Monitor", "Tablero", "Filtro", "Error", "Barras", "Grafo", "Reloj", "Etiqueta"],
  de: ["Panel", "Stapel", "Stecker", "Monitor", "Board", "Filter", "Fehler", "Balken", "Graph", "Uhr", "Tag"],
  fr: ["Panneau", "Pile", "Prise", "Écran", "Tableau", "Filtre", "Bug", "Barres", "Graphe", "Horloge", "Étiquette"]
};

/** The glyphs a workstream or a view may carry in the sidebar. */
export const BOARD_GLYPHS: [IconId, string][] = [
  ["i-panel", "Panel"],
  ["i-stack", "Stack"],
  ["i-plug", "Plug"],
  ["i-monitor", "Monitor"],
  ["i-board", "Board"],
  ["i-filter", "Filter"],
  ["i-bug", "Bug"],
  ["i-bars", "Bars"],
  ["i-graph", "Graph"],
  ["i-clock", "Clock"],
  ["i-tag", "Tag"]
];

const FIELD_LABEL_BY_LOCALE: Record<Locale, Record<BuiltinFieldId, string>> = {
  en: { title: "Title", status: "Status", workType: "Work type", priority: "Priority", epic: "Epic", labels: "Labels", board: "Workstream", updated: "Updated", key: "Key", provenance: "Last write" },
  zh: { title: "标题", status: "状态", workType: "工作类型", priority: "优先级", epic: "需求组", labels: "标签", board: "工作流", updated: "更新时间", key: "编号", provenance: "最后写入" },
  "zh-Hant": { title: "標題", status: "狀態", workType: "工作類型", priority: "優先級", epic: "需求組", labels: "標籤", board: "工作流", updated: "更新時間", key: "編號", provenance: "最後寫入" },
  ja: { title: "タイトル", status: "ステータス", workType: "作業タイプ", priority: "優先度", epic: "エピック", labels: "ラベル", board: "ワークストリーム", updated: "更新日時", key: "キー", provenance: "最終書き込み" },
  es: { title: "Título", status: "Estado", workType: "Tipo de trabajo", priority: "Prioridad", epic: "Épica", labels: "Etiquetas", board: "Flujo de trabajo", updated: "Actualizado", key: "Clave", provenance: "Última escritura" },
  de: { title: "Titel", status: "Status", workType: "Arbeitstyp", priority: "Priorität", epic: "Epic", labels: "Labels", board: "Workstream", updated: "Aktualisiert", key: "Schlüssel", provenance: "Letzte Änderung" },
  fr: { title: "Titre", status: "Statut", workType: "Type de travail", priority: "Priorité", epic: "Epic", labels: "Étiquettes", board: "Flux de travail", updated: "Mis à jour", key: "Clé", provenance: "Dernière écriture" }
};

/** Built-in field names, localized in place like the tables above. */
export const FIELD_LABEL: Record<BuiltinFieldId, string> = { ...FIELD_LABEL_BY_LOCALE.en };

const FIELD_TYPE_LABEL_BY_LOCALE: Record<Locale, Record<FieldType, string>> = {
  en: { text: "Text", number: "Number", date: "Date", select: "Single select", checkbox: "Checkbox", labels: "Labels", item: "Item" },
  zh: { text: "文本", number: "数字", date: "日期", select: "单选", checkbox: "勾选框", labels: "标签", item: "工作项" },
  "zh-Hant": { text: "文字", number: "數字", date: "日期", select: "單選", checkbox: "核取方塊", labels: "標籤", item: "工作項" },
  ja: { text: "テキスト", number: "数値", date: "日付", select: "単一選択", checkbox: "チェックボックス", labels: "ラベル", item: "アイテム" },
  es: { text: "Texto", number: "Número", date: "Fecha", select: "Selección única", checkbox: "Casilla", labels: "Etiquetas", item: "Elemento" },
  de: { text: "Text", number: "Zahl", date: "Datum", select: "Einfachauswahl", checkbox: "Kontrollkästchen", labels: "Labels", item: "Eintrag" },
  fr: { text: "Texte", number: "Nombre", date: "Date", select: "Choix unique", checkbox: "Case à cocher", labels: "Étiquettes", item: "Élément" }
};

export const FIELD_TYPE_LABEL: Record<FieldType, string> = { ...FIELD_TYPE_LABEL_BY_LOCALE.en };

/** Stored icon names come from the database; an unknown one falls back rather than rendering nothing. */
export const viewIcon = (name: string): IconId => ((ICON_IDS as readonly string[]).includes(name) ? (name as IconId) : "i-board");

/** A custom field is named by its owner; a built-in by the active locale. */
export const fieldLabel = (def: FieldDef): string => (def.builtin ? (FIELD_LABEL[def.id as BuiltinFieldId] ?? def.name) : def.name);

const LAYOUT_LABEL_BY_LOCALE: Record<Locale, Record<Layout, string>> = {
  en: { board: "Board", table: "Table", graph: "Graph" },
  zh: { board: "看板", table: "表格", graph: "关系图" },
  "zh-Hant": { board: "看板", table: "表格", graph: "關係圖" },
  ja: { board: "ボード", table: "テーブル", graph: "グラフ" },
  es: { board: "Tablero", table: "Tabla", graph: "Grafo" },
  de: { board: "Board", table: "Tabelle", graph: "Graph" },
  fr: { board: "Tableau", table: "Table", graph: "Graphe" }
};

/** The three ways a view draws the backlog. */
export const LAYOUT_LABEL: Record<Layout, { label: string; icon: IconId }> = {
  board: { label: LAYOUT_LABEL_BY_LOCALE.en.board, icon: "i-board" },
  table: { label: LAYOUT_LABEL_BY_LOCALE.en.table, icon: "i-bars" },
  graph: { label: LAYOUT_LABEL_BY_LOCALE.en.graph, icon: "i-graph" }
};

const FILTER_OP_BY_LOCALE: Record<Locale, Record<FilterOp, string>> = {
  en: { in: "is", "not-in": "is not", contains: "contains", gte: "≥", lte: "≤" },
  zh: { in: "是", "not-in": "不是", contains: "包含", gte: "≥", lte: "≤" },
  "zh-Hant": { in: "是", "not-in": "不是", contains: "包含", gte: "≥", lte: "≤" },
  ja: { in: "=", "not-in": "≠", contains: "含む", gte: "≥", lte: "≤" },
  es: { in: "es", "not-in": "no es", contains: "contiene", gte: "≥", lte: "≤" },
  de: { in: "ist", "not-in": "ist nicht", contains: "enthält", gte: "≥", lte: "≤" },
  fr: { in: "est", "not-in": "n’est pas", contains: "contient", gte: "≥", lte: "≤" }
};

export const FILTER_OP_LABEL: Record<FilterOp, string> = { ...FILTER_OP_BY_LOCALE.en };

/**
 * What the layouts draw when a view has not chosen its fields. The view
 * settings sheet edits against the same list, so both agree on "default".
 */
export const DEFAULT_SHOWN_FIELDS: Record<Layout, string[]> = {
  board: ["status", "priority", "epic", "labels", "board"],
  table: ["status", "priority", "epic", "labels", "board", "updated"],
  graph: ["status", "priority", "labels"]
};

const EMPTY_LABEL_BY_LOCALE: Record<Locale, { epic: string; board: string; checkbox: string; generic: string; checked: string; manual: string }> = {
  en: { epic: "No epic", board: "No workstream", checkbox: "Unchecked", generic: "No {{name}}", checked: "Checked", manual: "Manual" },
  zh: { epic: "无需求组", board: "无工作流", checkbox: "未勾选", generic: "无{{name}}", checked: "已勾选", manual: "手动" },
  "zh-Hant": { epic: "無需求組", board: "無工作流", checkbox: "未勾選", generic: "無{{name}}", checked: "已勾選", manual: "手動" },
  ja: { epic: "エピックなし", board: "ワークストリームなし", checkbox: "未チェック", generic: "{{name}}なし", checked: "チェック済み", manual: "手動" },
  es: { epic: "Sin épica", board: "Sin flujo de trabajo", checkbox: "Sin marcar", generic: "Sin {{name}}", checked: "Marcado", manual: "Manual" },
  de: { epic: "Kein Epic", board: "Kein Workstream", checkbox: "Nicht angehakt", generic: "Kein {{name}}", checked: "Angehakt", manual: "Manuell" },
  fr: { epic: "Sans epic", board: "Sans flux de travail", checkbox: "Non cochée", generic: "Sans {{name}}", checked: "Cochée", manual: "Manuel" }
};

/** The name of a field's empty group: "No epic", "Unchecked", "No Due"… */
export function emptyGroupLabel(def: FieldDef): string {
  const words = EMPTY_LABEL_BY_LOCALE[currentLocale];
  if (def.id === "epic") return words.epic;
  if (def.id === "board") return words.board;
  if (def.type === "checkbox") return words.checkbox;
  return words.generic.replace("{{name}}", fieldLabel(def));
}

export const checkedLabel = (): string => EMPTY_LABEL_BY_LOCALE[currentLocale].checked;
export const manualSortLabel = (): string => EMPTY_LABEL_BY_LOCALE[currentLocale].manual;

/** Called once per render from `I18nProvider`; see the file-level comment above. */
export function setDomainLocale(locale: Locale): void {
  currentLocale = locale;
  for (const k of STATUS_KEYS) STATUS[k].label = STATUS_LABEL[locale][k];
  PRIORITY_LABEL.splice(0, PRIORITY_LABEL.length, ...PRIORITY_LABEL_BY_LOCALE[locale]);
  for (const p of Object.keys(PROVENANCE) as Provenance[]) PROVENANCE[p] = PROVENANCE_BY_LOCALE[locale][p];
  for (let i = 0; i < BOARD_GLYPHS.length; i++) BOARD_GLYPHS[i][1] = BOARD_GLYPH_LABEL[locale][i];
  for (const f of Object.keys(FIELD_LABEL) as BuiltinFieldId[]) FIELD_LABEL[f] = FIELD_LABEL_BY_LOCALE[locale][f];
  for (const ty of Object.keys(FIELD_TYPE_LABEL) as FieldType[]) FIELD_TYPE_LABEL[ty] = FIELD_TYPE_LABEL_BY_LOCALE[locale][ty];
  for (const l of Object.keys(LAYOUT_LABEL) as Layout[]) LAYOUT_LABEL[l].label = LAYOUT_LABEL_BY_LOCALE[locale][l];
  for (const op of Object.keys(FILTER_OP_LABEL) as FilterOp[]) FILTER_OP_LABEL[op] = FILTER_OP_BY_LOCALE[locale][op];
}

export function provenanceOf(item: Item): Provenance {
  if (item.humanLocked) return "locked";
  return item.updatedBy.startsWith("ai:") ? "ai" : "human";
}

/** Relative-time words: the short units a card prints, how "ago" wraps them, and "tomorrow". */
const TIME_WORDS: Record<Locale, { now: string; m: string; h: string; d: string; mo: string; y: string; ago: (s: string) => string; tomorrow: string }> = {
  en: { now: "now", m: "m", h: "h", d: "d", mo: "mo", y: "y", ago: (s) => `${s} ago`, tomorrow: "tomorrow" },
  zh: { now: "刚刚", m: "分钟", h: "小时", d: "天", mo: "个月", y: "年", ago: (s) => `${s}前`, tomorrow: "明天" },
  "zh-Hant": { now: "剛剛", m: "分鐘", h: "小時", d: "天", mo: "個月", y: "年", ago: (s) => `${s}前`, tomorrow: "明天" },
  ja: { now: "たった今", m: "分", h: "時間", d: "日", mo: "か月", y: "年", ago: (s) => `${s}前`, tomorrow: "明日" },
  es: { now: "ahora", m: " min", h: " h", d: " d", mo: " meses", y: " años", ago: (s) => `hace ${s}`, tomorrow: "mañana" },
  de: { now: "jetzt", m: " Min.", h: " Std.", d: " T.", mo: " Mon.", y: " J.", ago: (s) => `vor ${s}`, tomorrow: "morgen" },
  fr: { now: "maintenant", m: " min", h: " h", d: " j", mo: " mois", y: " ans", ago: (s) => `il y a ${s}`, tomorrow: "demain" }
};

/** "2m ago" / "2分钟前", but "now"/"刚刚" stays bare — "now ago" is not a phrase in any language. */
export const agoLabel = (ts: number, now = Date.now()) => {
  const short = timeAgo(ts, now);
  const words = TIME_WORDS[currentLocale];
  return short === words.now ? short : words.ago(short);
};

/** Money as a run reports it: cents once it is a dollar or more, a tenth of a cent below. */
export const usd = (v: number): string => (v >= 1 ? `$${v.toFixed(2)}` : v > 0 && v < 0.001 ? "<$0.001" : `$${v.toFixed(3)}`);

/** A time ahead, as a clock reads it: "20:00", "tomorrow 09:00", "Oct 15 09:00". */
export function clockLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const n = new Date(now);
  if (day(d) === day(n)) return time;
  if (day(d) === day(new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1))) return `${TIME_WORDS[currentLocale].tomorrow} ${time}`;
  if (currentLocale === "en") return `${d.toLocaleString("en", { month: "short" })} ${d.getDate()} ${time}`;
  return `${d.toLocaleDateString(INTL_TAG[currentLocale], { month: "short", day: "numeric" })} ${time}`;
}

/** Short relative time, the same string the card prints and recency sorts on. */
export function timeAgo(ts: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - ts) / 60000));
  const w = TIME_WORDS[currentLocale];
  if (mins < 1) return w.now;
  if (mins < 60) return `${mins}${w.m}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}${w.h}`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}${w.d}`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}${w.mo}`;
  const years = Math.round(months / 12);
  return `${years}${w.y}`;
}

/** The author as history prints it: a sync is a machine settling a clash, not an agent writing. */
const AUTHORS: Record<string, [string, string]> = {
  human: ["You", "你"],
  "ai:sync": ["Sync", "同步"],
  "ai:loop": ["The assistant", "助手"],
  "ai:mcp": ["An agent", "智能体"],
  "ai:claude-code": ["Claude Code", "Claude Code"],
  "ai:codex": ["Codex", "Codex"],
  "ai:pi": ["Pi", "Pi"],
  "ai:automation": ["A routine", "例行事务"]
};

/** Who wrote, as a person reads it: "You", "The assistant", an agent's name — not its author id. */
export function authorLabel(by: string): string {
  const known = AUTHORS[by];
  if (known) return known[currentLocale === "zh" ? 1 : 0];
  return by.startsWith("ai:") ? by.slice(3) : by;
}

const fieldWord = (field: string): string => {
  const zh = currentLocale === "zh";
  const table: Record<string, [string, string]> = {
    title: ["title", "标题"],
    body: ["description", "描述"],
    status: ["status", "状态"],
    priority: ["priority", "优先级"],
    boardId: ["workstream", "工作流"],
    parentId: ["epic", "需求组"],
    rank: ["order", "顺序"],
    keyNum: ["key", "编号"],
    name: ["name", "名称"]
  };
  const hit = table[field];
  return hit ? hit[zh ? 1 : 0] : field;
};

const valueWord = (value: unknown): string => {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.length > 40 ? value.slice(0, 40) + "…" : value;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
};

/** What one oplog row did, phrased from the before/after snapshots. */
export function describeWrite(entry: OplogEntry): string {
  const zh = currentLocale === "zh";
  if (entry.op === "create") return zh ? "创建了该工作项" : "created the issue";
  if (entry.op === "delete") return zh ? "删除了该工作项" : "deleted the issue";
  if (entry.op === "purge") return zh ? "永久删除了该工作项" : "permanently deleted the issue";
  if (entry.op === "rank") return zh ? "调整了排序" : "moved it in a view";
  if (entry.op === "merge") {
    // A note a sync left: which field, what stood, what lost.
    const winner = (entry.after ?? {}) as Record<string, unknown>;
    const loser = (entry.before ?? {}) as Record<string, unknown>;
    const field = Object.keys(winner)[0] ?? Object.keys(loser).find((k) => k !== "reason") ?? "";
    if (loser.reason === "renumbered") return zh ? `将编号从 ${valueWord(loser.keyNum)} 改为 ${valueWord(winner.keyNum)}（另一台机器先用了它）` : `renumbered the key from ${valueWord(loser.keyNum)} to ${valueWord(winner.keyNum)} (another machine used it first)`;
    if (loser.reason === "edited-over-delete") return zh ? "同步时保留了一边的编辑，另一边曾删除它" : "kept an edit over a delete from another machine";
    return zh
      ? `同步时将${fieldWord(field)}定为 ${valueWord(winner[field])}，另一台机器改成的 ${valueWord(loser[field])} 被搁置`
      : `sync kept ${fieldWord(field)} ${valueWord(winner[field])} over ${valueWord(loser[field])} from another machine`;
  }
  const before = entry.before as Item | null;
  const after = entry.after as Item | null;
  if (before && after) {
    if (before.status !== after.status) return zh ? `将状态设为${STATUS[after.status].label}` : `set status to ${after.status}`;
    if (before.priority !== after.priority)
      return zh ? `将优先级设为${PRIORITY_LABEL[after.priority]}` : `set priority to ${PRIORITY_LABEL[after.priority].toLowerCase()}`;
    if (before.humanLocked !== after.humanLocked)
      return after.humanLocked ? (zh ? "锁定了标题与描述" : "locked title and body") : zh ? "解除了标题与描述的锁定" : "unlocked title and body";
    if (before.parentId !== after.parentId)
      return after.parentId
        ? zh
          ? "将该工作项关联到了需求组"
          : "linked the issue to an epic"
        : zh
          ? "取消了该工作项与需求组的关联"
          : "unlinked the issue from its epic";
    if (before.labels.join() !== after.labels.join()) return zh ? "修改了标签" : "changed the labels";
    if (before.boardId !== after.boardId) return zh ? "将该工作项移动到了其他工作流" : "moved the issue to another workstream";
    if (JSON.stringify(before.fields ?? {}) !== JSON.stringify(after.fields ?? {})) return zh ? "修改了字段值" : "changed a field";
    if (before.title !== after.title) return zh ? "编辑了标题" : "edited the title";
    if (before.body !== after.body) return zh ? "编辑了描述" : "edited the description";
    if (before.rank !== after.rank) return zh ? "调整了该工作项的顺序" : "reordered the issue";
  }
  return zh ? "更新了该工作项" : "updated the issue";
}

/** The mark an oplog row carries in the ledger gutter. */
export function ledgerMarkOf(entry: OplogEntry): "tick" | "lock" | "sync" | null {
  const locked = entry.op === "update" && !!(entry.after as Item | null)?.humanLocked && !(entry.before as Item | null)?.humanLocked;
  if (locked) return "lock";
  if (entry.by === "ai:sync" || entry.op === "merge") return "sync";
  return entry.by.startsWith("ai:") ? "tick" : null;
}

/** Epics are structure, not cards: they name the epic columns and never fill one. */
export const isTicket = (item: Item) => item.kind !== "epic";
