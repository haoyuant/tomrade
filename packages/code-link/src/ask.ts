import type { SessionAsk } from "./store.js";
import { CODE_WORDS, type CodeWords } from "./words.js";

/** The tools that run a command, as each agent names its own. */
const RUN_TOOL = /^(?:bash|shell|exec_command|local_shell|run_shell_command|run_terminal_cmd|terminal|run_command|execute_command)$/i;
/** The tools that change a file. */
const EDIT_TOOL = /^(?:edit|write|multiedit|notebookedit|write_file|edit_file|replace|apply_patch|str_replace(?:_editor|_based_edit_tool)?|create_file)$/i;
/** How long a command or a path may be on a card. */
const DETAIL_MAX = 80;

const text = (input: Record<string, unknown> | undefined, ...keys: string[]): string => {
  for (const key of keys) {
    const v = input?.[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v) && v.every((x) => typeof x === "string") && v.length) return v.join(" ");
  }
  return "";
};

/** A command clipped at its end, a path at its start: what matters of each stays in view. */
const clip = (value: string, fromStart: boolean): string | null => {
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  if (flat.length <= DETAIL_MAX) return flat;
  return fromStart ? `…${flat.slice(flat.length - DETAIL_MAX + 1)}` : `${flat.slice(0, DETAIL_MAX - 1)}…`;
};

/** A tool's permission asked for, read from what its hook sent: the command it would run, the file it would change, or the tool alone. */
export function permissionAsk(tool: string | null | undefined, input: Record<string, unknown> | undefined): SessionAsk {
  const name = tool?.trim() || null;
  if (!name) return { kind: "permission", tool: null, action: null, detail: null };
  if (RUN_TOOL.test(name)) return { kind: "permission", tool: name, action: "run", detail: clip(text(input, "command", "cmd"), false) };
  if (EDIT_TOOL.test(name)) return { kind: "permission", tool: name, action: "edit", detail: clip(text(input, "file_path", "path", "notebook_path", "filename"), true) };
  return { kind: "permission", tool: name, action: "use", detail: clip(text(input, "description", "query", "url", "pattern", "prompt"), false) };
}

export const questionAsk = (): SessionAsk => ({ kind: "question", tool: null, action: null, detail: null });

/** The same ask, repeated by another hook (Claude Code's PermissionRequest, then its permission Notification). */
export const sameAsk = (a: SessionAsk | null, b: SessionAsk | null): boolean => !!a && !!b && a.kind === b.kind && a.tool === b.tool && a.detail === b.detail;

/** What a session asks, as a line in the person's language for what the backend says itself: herdr's notice, the waiting list. */
export function askLine(ask: SessionAsk, w: CodeWords): string {
  if (ask.kind === "question") return w("askQuestion");
  if (ask.action === "run") return ask.detail ? w("askRun", { detail: ask.detail }) : w("askRunAny");
  if (ask.action === "edit") return ask.detail ? w("askEdit", { detail: ask.detail }) : w("askEditAny");
  if (ask.tool) return ask.detail ? w("askTool", { tool: ask.tool, detail: ask.detail }) : w("askToolAny", { tool: ask.tool });
  return w("askApproval");
}

/** The same line in a given language, for what speaks for the app outside code link: the waiting list, a notification. */
export const askLineIn = (ask: SessionAsk, locale: string | undefined): string => askLine(ask, CODE_WORDS(locale));
