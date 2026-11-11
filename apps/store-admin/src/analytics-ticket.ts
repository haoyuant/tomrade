import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Filters } from "./analytics-data.js";
import type { InsightsEntry } from "./analytics-insights.js";
import { translator } from "./analytics-messages.js";

export class TomradeUnavailable extends Error {}
/** Files the ticket and opens it in the desktop app; throws TomradeUnavailable when the command is not installed. */
export type Sender = (title: string, body: string) => Promise<{ key: string }>;
export type Exec = (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }) => Promise<{ stdout: string }>;

const BODY_LIMIT = 60_000;
/** Written in English whatever the page's language: it is a prompt for the agent that picks the ticket up. */
const BRIEF = "Verify each anomaly and high-priority suggestion against the code (apps/store-admin, packages/analytics, supabase/migrations) and the data; fix what is a real defect, file a ticket for each separate piece of work, and say which items are noise or not actionable.";

const run: Exec = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, { ...options, maxBuffer: 4 << 20 }, (error, stdout) => (error ? reject(error) : resolve({ stdout })));
});

const fill = (text: string, slots: Record<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => slots[k] ?? "");
const size = (text: string) => Buffer.byteLength(text);

export function ticketTitle(entry: InsightsEntry, lang: Filters["lang"]): string {
  const t = translator(lang);
  return fill(t("ticketTitle"), { from: entry.from, to: entry.to, region: t(entry.region) });
}

/** The daily series are the bulk of the aggregates; the totals and rankings are what the analysis rests on, so they go last. */
function trimmed(input: unknown): unknown {
  const copy = structuredClone(input) as { current?: Record<string, { daily?: unknown } | unknown> };
  const current = copy.current;
  if (current) {
    delete current.daily;
    delete current.next_day_retention;
    for (const part of ["site", "search", "github"]) {
      const value = current[part];
      if (value && typeof value === "object") delete (value as { daily?: unknown }).daily;
    }
  }
  return copy;
}

export function ticketBody(entry: InsightsEntry, lang: Filters["lang"]): string {
  const t = translator(lang);
  const { insights } = entry;
  const basis = fill(t("insightsBasis"), { from: entry.from, to: entry.to, region: t(entry.region), at: entry.generated_at });
  const lines = [
    `${basis}${entry.cost_usd !== null ? ` · ${fill(t("insightsCost"), { cost: entry.cost_usd.toFixed(3) })}` : ""}`,
    "", `## ${t("summary")}`, "", insights.summary,
    "", `## ${t("highlights")}`, "", ...insights.highlights.map((h) => `- **${h.title}** (${h.tone}): ${h.detail}`),
    "", `## ${t("anomalies")}`, "", ...(insights.anomalies.length ? insights.anomalies.map((a) => `- **${a.title}**: ${a.detail}`) : [t("noAnomalies")]),
    "", `## ${t("suggestions")}`, "", ...insights.suggestions.map((s) => `- **${s.title}** (${t(s.priority)}): ${s.detail}`),
    "", "## Brief", "", BRIEF
  ];
  const head = lines.join("\n");
  // An entry stored before the input was kept still sends, without a data section.
  if (entry.input === undefined) return head;
  const block = (data: unknown) => `\n\n## Data the analyst read\n\n\`\`\`json\n${JSON.stringify(data, null, 1)}\n\`\`\`\n`;
  for (const data of [entry.input, trimmed(entry.input)]) {
    const body = head + block(data);
    if (size(body) <= BODY_LIMIT) return body;
  }
  return `${head}\n\n## Data the analyst read\n\nToo large to attach; generate the analysis again from the dashboard to see it.\n`;
}

/** The tomrade command in the repository root, so the ticket lands in this repository's project, then the app's link for it. */
export function tomradeSender(deps: { exec?: Exec; command?: string; cwd?: string; platform?: NodeJS.Platform } = {}): Sender {
  const exec = deps.exec ?? run;
  const command = deps.command ?? process.env.TOMRADE_ANALYTICS_TOMRADE ?? "tomrade";
  const cwd = deps.cwd ?? fileURLToPath(new URL("../../../", import.meta.url));
  const platform = deps.platform ?? process.platform;
  return async (title, body) => {
    // The dashboard's keys stay with the dashboard, and an agent run's token would make the ticket that run's.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SUPABASE_") && k !== "TOMRADE_MCP_TOKEN"));
    const options = { cwd, env, timeout: 30_000 };
    let item: { key?: unknown; projectId?: unknown };
    try {
      item = JSON.parse((await exec(command, ["create", title, "--body", body, "--json"], options)).stdout) as typeof item;
    } catch (error) {
      throw (error as NodeJS.ErrnoException).code === "ENOENT" ? new TomradeUnavailable(command) : error;
    }
    if (typeof item.key !== "string" || typeof item.projectId !== "string") throw new Error("tomrade answered without a ticket");
    const link = `tomrade://item/${encodeURIComponent(item.projectId)}/${encodeURIComponent(item.key)}`;
    const [file, args] = platform === "darwin" ? ["open", [link]] : platform === "win32" ? ["cmd", ["/c", "start", "", link]] : ["xdg-open", [link]];
    // The ticket exists either way; failing to show it is not worth an error.
    await exec(file!, args as string[], options).catch(() => undefined);
    return { key: item.key };
  };
}
