import type { Context } from "cordis";
import type {} from "@tomradex/contributions";
import type {} from "@tomradex/doctor";
import type { InboxEntry, InboxEntryInput, InboxKind, InboxSource, TriageChange } from "@tomradex/inbox";
import type {} from "@tomradex/settings";
import { FEEDBACK_WORDS } from "./words.js";

export const name = "inbox-tomrade";
export const inject = ["inbox"];

/** The signed-in account's client, as `@tomradex/hub-cloud` provides it; read structurally so this needs no Supabase. */
export interface Backend {
  client: { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> };
  info(): { user: { id: string } | null };
}

/** One report as the maintainer's pull returns it. */
export interface PulledReport {
  code: string;
  kind: string;
  summary: string;
  engine: string | null;
  app_version: string;
  platform: string;
  report: { sections?: { id?: string; title: string; text: string }[] } | null;
  status: string;
  ticket: string | null;
  created_at: string;
}

const KINDS: readonly string[] = ["bug", "feedback", "idea"];
const MAINTAINER_TTL_MS = 10 * 60_000;

/** A report as an inbox entry: the code stands for whoever sent it. */
export function toEntry(r: PulledReport, words = FEEDBACK_WORDS("en")): InboxEntryInput {
  const sections = r.report?.sections ?? [];
  const note = sections.find((s) => s.id === "note");
  const rest = sections.filter((s) => s !== note);
  const body = [
    note?.text ?? "",
    words("from", { version: r.app_version, platform: r.platform }) + (r.engine ? ` · ${r.engine}` : ""),
    ...rest.map((s) => `#### ${s.title}\n\n\`\`\`\n${s.text}\n\`\`\``)
  ].filter(Boolean).join("\n\n");
  return {
    externalId: r.code,
    kind: (KINDS.includes(r.kind) ? r.kind : "bug") as InboxKind,
    reporter: r.code,
    title: r.summary || r.code,
    body,
    receivedAt: Date.parse(r.created_at)
  };
}

/** What the sender then reads under My reports. */
export function answerFor(change: TriageChange): Record<string, string> {
  switch (change.state) {
    case "accepted":
    case "merged":
    case "shipped":
      return { p_status: "triaged", p_ticket: change.ticket.key };
    case "closed":
      return { p_status: change.reason };
    case "reopened":
      return { p_status: "new" };
  }
}

export function apply(ctx: Context) {
  const words = () => FEEDBACK_WORDS((ctx.get("settings") as { locale?: () => string } | undefined)?.locale?.());
  const backend = () => ctx.get("cloudHub") as Backend | undefined;
  let maintainer: { user: string; is: boolean; at: number } | null = null;

  const call = async (fn: string, args: Record<string, unknown>) => {
    const hub = backend();
    if (!hub?.info().user) throw new Error(words()("signIn"));
    const { data, error } = await hub.client.rpc(fn, args);
    if (error) throw new Error(error.message);
    return data;
  };

  const source: InboxSource = {
    id: "tomrade",
    title: () => words()("source"),
    keyPattern: "R-[0-9A-Z]{6}",
    async available() {
      const user = backend()?.info().user;
      if (!user) return words()("signIn");
      if (maintainer?.user !== user.id || Date.now() - maintainer.at > MAINTAINER_TTL_MS) {
        maintainer = { user: user.id, is: (await call("tomrade_is_maintainer", {})) === true, at: Date.now() };
      }
      return maintainer.is ? null : words()("notMaintainer");
    },
    async pull({ since }) {
      const rows = ((await call("tomrade_feedback_pull", { p_since: since === null ? null : new Date(since).toISOString(), p_limit: 500 })) ?? []) as PulledReport[];
      const last = rows.at(-1);
      return {
        // triaged elsewhere (the admin tool) before this inbox existed: already a ticket or answered
        entries: rows.filter((r) => r.status === "new").map((r) => toEntry(r, words())),
        cursor: last ? Date.parse(last.created_at) : since
      };
    },
    async reply(entry: InboxEntry, text: string) {
      await call("tomrade_feedback_answer", { p_code: entry.externalId, p_reply: text });
    },
    async setStatus(entry: InboxEntry, change: TriageChange) {
      await call("tomrade_feedback_answer", { p_code: entry.externalId, ...answerFor(change) });
    }
  };
  ctx.inbox.source(source);

  // Writing in goes through the troubleshooter's outbox: the same retry, the same replies under My reports.
  ctx.inject(["doctor", "contributions"], (ctx) => {
    ctx.contributions.command({ id: "inbox-tomrade.feedback", title: () => words()("command"), group: () => words()("group"), run: () => ({ opens: "feedback" }) });
    ctx.contributions.statusItem({ id: "feedback", text: () => words()("status"), title: () => words()("statusTitle"), opens: "feedback", icon: "i-send", align: "end" });
  });
}
