import { resultLine, stepHint, stepSummary, type RetryState } from "@tomradex/agent";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** A tool step Codex ran itself, as the panel shows it; null for items that are not steps or that Tomrade traces itself. */
export function codexStep(item: Json): { tool: string; args: unknown; ok: boolean; summary: string; ms: number; label: string } | null {
  const done = item.status === "completed";
  const ms = typeof item.durationMs === "number" ? item.durationMs : 0;
  switch (item.type) {
    case "commandExecution": {
      const args = { command: item.command, cwd: item.cwd };
      const ok = done && (item.exitCode ?? 0) === 0;
      const hint = stepHint(args);
      const why = item.status === "declined" ? "declined" : item.exitCode != null && item.exitCode !== 0 ? `exit ${item.exitCode}` : resultLine(item.aggregatedOutput);
      return { tool: "shell", args, ok, summary: ok ? hint : [hint, why].filter(Boolean).join(" — "), ms, label: `shell · ${stepHint(args, 60)}` };
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
