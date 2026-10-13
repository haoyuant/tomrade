/**
 * Words for the steps an engine takes with its own tools (a shell command, a
 * file edit), so the panel shows what each one did, not just that it ran.
 */

const HINT_KEYS = ["command", "cmd", "file_path", "path", "filePath", "pattern", "query", "url", "description", "prompt"];

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** The argument that says most about a call: the command, the file, the pattern. */
export function stepHint(args: unknown, max = 100): string {
  if (typeof args === "string") return clip(oneLine(args), max);
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  for (const key of HINT_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return clip(oneLine(value), max);
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) return clip(oneLine(value.join(" ")), max);
  }
  return "";
}

/** Text out of a tool result as engines pass it: a string, content blocks, or `{ content }`. */
function resultText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : typeof part === "string" ? part : "")).join("\n");
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    if ("content" in record) return resultText(record.content);
    if (typeof record.text === "string") return record.text;
    if (typeof record.output === "string") return record.output;
    if (typeof record.error === "string") return record.error;
  }
  return "";
}

/** The first line of a result that says something. */
export function resultLine(output: unknown, max = 160): string {
  const line = resultText(output).split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  return clip(line, max);
}

/** The one line under a step: what it was asked to do, and why it failed when it did. */
export function stepSummary(args: unknown, output: unknown, ok: boolean): string {
  const hint = stepHint(args);
  if (ok) return hint || resultLine(output);
  const why = resultLine(output);
  return hint && why ? `${hint} — ${why}` : hint || why || "failed";
}
