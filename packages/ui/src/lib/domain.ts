import type { BuiltinFieldId, FieldDef, FieldType, FilterOp, Item, ItemStatus, Layout, OplogEntry, Priority, Provenance } from "@tomradex/domain";
import { ICON_IDS, type IconId } from "~/components/icons";
import { say, type Locale, type MessageKey } from "./dicts";

/**
 * Vocabulary shared by nearly every screen (status, priority, field, layout
 * and provenance words; relative timestamps) is read from the dictionaries
 * into mutable tables rather than through `t()` at each site — `setDomainLocale`
 * swaps the values in place, so every existing `STATUS[k].label` /
 * `timeAgo(...)` call site picks up the active language with no change of its
 * own. Any component that reads one of these should also call `useI18n()` for
 * something else on the same render, so it re-renders when the locale flips.
 */
let currentLocale: Locale = "en";

/** The tag `Intl` and `<html lang>` take for a locale: the Chinese ones name their region, any other tag is its own. */
const INTL_TAG: Record<string, string> = { zh: "zh-CN", "zh-Hant": "zh-TW" };
export const intlTag = (locale: Locale): string => (Object.hasOwn(INTL_TAG, locale) ? INTL_TAG[locale]! : locale);

/** Words in the language `setDomainLocale` last set. */
const word = (key: MessageKey, vars?: Record<string, string | number>): string => say(currentLocale, key, vars);

/** Status marks are shape-coded: each is legible in greyscale. */
export const STATUS: Record<ItemStatus, { label: string; mark: IconId }> = {
  backlog: { label: "", mark: "s-backlog" },
  todo: { label: "", mark: "s-todo" },
  doing: { label: "", mark: "s-doing" },
  verifying: { label: "", mark: "s-verifying" },
  done: { label: "", mark: "s-done" },
  cancelled: { label: "", mark: "s-cancelled" }
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
export const PRIORITY_LABEL: string[] = PRIORITIES.map(() => "");

export const PROVENANCE: Record<Provenance, string> = { ai: "", human: "", sync: "", locked: "" };

/** The glyphs a workstream or a view may carry in the sidebar. */
export const BOARD_GLYPHS: [IconId, string][] = [
  ["i-panel", ""],
  ["i-stack", ""],
  ["i-plug", ""],
  ["i-monitor", ""],
  ["i-board", ""],
  ["i-filter", ""],
  ["i-bug", ""],
  ["i-bars", ""],
  ["i-graph", ""],
  ["i-clock", ""],
  ["i-tag", ""]
];

/** Built-in field names, localized in place like the tables above. */
export const FIELD_LABEL: Record<BuiltinFieldId, string> = { title: "", status: "", workType: "", priority: "", epic: "", labels: "", board: "", updated: "", key: "", provenance: "" };

export const FIELD_TYPE_LABEL: Record<FieldType, string> = { text: "", number: "", date: "", select: "", checkbox: "", labels: "", item: "" };

/** Stored icon names come from the database; an unknown one falls back rather than rendering nothing. */
export const viewIcon = (name: string): IconId => ((ICON_IDS as readonly string[]).includes(name) ? (name as IconId) : "i-board");

/** A custom field is named by its owner; a built-in by the active locale. */
export const fieldLabel = (def: FieldDef): string => (def.builtin ? (FIELD_LABEL[def.id as BuiltinFieldId] ?? def.name) : def.name);

/** The three ways a view draws the backlog. */
export const LAYOUT_LABEL: Record<Layout, { label: string; icon: IconId }> = {
  board: { label: "", icon: "i-board" },
  table: { label: "", icon: "i-bars" },
  graph: { label: "", icon: "i-graph" }
};

export const FILTER_OP_LABEL: Record<FilterOp, string> = { in: "", "not-in": "", contains: "", gte: "", lte: "" };
const FILTER_OP_KEY = { in: "domain.filterOp_in", "not-in": "domain.filterOp_notIn", contains: "domain.filterOp_contains", gte: "domain.filterOp_gte", lte: "domain.filterOp_lte" } as const satisfies Record<FilterOp, MessageKey>;

/**
 * What the layouts draw when a view has not chosen its fields. The view
 * settings sheet edits against the same list, so both agree on "default".
 */
export const DEFAULT_SHOWN_FIELDS: Record<Layout, string[]> = {
  board: ["status", "priority", "epic", "labels", "board"],
  table: ["status", "priority", "epic", "labels", "board", "updated"],
  graph: ["status", "priority", "labels"]
};

/** The name of a field's empty group: "No epic", "Unchecked", "No Due"… */
export function emptyGroupLabel(def: FieldDef): string {
  if (def.id === "epic") return word("domain.empty_epic");
  if (def.id === "board") return word("domain.empty_board");
  if (def.type === "checkbox") return word("domain.empty_checkbox");
  return word("domain.empty_generic", { name: fieldLabel(def) });
}

export const checkedLabel = (): string => word("domain.checked");
export const manualSortLabel = (): string => word("domain.manualSort");

/** Called once per render from `I18nProvider`; see the file-level comment above. */
export function setDomainLocale(locale: Locale): void {
  currentLocale = locale;
  for (const k of STATUS_KEYS) STATUS[k].label = word(`domain.status_${k}`);
  for (const p of PRIORITIES) PRIORITY_LABEL[p] = word(`domain.priority${p}`);
  for (const p of Object.keys(PROVENANCE) as Provenance[]) PROVENANCE[p] = word(`domain.provenance_${p}`);
  for (let i = 0; i < BOARD_GLYPHS.length; i++) BOARD_GLYPHS[i][1] = word(`domain.glyph${i}` as MessageKey);
  for (const f of Object.keys(FIELD_LABEL) as BuiltinFieldId[]) FIELD_LABEL[f] = word(`domain.field_${f}`);
  for (const ty of Object.keys(FIELD_TYPE_LABEL) as FieldType[]) FIELD_TYPE_LABEL[ty] = word(`domain.fieldType_${ty}`);
  for (const l of Object.keys(LAYOUT_LABEL) as Layout[]) LAYOUT_LABEL[l].label = word(`domain.layout_${l}`);
  for (const op of Object.keys(FILTER_OP_LABEL) as FilterOp[]) FILTER_OP_LABEL[op] = word(FILTER_OP_KEY[op]);
}
// English until the provider names the language showing.
setDomainLocale("en");

export function provenanceOf(item: Item): Provenance {
  if (item.humanLocked) return "locked";
  return item.updatedBy.startsWith("ai:") ? "ai" : "human";
}

/** "2m ago" / "2分钟前", but "now"/"刚刚" stays bare — "now ago" is not a phrase in any language. */
export const agoLabel = (ts: number, now = Date.now()) => {
  const short = timeAgo(ts, now);
  return short === word("domain.time_now") ? short : word("domain.time_ago", { time: short });
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
  if (day(d) === day(new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1))) return `${word("domain.time_tomorrow")} ${time}`;
  if (currentLocale === "en") return `${d.toLocaleString("en", { month: "short" })} ${d.getDate()} ${time}`;
  return `${d.toLocaleDateString(intlTag(currentLocale), { month: "short", day: "numeric" })} ${time}`;
}

/** Short relative time, the same string the card prints and recency sorts on. */
export function timeAgo(ts: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - ts) / 60000));
  if (mins < 1) return word("domain.time_now");
  if (mins < 60) return word("domain.time_minutes", { n: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return word("domain.time_hours", { n: hours });
  const days = Math.round(hours / 24);
  if (days < 30) return word("domain.time_days", { n: days });
  const months = Math.round(days / 30);
  if (months < 12) return word("domain.time_months", { n: months });
  return word("domain.time_years", { n: Math.round(months / 12) });
}

/** The author as history prints it: a sync is a machine settling a clash, not an agent writing. */
const AUTHORS: Record<string, MessageKey> = {
  human: "ledger.author_human",
  "ai:sync": "ledger.author_sync",
  "ai:loop": "ledger.author_loop",
  "ai:mcp": "ledger.author_mcp",
  "ai:claude-code": "ledger.author_claudeCode",
  "ai:codex": "ledger.author_codex",
  "ai:pi": "ledger.author_pi",
  "ai:automation": "ledger.author_automation"
};

/** Who wrote, as a person reads it: "You", "The assistant", an agent's name — not its author id. */
export function authorLabel(by: string): string {
  const known = Object.hasOwn(AUTHORS, by) ? AUTHORS[by] : undefined;
  if (known) return word(known);
  return by.startsWith("ai:") ? by.slice(3) : by;
}

const FIELD_WORDS = ["title", "body", "status", "priority", "boardId", "parentId", "rank", "keyNum", "name"] as const;
const fieldWord = (field: string): string =>
  (FIELD_WORDS as readonly string[]).includes(field) ? word(`ledger.field_${field as (typeof FIELD_WORDS)[number]}`) : field;

const valueWord = (value: unknown): string => {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.length > 40 ? value.slice(0, 40) + "…" : value;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
};

/** What one oplog row did, phrased from the before/after snapshots. */
export function describeWrite(entry: OplogEntry): string {
  if (entry.op === "create") return word("ledger.write_create");
  if (entry.op === "delete") return word("ledger.write_delete");
  if (entry.op === "purge") return word("ledger.write_purge");
  if (entry.op === "rank") return word("ledger.write_rank");
  if (entry.op === "merge") {
    // A note a sync left: which field, what stood, what lost.
    const winner = (entry.after ?? {}) as Record<string, unknown>;
    const loser = (entry.before ?? {}) as Record<string, unknown>;
    const field = Object.keys(winner)[0] ?? Object.keys(loser).find((k) => k !== "reason") ?? "";
    if (loser.reason === "renumbered") return word("ledger.write_renumbered", { from: valueWord(loser.keyNum), to: valueWord(winner.keyNum) });
    if (loser.reason === "edited-over-delete") return word("ledger.write_editedOverDelete");
    return word("ledger.write_merged", { field: fieldWord(field), kept: valueWord(winner[field]), lost: valueWord(loser[field]) });
  }
  const before = entry.before as Item | null;
  const after = entry.after as Item | null;
  if (before && after) {
    if (before.status !== after.status) return word("ledger.write_status", { status: after.status, label: STATUS[after.status].label });
    if (before.priority !== after.priority) return word("ledger.write_priority", { priority: PRIORITY_LABEL[after.priority].toLowerCase() });
    if (before.humanLocked !== after.humanLocked) return word(after.humanLocked ? "ledger.write_locked" : "ledger.write_unlocked");
    if (before.parentId !== after.parentId) return word(after.parentId ? "ledger.write_linked" : "ledger.write_unlinked");
    if (before.labels.join() !== after.labels.join()) return word("ledger.write_labels");
    if (before.boardId !== after.boardId) return word("ledger.write_moved");
    if (JSON.stringify(before.fields ?? {}) !== JSON.stringify(after.fields ?? {})) return word("ledger.write_fields");
    if (before.title !== after.title) return word("ledger.write_title");
    if (before.body !== after.body) return word("ledger.write_body");
    if (before.rank !== after.rank) return word("ledger.write_reordered");
  }
  return word("ledger.write_updated");
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
