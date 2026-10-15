import { expect, it } from "vitest";
import type { Context } from "cordis";
import { Contributions } from "@tomradex/contributions";
import { Inbox, entryId } from "@tomradex/inbox";
import * as InboxTomrade from "@tomradex/inbox-tomrade";
import { answerFor, toEntry, type PulledReport } from "@tomradex/inbox-tomrade";
import { fresh, settle } from "@tomradex/testkit";

const pulled = (code: string, extra: Partial<PulledReport> = {}): PulledReport => ({
  code,
  kind: "feedback",
  summary: "Dark mode please",
  engine: null,
  app_version: "0.10.0",
  platform: "macOS 26.5 arm64",
  report: { sections: [{ id: "note", title: "Note", text: "Dark mode please, the board is bright." }] },
  status: "new",
  ticket: null,
  created_at: "2026-10-14T08:00:00.000Z",
  ...extra
});

it("reads a report as an entry, the code standing for whoever sent it", () => {
  const bug = toEntry(pulled("R-AAAAAA", { kind: "bug", engine: "codex", report: { sections: [{ id: "error", title: "Error", text: "spawn ENOENT" }] } }));
  expect(bug).toMatchObject({ externalId: "R-AAAAAA", kind: "bug", reporter: "R-AAAAAA", title: "Dark mode please", receivedAt: Date.parse("2026-10-14T08:00:00.000Z") });
  expect(bug.body).toBe("Tomrade 0.10.0 · macOS 26.5 arm64 · codex\n\n#### Error\n\n```\nspawn ENOENT\n```");
  expect(toEntry(pulled("R-BBBBBB")).body).toBe("Dark mode please, the board is bright.\n\nTomrade 0.10.0 · macOS 26.5 arm64");
  expect(toEntry(pulled("R-CCCCCC", { kind: "rant", summary: "" }))).toMatchObject({ kind: "bug", title: "R-CCCCCC" });
});

it("tells the sender what became of it", () => {
  expect(answerFor({ state: "accepted", ticket: { key: "TOM-9", title: "x" } })).toEqual({ p_status: "triaged", p_ticket: "TOM-9" });
  expect(answerFor({ state: "closed", reason: "duplicate" })).toEqual({ p_status: "duplicate" });
  expect(answerFor({ state: "reopened" })).toEqual({ p_status: "new" });
});

it("pulls for a maintainer only, skips what was triaged elsewhere, and answers through the account", async () => {
  const calls: [string, Record<string, unknown>][] = [];
  let maintainer = false;
  let user: { id: string } | null = null;
  const rows = [pulled("R-AAAAAA"), pulled("R-BBBBBB", { status: "triaged", ticket: "TOM-3", created_at: "2026-10-15T08:00:00.000Z" })];
  const hub = {
    name: "fake-cloud-hub",
    apply(ctx: Context) {
      ctx.provide("cloudHub", {
        info: () => ({ user }),
        client: {
          rpc: async (fn: string, args: Record<string, unknown>) => {
            calls.push([fn, args]);
            if (fn === "tomrade_is_maintainer") return { data: maintainer, error: null };
            if (fn === "tomrade_feedback_pull") return { data: rows, error: null };
            return { data: null, error: null };
          }
        }
      } as never);
    }
  };
  const f = await fresh({ plugins: [hub, Contributions, [Inbox, { pullMs: 3_600_000 }], InboxTomrade] });
  await settle();
  const p = f.project.id;
  const inbox = f.ctx.inbox;
  await inbox.setSource(p, "tomrade", true);
  expect((await inbox.sources(p))[0]).toMatchObject({ id: "tomrade", title: "Tomrade feedback", unavailable: "Sign in to your Tomrade account first", keyPattern: "R-[0-9A-Z]{6}", canReply: true });

  user = { id: "someone" };
  await inbox.refresh(p);
  expect((await inbox.sources(p))[0]!.unavailable).toBe("Only Tomrade's maintainers receive this feedback");
  expect(inbox.list(p, "all")).toEqual([]);

  // another account on the same machine is asked afresh
  user = { id: "maintainer" };
  maintainer = true;
  expect(await inbox.refresh(p)).toBe(1);
  expect(inbox.list(p).map((e) => e.externalId)).toEqual(["R-AAAAAA"]);
  expect(calls.filter(([fn]) => fn === "tomrade_feedback_pull").map(([, a]) => a)).toEqual([{ p_since: null, p_limit: 500 }]);
  await inbox.refresh(p);
  // the next pull starts at the last report read, triaged or not
  expect(calls.filter(([fn]) => fn === "tomrade_feedback_pull").at(-1)![1]).toEqual({ p_since: "2026-10-15T08:00:00.000Z", p_limit: 500 });

  const { item } = await inbox.accept(p, entryId("tomrade", "R-AAAAAA"));
  await inbox.reply(p, entryId("tomrade", "R-AAAAAA"), "Thanks!");
  await inbox.flush(p);
  expect(calls.filter(([fn]) => fn === "tomrade_feedback_answer").map(([, a]) => a)).toEqual([
    { p_code: "R-AAAAAA", p_status: "triaged", p_ticket: item.key },
    { p_code: "R-AAAAAA", p_reply: "Thanks!" }
  ]);
});

it("offers a way to write in wherever the troubleshooter is", async () => {
  const doctor = { name: "fake-doctor", apply: (ctx: Context) => ctx.provide("doctor", {} as never) };
  const f = await fresh({ plugins: [doctor, Contributions, [Inbox, { pullMs: 3_600_000 }], InboxTomrade] });
  await settle();
  expect(f.ctx.contributions.commands().find((c) => c.id === "inbox-tomrade.feedback")).toMatchObject({ title: "Send feedback…" });
  expect(await f.ctx.contributions.run("inbox-tomrade.feedback", {})).toEqual({ opens: "feedback" });
  expect((await f.ctx.contributions.statusItems({})).find((s) => s.id === "feedback")).toMatchObject({ text: "Feedback", opens: "feedback", align: "end" });
});
