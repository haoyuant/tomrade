import { useSyncExternalStore } from "react";
import { CHORD, DEFAULT_KEYS } from "@tomradex/keybindings/chord";
import type { MessageKey } from "./i18n";
import { isMac } from "./keys";

/**
 * Every command a key can run. Their default keys live in `@tomradex/keybindings`,
 * where the main process quotes them too; the person's settings hold only the
 * commands they rebound (`keybindings.overrides`, a user-scope section that
 * travels with the Hub).
 */
export type CommandId =
  | "palette"
  | "newTicket"
  | "switchProject"
  | "sidebar"
  | "assistant"
  | "sessionBar"
  | "settings"
  | "undo"
  | "redo"
  | "searchNotes"
  | "searchTickets"
  | "shortcuts"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "backlogTab"
  | "readWrite"
  | "saveBody";

export type CommandGroup = "anywhere" | "tabs" | "board" | "writing";

export interface CommandSpec {
  id: CommandId;
  group: CommandGroup;
  label: MessageKey;
  defaults: string[];
}

/** Keys that belong to a control rather than to a command: shown, never rebound. */
export interface FixedKey {
  group: CommandGroup;
  label: MessageKey;
  keys: string[];
}

export const COMMANDS: CommandSpec[] = [
  { id: "palette", group: "anywhere", label: "shortcuts.palette", defaults: DEFAULT_KEYS.palette },
  { id: "newTicket", group: "anywhere", label: "shortcuts.newTicket", defaults: DEFAULT_KEYS.newTicket },
  { id: "switchProject", group: "anywhere", label: "shortcuts.switchProject", defaults: DEFAULT_KEYS.switchProject },
  { id: "sidebar", group: "anywhere", label: "shortcuts.sidebar", defaults: DEFAULT_KEYS.sidebar },
  { id: "assistant", group: "anywhere", label: "shortcuts.assistant", defaults: DEFAULT_KEYS.assistant },
  { id: "sessionBar", group: "anywhere", label: "shortcuts.sessionBar", defaults: DEFAULT_KEYS.sessionBar },
  { id: "settings", group: "anywhere", label: "shortcuts.settings", defaults: DEFAULT_KEYS.settings },
  { id: "undo", group: "anywhere", label: "shortcuts.undo", defaults: DEFAULT_KEYS.undo },
  { id: "redo", group: "anywhere", label: "shortcuts.redo", defaults: DEFAULT_KEYS.redo },
  { id: "searchNotes", group: "anywhere", label: "shortcuts.searchNotes", defaults: DEFAULT_KEYS.searchNotes },
  { id: "shortcuts", group: "anywhere", label: "shortcuts.thisSheet", defaults: DEFAULT_KEYS.shortcuts },
  { id: "closeTab", group: "tabs", label: "shortcuts.closeTab", defaults: DEFAULT_KEYS.closeTab },
  { id: "nextTab", group: "tabs", label: "shortcuts.nextTab", defaults: DEFAULT_KEYS.nextTab },
  { id: "prevTab", group: "tabs", label: "shortcuts.prevTab", defaults: DEFAULT_KEYS.prevTab },
  { id: "backlogTab", group: "tabs", label: "shortcuts.backlogTab", defaults: DEFAULT_KEYS.backlogTab },
  { id: "searchTickets", group: "board", label: "shortcuts.searchTickets", defaults: DEFAULT_KEYS.searchTickets },
  { id: "readWrite", group: "writing", label: "shortcuts.readWrite", defaults: DEFAULT_KEYS.readWrite },
  { id: "saveBody", group: "writing", label: "shortcuts.saveBody", defaults: DEFAULT_KEYS.saveBody }
];

export const FIXED: FixedKey[] = [
  { group: "anywhere", label: "shortcuts.closePane", keys: ["Escape"] },
  { group: "board", label: "shortcuts.moveFocus", keys: ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] },
  { group: "board", label: "shortcuts.openCard", keys: ["Enter"] },
  { group: "board", label: "shortcuts.moveCard", keys: ["Alt+ArrowLeft", "Alt+ArrowRight"] },
  { group: "board", label: "shortcuts.folders", keys: ["ArrowLeft", "ArrowRight"] },
  { group: "writing", label: "shortcuts.discardBody", keys: ["Escape"] }
];

export const GROUPS: { id: CommandGroup; title: MessageKey }[] = [
  { id: "anywhere", title: "shortcuts.anywhere" },
  { id: "tabs", title: "shortcuts.tabs" },
  { id: "board", title: "shortcuts.board" },
  { id: "writing", title: "shortcuts.writing" }
];

const SPEC = new Map(COMMANDS.map((c) => [c.id, c]));
export const isCommandId = (id: string): id is CommandId => SPEC.has(id as CommandId);

export type Overrides = Partial<Record<CommandId, string[]>>;
export type Keymap = Record<CommandId, string[]>;

/** The defaults under what the person rebound; an override naming no known command is ignored. */
export function resolveKeymap(overrides: Record<string, string[]> | undefined): Keymap {
  const map = {} as Keymap;
  for (const c of COMMANDS) map[c.id] = overrides && Array.isArray(overrides[c.id]) ? overrides[c.id]! : c.defaults;
  return map;
}

/* ─── chords ─────────────────────────────────────────────────────────── */

interface Chord {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

const MOD_ORDER = ["Mod", "Ctrl", "Alt", "Shift"] as const;

function parseChord(chord: string): Chord {
  const parts = chord.split("+");
  // "Mod++" is not a thing we write, but a "+" key would be "Shift+="; the last part is always the key.
  const key = parts.pop() ?? "";
  const mods = new Set(parts);
  return { mod: mods.has("Mod"), ctrl: mods.has("Ctrl"), alt: mods.has("Alt"), shift: mods.has("Shift"), key };
}

const writeChord = (c: Chord): string =>
  [...MOD_ORDER.filter((m) => (m === "Mod" ? c.mod : m === "Ctrl" ? c.ctrl : m === "Alt" ? c.alt : c.shift)), c.key].join("+");

/** A printable key that is not a letter or digit: the shift that makes it is part of the key itself. */
const isSymbol = (key: string) => key.length === 1 && !/[A-Z0-9]/.test(key);

/**
 * The key an event names, the way chords write it. A letter or digit comes
 * from the physical key when the typed character is not one — ⌥ on a Mac
 * turns K into ˚, and a Cyrillic layout gives no Latin letter at all.
 */
function eventKey(e: Pick<KeyboardEvent, "key" | "code">): string {
  const k = e.key;
  if (/^[a-zA-Z0-9]$/.test(k)) return k.toUpperCase();
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  if (k === " ") return "Space";
  if (k === "Esc") return "Escape";
  return k;
}

type KeyEventLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/**
 * Whether the event is this chord. On a Mac, `lenientCtrl` lets Ctrl stand in
 * for ⌘ — Tomrade always took either — except where the caller is in a text
 * editor, whose Ctrl chords move the caret.
 */
export function matchesChord(e: KeyEventLike, chord: string, opts: { mac?: boolean; lenientCtrl?: boolean } = {}): boolean {
  const mac = opts.mac ?? isMac;
  const c = parseChord(chord);
  if (eventKey(e) !== c.key) return false;
  let meta = e.metaKey;
  let ctrl = e.ctrlKey;
  if (mac && opts.lenientCtrl && c.mod && !c.ctrl && ctrl && !meta) {
    meta = true;
    ctrl = false;
  }
  const wantMeta = mac && c.mod;
  const wantCtrl = mac ? c.ctrl : c.mod || c.ctrl;
  if (meta !== wantMeta || ctrl !== wantCtrl || e.altKey !== c.alt) return false;
  return isSymbol(c.key) || e.shiftKey === c.shift;
}

/**
 * The chord a key press records, or null while only modifiers are down. Off a
 * Mac, Ctrl is written as Mod, so the chord means the same on the next machine.
 */
export function chordFromEvent(e: KeyEventLike, mac = isMac): string | null {
  const key = eventKey(e);
  if (["Meta", "Control", "Alt", "Shift", "CapsLock", "Fn", "OS", "Dead", "Unidentified", "Process"].includes(key)) return null;
  const symbol = isSymbol(key);
  return writeChord({
    mod: mac ? e.metaKey : e.ctrlKey,
    ctrl: mac && e.ctrlKey,
    alt: e.altKey,
    shift: !symbol && e.shiftKey,
    key
  });
}

const GLYPHS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: "↵",
  Escape: "Esc",
  Tab: "⇥",
  Backspace: "⌫",
  Delete: "⌦",
  Space: "Space",
  PageUp: "PgUp",
  PageDown: "PgDn"
};
const WORDS: Record<string, string> = { ...GLYPHS, Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Del" };

/** A chord as this platform writes it: "⇧⌘Z" on a Mac, "Ctrl+Shift+Z" elsewhere. */
export function formatChord(chord: string, mac = isMac): string {
  const c = parseChord(chord);
  if (mac) {
    const key = GLYPHS[c.key] ?? c.key;
    const mods = `${c.ctrl ? "⌃" : ""}${c.alt ? "⌥" : ""}${c.shift ? "⇧" : ""}${c.mod ? "⌘" : ""}`;
    return mods + (mods && key.length > 1 && !GLYPHS[c.key] ? ` ${key}` : key);
  }
  const key = WORDS[c.key] ?? c.key;
  return [...(c.mod || c.ctrl ? ["Ctrl"] : []), ...(c.alt ? ["Alt"] : []), ...(c.shift ? ["Shift"] : []), key].join("+");
}

/** Whether two chords are the same keys — off a Mac, "Ctrl+Tab" and "Mod+Tab" are. */
export function sameChord(a: string, b: string, mac = isMac): boolean {
  const x = parseChord(a);
  const y = parseChord(b);
  const ctrl = (c: Chord) => (mac ? c.ctrl : c.mod || c.ctrl);
  return x.key === y.key && (!mac || x.mod === y.mod) && ctrl(x) === ctrl(y) && x.alt === y.alt && (isSymbol(x.key) || x.shift === y.shift);
}

/** The other commands already on this chord. */
export function conflictsOf(map: Keymap, id: CommandId, chord: string, mac = isMac): CommandId[] {
  return COMMANDS.filter((c) => c.id !== id && map[c.id].some((k) => sameChord(k, chord, mac))).map((c) => c.id);
}

/* ─── the live map ───────────────────────────────────────────────────── */

let current: Keymap = resolveKeymap(undefined);
const listeners = new Set<() => void>();

let announced = current;

/**
 * Set from the settings query while the i18n provider renders, so labels drawn
 * in the same pass already read it; subscribers hear of it after the commit.
 */
export function primeKeymap(next: Keymap): void {
  current = next;
}

export function announceKeymap(): void {
  if (announced === current) return;
  announced = current;
  for (const l of listeners) l();
}

/** The chord of this command the event is, under the person's keys; null when none. */
export const hitChord = (e: KeyEventLike, id: CommandId, opts?: { lenientCtrl?: boolean }): string | null =>
  current[id].find((chord) => matchesChord(e, chord, opts)) ?? null;

/** Whether the event runs this command under the person's keys. */
export const hits = (e: KeyEventLike, id: CommandId, opts?: { lenientCtrl?: boolean }): boolean => hitChord(e, id, opts) !== null;

/** A chord with no ⌘, Ctrl or ⌥: a key that also types something. */
export const isBare = (chord: string): boolean => {
  const c = parseChord(chord);
  return !c.mod && !c.ctrl && !c.alt;
};

export function useKeymap(): Keymap {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current
  );
}

/** The first chord on a command, written for this platform; "" when it has none. Components using `t` re-render with it. */
export function keyLabel(id: CommandId): string {
  const chord = current[id][0];
  return chord ? formatChord(chord) : "";
}

/* ─── export / import ────────────────────────────────────────────────── */

const EXPORT_KIND = "tomrade.keybindings";

export interface KeybindingsFile {
  kind: typeof EXPORT_KIND;
  version: 1;
  overrides: Overrides;
}

export const exportKeybindings = (overrides: Overrides): KeybindingsFile => ({ kind: EXPORT_KIND, version: 1, overrides });


/**
 * The overrides a file carries. Commands this build does not know are
 * skipped, as are chords it could not match; anything that is not ours at
 * all is refused whole.
 */
export function parseKeybindingsFile(text: string): { overrides: Overrides; skipped: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("not-json");
  }
  const file = raw as Partial<KeybindingsFile> | null;
  if (!file || typeof file !== "object" || file.kind !== EXPORT_KIND || typeof file.overrides !== "object" || !file.overrides) throw new Error("not-keybindings");
  const overrides: Overrides = {};
  let skipped = 0;
  for (const [id, chords] of Object.entries(file.overrides)) {
    if (!isCommandId(id) || !Array.isArray(chords)) {
      skipped++;
      continue;
    }
    const good = chords.filter((k): k is string => typeof k === "string" && CHORD.test(k)).slice(0, 4);
    if (good.length !== chords.length) skipped++;
    overrides[id] = good;
  }
  return { overrides, skipped };
}
