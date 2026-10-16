/** Folded under the error line; past this the head and the tail are what anyone reads. */
export const DETAILS_MAX_CHARS = 12_000;

const SECRETS: [RegExp, string][] = [
  [/\b(sk-(?:ant-)?)[A-Za-z0-9_-]{8,}/g, "$1…"],
  [/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/g, "$1…"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1…"],
  [/(\b(?:api[_-]?key|[a-z_-]*token|secret|password|authorization)["']?\s*[:=]\s*["']?(?:Bearer\s+)?)(?!Bearer\b)[^\s"',}…]{6,}/gi, "$1…"]
];

/** Keys and tokens never reach a block the person may paste into a bug report. */
export const redactSecrets = (text: string): string => SECRETS.reduce((out, [pattern, to]) => out.replace(pattern, to), text);

/**
 * A provider's error body pasted into the message ("400 {"type":"error","error":{"message":…}}")
 * read as its own words; anything else comes back unchanged.
 */
export function readableError(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return text;
  try {
    const body = JSON.parse(text.slice(start, end + 1)) as { error?: unknown; message?: unknown };
    const inner = body.error && typeof body.error === "object" ? (body.error as { message?: unknown }).message : body.error;
    const said = [inner, body.message].find((m): m is string => typeof m === "string" && m.trim() !== "");
    if (!said) return text;
    const before = text.slice(0, start).trim();
    return before ? `${before} ${said.trim()}` : said.trim();
  } catch {
    return text;
  }
}

const json = (value: unknown): string => {
  try {
    // Headers and Maps would print as {}.
    const plain = (v: unknown) => typeof v === "bigint" ? String(v)
      : v && typeof v === "object" && typeof (v as Map<unknown, unknown>).entries === "function" && typeof (v as Map<unknown, unknown>).get === "function" ? Object.fromEntries((v as Map<string, unknown>).entries())
      : v;
    return JSON.stringify(value, (_key, v) => plain(v), 2) ?? String(value);
  } catch {
    return String(value);
  }
};

function describeError(error: Error, depth: number): string {
  const lines = [`${error.name}: ${error.message}`];
  for (const [key, value] of Object.entries(error)) {
    if (key === "cause" || key === "stack" || key === "message" || key === "name" || value === undefined || typeof value === "function") continue;
    lines.push(`${key}: ${typeof value === "string" ? value : json(value)}`);
  }
  if (error.stack) lines.push(error.stack.split("\n").slice(1).join("\n"));
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined && depth < 4) lines.push(`caused by ${describe(cause, depth + 1)}`);
  return lines.join("\n");
}

function describe(value: unknown, depth = 0): string {
  if (value instanceof Error) return describeError(value, depth);
  if (typeof value === "string") return value.trim();
  return json(value);
}

/**
 * Everything known about a failed turn, in named sections — the error with its
 * fields, causes and stack, the agent's own answer, its stderr — for the
 * person to read and copy. Empty sections are left out; undefined when none remain.
 */
export function describeFailure(sections: Record<string, unknown>): string | undefined {
  const parts = Object.entries(sections)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([name, value]) => [name, describe(value)] as const)
    .filter(([, text]) => text)
    .map(([name, text]) => `── ${name} ──\n${text}`);
  if (!parts.length) return undefined;
  const text = redactSecrets(parts.join("\n\n"));
  if (text.length <= DETAILS_MAX_CHARS) return text;
  const half = DETAILS_MAX_CHARS / 2;
  return `${text.slice(0, half)}\n… ${text.length - DETAILS_MAX_CHARS} characters left out …\n${text.slice(-half)}`;
}
