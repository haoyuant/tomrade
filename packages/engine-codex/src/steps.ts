import { stepHint, stepSummary, type Block, type RetryState } from "@tomradex/agent";

type Json = any;

const outputTail = (output: string): string => output.trimEnd().split("\n").slice(-30).join("\n").slice(-8000);
const shellWord = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

// Only simple commands have an unambiguous exit-1 meaning. Do not guess for pipelines or expansions.
function commands(source: string): string[][] | null {
  const out: string[][] = [[]];
  let word = "", quote = "", started = false;
  const push = () => { if (started) out.at(-1)!.push(word); word = ""; started = false; };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "$" || c === "`") return null;
    if (c === "\\" && quote !== "'") {
      if (++i === source.length) return null;
      word += source[i]; started = true;
    } else if (quote) {
      if (c === quote) quote = ""; else word += c;
    } else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (c === "&" && source[i + 1] === "&") { push(); out.push([]); i++; }
    else if (/[|;&<>()\n]/.test(c)) return null;
    else if (/\s/.test(c)) push();
    else { word += c; started = true; }
  }
  push();
  return quote || out.some(words => !words.length) ? null : out;
}

function exitOneMeaning(command: string): "no-match" | "condition-false" | null {
  const parsed = commands(command);
  if (!parsed) return null;
  if (parsed.length === 1) {
    const [bin, flag, body] = parsed[0];
    if (/^(?:.*\/)?(?:ba|z|da)?sh$/.test(bin) && /^-[a-z]*c[a-z]*$/.test(flag ?? "") && parsed[0].length === 3) return exitOneMeaning(body);
  }
  const meanings = parsed.map(words => {
    const bin = words[0].split("/").at(-1);
    if (["rg", "grep", "egrep", "fgrep"].includes(bin!)) return "no-match" as const;
    if (bin === "test" || (bin === "[" && words.at(-1) === "]") ||
        (bin === "git" && words[1] === "diff" && words.some(w => w === "--quiet" || w === "--exit-code"))) return "condition-false" as const;
    return null;
  });
  // In an && chain, any earlier command may have supplied the exit code.
  return meanings.every(meaning => meaning === meanings[0]) ? meanings[0] : null;
}

function commandStatus(status: string, code: number | null, command: string, output: string): NonNullable<Step["commandResult"]>["status"] {
  if (status === "declined" || status === "rejected") return "declined";
  if (["timedOut", "timed_out", "timeout", "timed-out"].includes(status) || code === 124 ||
      (status === "failed" && /^(?:Command|Process) timed out\b/im.test(output))) return "timed-out";
  if (["interrupted", "cancelled", "canceled", "inProgress", "in_progress"].includes(status)) return "interrupted";
  if (code === 1) return exitOneMeaning(command) ?? "failed";
  return status === "completed" && (code === 0 || code === null) ? "success" : "failed";
}

/** A tool step Codex ran itself, as the panel shows it; null for items that are not steps or that Tomrade traces itself. */
type Step = Omit<Extract<Block, { type: "trace" }>, "type"> & { label: string };

export function codexStep(item: Json): Step | null {
  const done = item.status === "completed";
  const ms = item.durationMs ?? (item.duration ? item.duration.secs * 1000 + item.duration.nanos / 1e6 : 0);
  switch (item.type) {
    case "CommandExecution":
    case "command_execution":
    case "commandExecution": {
      const command = Array.isArray(item.command) ? item.command.map(shellWord).join(" ") : String(item.command ?? "");
      const args = { command, cwd: item.cwd };
      const exitCode = item.exitCode ?? item.exit_code ?? null;
      const output = outputTail(item.aggregatedOutput ?? item.aggregated_output ?? "");
      const status = commandStatus(item.status, exitCode, command, output);
      const ok = ["success", "no-match", "condition-false"].includes(status);
      const hint = stepHint(args);
      return { tool: "shell", args, ok, summary: status === "failed" && exitCode !== null ? `${hint} — exit ${exitCode}` : hint,
        ms, label: `shell · ${stepHint(args, 60)}`, commandResult: { status, exitCode, output } };
    }
    case "fileChange": {
      const paths: string[] = (item.changes ?? []).map((change: Json) => change.path);
      const args = { paths };
      const ok = done;
      return { tool: "edit", args, ok, summary: `${paths.join(", ")}${ok ? "" : ` — ${item.status}`}`, ms, label: `edit · ${paths[0] ?? ""}` };
    }
    case "mcpToolCall": {
      // Tomrade's own tools are traced by the gateway they run through.
      if (item.server === "tomrade") return null;
      const ok = done && !item.error;
      return { tool: `${item.server}.${item.tool}`, args: item.arguments, ok, summary: stepSummary(item.arguments, item.error?.message ?? item.result?.content, ok), ms, label: `${item.server}.${item.tool}` };
    }
    case "dynamicToolCall": {
      const ok = done && item.success !== false;
      return { tool: item.tool, args: item.arguments, ok, summary: stepSummary(item.arguments, item.contentItems, ok), ms, label: item.tool };
    }
    case "webSearch":
      return { tool: "web_search", args: { query: item.query }, ok: true, summary: stepHint({ query: item.query }), ms, label: `web_search · ${stepHint({ query: item.query }, 60)}` };
    default:
      return null;
  }
}

/** Codex says each failed attempt as an `error` it will retry, e.g. "Reconnecting... 2/5 (stream disconnected …)". */
export function codexRetry(params: Json): RetryState | null {
  if (!params?.willRetry) return null;
  const text = String(params.error?.message ?? "request failed");
  const count = /(\d+)\s*\/\s*(\d+)/.exec(text);
  const cause = /\(([^)]+)\)\s*$/.exec(text);
  return { attempt: count ? Number(count[1]) : 1, ...(count ? { max: Number(count[2]) } : {}), reason: cause ? cause[1] : text };
}
