import { describe, expect, it } from "vitest";
import { Contributions } from "@tomradex/contributions";
import { fresh, settle } from "@tomradex/testkit";
import { Inbox, entryId, type InboxEntry, type InboxEntryInput, type InboxSource, type TriageChange, type TriageSuggestion } from "@tomradex/inbox";

const DAY = 86_400_000;

async function boot(source: Partial<InboxSource> = {}) {
  const f = await fresh({ plugins: [Contributions, [Inbox, { pullMs: 3_600_000 }]] });
  const feed: InboxEntryInput[] = [];
  const asked: (number | null)[] = [];
  const told: { externalId: string; change: TriageChange }[] = [];
  const replies: string[] = [];
  let failTelling = false;
  f.ctx.inbox.source({
    id: "app",
    title: "In-app",
    pull: async ({ since }) => {
      asked.push(since);
      return feed.filter((e) => since === null || e.receivedAt >= since);
    },
    setStatus: async (entry, change) => {
      if (failTelling) throw new Error("offline");
      told.push({ externalId: entry.externalId, change });
    },
    reply: async (_entry, text) => void replies.push(text),
    ...source
  });
  await settle();
  const inbox = f.ctx.inbox;
  const p = f.project.id;
  return { ...f, inbox, p, feed, asked, told, replies, failing: (on: boolean) => (failTelling = on) };
}

const report = (externalId: string, at: number, extra: Partial<InboxEntryInput> = {}): InboxEntryInput => ({ externalId, title: `Report ${externalId}`, body: "It broke.", kind: "bug", reporter: externalId, receivedAt: at, ...extra });

describe("pulling", () => {
  it("pulls only from the sources a project switched on, once per entry, from where it left off", async () => {
    const t = await boot();
    t.feed.push(report("R-AAAAAA", 1 * DAY), report("R-BBBBBB", 2 * DAY));
    expect(await t.inbox.refresh(t.p)).toBe(0);
    expect(t.asked).toEqual([]);

    await t.inbox.setSource(t.p, "app", true);
    expect(t.inbox.list(t.p).map((e) => e.externalId)).toEqual(["R-BBBBBB", "R-AAAAAA"]);
    expect(t.inbox.count(t.p)).toBe(2);

    t.feed.push(report("R-CCCCCC", 3 * DAY));
    expect(await t.inbox.refresh(t.p)).toBe(1);
    expect(t.asked).toEqual([null, 2 * DAY]);
    // the same report pulled again is the same entry
    expect(await t.inbox.refresh(t.p)).toBe(0);
    expect(t.inbox.list(t.p, "all")).toHaveLength(3);
    expect(t.inbox.get(t.p, entryId("app", "R-CCCCCC"))?.title).toBe("Report R-CCCCCC");
  });

  it("says why a source can't pull, and pulls once it can", async () => {
    let ready = false;
    const t = await boot({ available: () => (ready ? null : "Sign in first") });
    t.feed.push(report("R-AAAAAA", 1 * DAY));
    await t.inbox.setSource(t.p, "app", true);
    expect((await t.inbox.sources(t.p))[0]).toMatchObject({ enabled: true, unavailable: "Sign in first", error: "Sign in first" });
    expect(t.asked).toEqual([]);
    ready = true;
    expect(await t.inbox.refresh(t.p)).toBe(1);
    expect((await t.inbox.sources(t.p))[0]).toMatchObject({ unavailable: null, error: null });
  });

  it("starts the next pull where the source says, when it says", async () => {
    const seen: (number | null)[] = [];
    const t = await boot({ pull: async ({ since }) => (seen.push(since), { entries: [], cursor: 9 * DAY }) });
    await t.inbox.setSource(t.p, "app", true);
    await t.inbox.refresh(t.p);
    expect(seen).toEqual([null, 9 * DAY]);
  });
});

describe("triage", () => {
  it("accepts an entry as a ticket that says where it came from, with Source and Kind fields and a view of such tickets", async () => {
    const t = await boot();
    t.feed.push(report("R-AAAAAA", Date.UTC(2026, 9, 14), { url: "https://example.com/r/1" }));
    await t.inbox.setSource(t.p, "app", true);
    const [entry] = t.inbox.list(t.p);

    const { entry: done, item } = await t.inbox.accept(t.p, entry!.id, { title: "Login times out" });
    expect(done).toMatchObject({ status: "accepted", itemId: item.id });
    expect(item.title).toBe("Login times out");
    expect(item.body).toContain("> From In-app, 2026-10-14 · [R-AAAAAA](https://example.com/r/1)");
    expect(item.body).toContain("It broke.");

    const fields = t.fields.custom(t.p);
    const source = fields.find((f) => f.name === "Source")!;
    const kind = fields.find((f) => f.name === "Kind")!;
    expect(source.options?.map((o) => o.name)).toEqual(["In-app"]);
    expect(kind.options?.map((o) => o.name)).toEqual(["Bug"]);
    expect(t.items.get(t.p, item.id)!.fields).toMatchObject({ [source.id]: source.options![0]!.id, [kind.id]: kind.options![0]!.id });

    const view = t.views.listForProject(t.p).find((v) => v.name === "From feedback")!;
    expect(view.layout).toBe("table");
    expect(view.query.filter).toEqual([{ field: source.id, op: "not-in", values: [null] }]);
    expect(t.items.query({ projectId: t.p, filter: view.query.filter }).map((i) => i.id)).toEqual([item.id]);

    await t.inbox.flush(t.p);
    expect(t.told).toEqual([{ externalId: "R-AAAAAA", change: { state: "accepted", ticket: { key: item.key, title: "Login times out" } } }]);
    expect(t.inbox.count(t.p)).toBe(0);

    // a deleted view is not made again; the fields are reused, not doubled
    t.views.remove(t.p, view.id);
    t.feed.push(report("R-BBBBBB", Date.UTC(2026, 9, 15), { kind: "idea" }));
    await t.inbox.refresh(t.p);
    await t.inbox.accept(t.p, entryId("app", "R-BBBBBB"));
    expect(t.views.listForProject(t.p).some((v) => v.name === "From feedback")).toBe(false);
    expect(t.fields.custom(t.p).filter((f) => f.name === "Kind")).toHaveLength(1);
    expect(t.fields.get(t.p, kind.id)!.options?.map((o) => o.name)).toEqual(["Bug", "Idea"]);
  });

  it("counts every report merged into a ticket, on the ticket and in its Feedback field", async () => {
    const t = await boot();
    t.feed.push(report("R-AAAAAA", 1 * DAY), report("R-BBBBBB", 2 * DAY), report("R-CCCCCC", 3 * DAY));
    await t.inbox.setSource(t.p, "app", true);
    const { item } = await t.inbox.accept(t.p, entryId("app", "R-AAAAAA"));
    await t.inbox.merge(t.p, entryId("app", "R-BBBBBB"), item.key);

    const sections = await t.ctx.contributions.sectionsFor(t.p, item.id);
    expect(sections.find((s) => s.id === "inbox")).toMatchObject({ title: "Feedback", text: "Came in 2 times.", rows: [{ label: "In-app" }, { label: "In-app" }] });
    expect(t.fields.derivedValues(t.p).get(item.id)).toEqual({ feedback: 2 });
    expect(t.items.query({ projectId: t.p, filter: [{ field: "feedback", op: "gte", values: [2] }] }).map((i) => i.id)).toEqual([item.id]);

    // merged into a ticket made by hand, it still gains Source and Kind
    const plain = t.items.create({ projectId: t.p, boardId: t.board.id, title: "Known already", by: "human" });
    await t.inbox.merge(t.p, entryId("app", "R-CCCCCC"), plain.id);
    expect(Object.keys(t.items.get(t.p, plain.id)!.fields)).toHaveLength(2);
    await t.inbox.flush(t.p);
    expect(t.told.map((x) => x.change.state)).toEqual(["accepted", "merged", "merged"]);
  });

  it("closes, reopens and replies, and keeps telling a source that was unreachable until it hears", async () => {
    const t = await boot();
    t.feed.push(report("R-AAAAAA", 1 * DAY));
    await t.inbox.setSource(t.p, "app", true);
    const id = entryId("app", "R-AAAAAA");

    t.failing(true);
    await t.inbox.close(t.p, id, "wontfix");
    await t.inbox.flush(t.p);
    expect(t.told).toEqual([]);
    expect((await t.inbox.sources(t.p))[0]!.pending).toBe(1);
    await expect(t.inbox.accept(t.p, id)).rejects.toThrow(/reopen/);

    t.failing(false);
    await t.inbox.refresh(t.p);
    expect(t.told).toEqual([{ externalId: "R-AAAAAA", change: { state: "closed", reason: "wontfix" } }]);
    expect((await t.inbox.sources(t.p))[0]!.pending).toBe(0);

    expect((await t.inbox.reopen(t.p, id)).status).toBe("new");
    expect((await t.inbox.reply(t.p, id, "  Thanks, looking into it  ")).reply).toBe("Thanks, looking into it");
    expect(t.replies).toEqual(["Thanks, looking into it"]);
    await expect(t.inbox.reply(t.p, id, " ")).rejects.toThrow();
  });

  it("refuses a reply a source cannot carry", async () => {
    const t = await boot({ reply: undefined });
    t.feed.push(report("R-AAAAAA", 1 * DAY));
    await t.inbox.setSource(t.p, "app", true);
    await expect(t.inbox.reply(t.p, entryId("app", "R-AAAAAA"), "hi")).rejects.toThrow("In-app takes no replies");
  });

  it("shows a sidebar door to the inbox, with what waits", async () => {
    const t = await boot();
    t.feed.push(report("R-AAAAAA", 1 * DAY), report("R-BBBBBB", 2 * DAY));
    expect(await t.ctx.contributions.sidebarModules(t.p)).toEqual([{ id: "inbox", title: "Inbox", icon: "i-inbox", opens: "inbox" }]);
    await t.inbox.setSource(t.p, "app", true);
    expect((await t.ctx.contributions.sidebarModules(t.p))[0]).toMatchObject({ count: 2 });
  });
});

describe("after triage", () => {
  it("marks a triaged entry when something new happens at its source, until a person looks", async () => {
    let activity: { externalId: string; at: number }[] = [];
    const t = await boot();
    t.feed.push(report("R-AAAAAA", 1 * DAY), report("R-BBBBBB", 2 * DAY));
    await t.inbox.setSource(t.p, "app", true);
    t.ctx.inbox.source({ id: "loud", title: "Loud", pull: async () => ({ entries: [report("L-1", 1 * DAY)], cursor: null, activity }) });
    await t.inbox.setSource(t.p, "loud", true);
    const id = entryId("loud", "L-1");

    // untriaged: it waits anyway
    activity = [{ externalId: "L-1", at: Date.now() + 1 }];
    await t.inbox.refresh(t.p);
    expect(t.inbox.get(t.p, id)!.activityAt).toBeNull();

    await t.inbox.accept(t.p, id);
    // what happened before the triage is not new
    activity = [{ externalId: "L-1", at: 1 * DAY }];
    await t.inbox.refresh(t.p);
    expect(t.inbox.get(t.p, id)!.activityAt).toBeNull();
    expect(t.inbox.count(t.p)).toBe(2);

    const later = Date.now() + 60_000;
    activity = [{ externalId: "L-1", at: later }];
    await t.inbox.refresh(t.p);
    expect(t.inbox.get(t.p, id)).toMatchObject({ status: "accepted", activityAt: later });
    expect(t.inbox.list(t.p, "activity").map((e) => e.id)).toEqual([id]);
    expect(t.inbox.count(t.p)).toBe(3);

    // seen, the same activity does not light it again; it stays as triaged
    expect(t.inbox.seen(t.p, id)).toMatchObject({ status: "accepted", activityAt: null });
    await t.inbox.refresh(t.p);
    expect(t.inbox.get(t.p, id)!.activityAt).toBeNull();
    activity = [{ externalId: "L-1", at: later + 1 }];
    await t.inbox.refresh(t.p);
    expect(t.inbox.get(t.p, id)!.activityAt).toBe(later + 1);

    // reopened to triage again, it starts clean
    expect(await t.inbox.reopen(t.p, id)).toMatchObject({ status: "new", activityAt: null });
  });

  it("tells the source once when a ticket ships, and names the main entry of a duplicate", async () => {
    const t = await boot();
    t.feed.push(report("R-AAAAAA", 1 * DAY, { url: "https://example.com/a" }), report("R-BBBBBB", 2 * DAY), report("R-CCCCCC", 3 * DAY));
    await t.inbox.setSource(t.p, "app", true);
    const a = entryId("app", "R-AAAAAA");
    const { item } = await t.inbox.accept(t.p, a);
    await t.inbox.close(t.p, entryId("app", "R-BBBBBB"), "duplicate", a);
    await expect(t.inbox.close(t.p, entryId("app", "R-CCCCCC"), "duplicate", "nope")).rejects.toThrow();
    await t.inbox.flush(t.p);

    expect(t.inbox.ship(t.p, a, "v1.2.0")).toMatchObject({ shippedIn: "v1.2.0", status: "accepted" });
    expect(t.inbox.ship(t.p, a, "v1.3.0").shippedIn).toBe("v1.2.0");
    expect(t.inbox.ship(t.p, entryId("app", "R-BBBBBB"), "v1.2.0").shippedIn).toBeNull();
    await t.inbox.flush(t.p);
    expect(t.told.map((x) => x.change)).toEqual([
      { state: "accepted", ticket: { key: item.key, title: item.title } },
      { state: "closed", reason: "duplicate", duplicateOf: { externalId: "R-AAAAAA", url: "https://example.com/a" } },
      { state: "shipped", version: "v1.2.0", ticket: { key: item.key, title: item.title } }
    ]);
    expect(t.inbox.get(t.p, entryId("app", "R-BBBBBB"))!.duplicateOf).toBe(a);
  });

  it("keeps a source's switches per project, at the source's defaults until changed", async () => {
    const t = await boot({ options: [{ id: "close", title: "Close", default: false }, { id: "comment", title: () => "Comment", default: true }] });
    expect((await t.inbox.sources(t.p))[0]!.options).toEqual([
      { id: "close", title: "Close", description: null, value: false },
      { id: "comment", title: "Comment", description: null, value: true }
    ]);
    await t.inbox.setSourceOption(t.p, "app", "close", true);
    expect(t.inbox.option(t.p, "app", "close")).toBe(true);
    expect(t.inbox.option(t.p, "app", "comment")).toBe(true);
    await expect(t.inbox.setSourceOption(t.p, "app", "nope", true)).rejects.toThrow();
  });
});

describe("suggestions", () => {
  const triager = (answer: (entry: InboxEntry, others: InboxEntry[]) => TriageSuggestion, opts: { unavailable?: () => string | null } = {}) => {
    const asked: string[] = [];
    return {
      asked,
      def: {
        id: "test",
        title: "Test model",
        available: () => opts.unavailable?.() ?? null,
        suggest: async (entry: InboxEntry, scope: { entries: InboxEntry[] }) => (asked.push(entry.externalId), answer(entry, scope.entries))
      }
    };
  };
  const plain = (extra: Partial<TriageSuggestion> = {}): TriageSuggestion => ({ action: "accept", kind: "bug", priority: 3, title: "Login times out", itemId: null, duplicateOf: null, reason: "It is broken", reply: "Thanks — we track it.", ...extra });

  it("suggests on new arrivals by itself, and one click accepts as suggested and sends the draft reply", async () => {
    const t = await boot();
    const tr = triager(() => plain());
    t.inbox.triager(tr.def);
    t.feed.push(report("R-AAAAAA", 1 * DAY));
    await t.inbox.setSource(t.p, "app", true);
    await t.inbox.suggestionsIdle(t.p);
    const id = entryId("app", "R-AAAAAA");
    expect(t.inbox.get(t.p, id)!.suggestion).toMatchObject({ action: "accept", priority: 3, by: "Test model" });

    const { entry, item, replyError } = await t.inbox.adopt(t.p, id);
    expect(entry).toMatchObject({ status: "accepted", reply: "Thanks — we track it." });
    expect(item).toMatchObject({ title: "Login times out", priority: 3 });
    expect(replyError).toBeNull();
    expect(t.replies).toEqual(["Thanks — we track it."]);
    // pulling again asks nothing more
    await t.inbox.refresh(t.p);
    await t.inbox.suggestionsIdle(t.p);
    expect(tr.asked).toEqual(["R-AAAAAA"]);
  });

  it("merges into the ticket it repeats, or closes as a duplicate of the entry it repeats, and a reply can be changed or left out", async () => {
    const t = await boot();
    const known = t.items.create({ projectId: t.p, boardId: t.board.id, title: "Login is slow", by: "human" });
    t.inbox.triager(triager((entry, others) => (entry.externalId === "R-AAAAAA" ? plain({ action: "merge", itemId: known.key }) : plain({ action: "duplicate", duplicateOf: others[0]?.id ?? null }))).def);
    t.feed.push(report("R-AAAAAA", 1 * DAY), report("R-BBBBBB", 2 * DAY));
    await t.inbox.setSource(t.p, "app", true);
    await t.inbox.suggestionsIdle(t.p);
    const a = entryId("app", "R-AAAAAA");
    const b = entryId("app", "R-BBBBBB");
    expect(t.inbox.get(t.p, a)!.suggestion).toMatchObject({ action: "merge", itemId: known.id });

    expect((await t.inbox.adopt(t.p, b, { reply: false })).entry).toMatchObject({ status: "closed", closeReason: "duplicate", duplicateOf: a });
    const merged = await t.inbox.adopt(t.p, a, { reply: "Already on it" });
    expect(merged.entry).toMatchObject({ status: "merged", itemId: known.id });
    expect(t.replies).toEqual(["Already on it"]);
  });

  it("turns a suggestion naming nothing that exists into a plain accept", async () => {
    const t = await boot();
    t.inbox.triager(triager(() => plain({ action: "merge", itemId: "TOM-999" })).def);
    t.feed.push(report("R-AAAAAA", 1 * DAY));
    await t.inbox.setSource(t.p, "app", true);
    await t.inbox.suggestionsIdle(t.p);
    expect(t.inbox.get(t.p, entryId("app", "R-AAAAAA"))!.suggestion).toMatchObject({ action: "accept", itemId: null });
  });

  it("keeps a failed suggestion's reason on the entry without blocking triage, and waits while the triager can't answer", async () => {
    let down: string | null = "No model configured";
    let fail = true;
    const t = await boot();
    const tr = triager(
      () => {
        if (fail) throw new Error("model timed out");
        return plain();
      },
      { unavailable: () => down }
    );
    t.inbox.triager(tr.def);
    t.feed.push(report("R-AAAAAA", 1 * DAY));
    await t.inbox.setSource(t.p, "app", true);
    await t.inbox.suggestionsIdle(t.p);
    const id = entryId("app", "R-AAAAAA");
    expect(tr.asked).toEqual([]);
    expect(await t.inbox.triagerView()).toEqual({ title: "Test model", unavailable: "No model configured" });
    await expect(t.inbox.suggest(t.p, id)).rejects.toThrow("No model configured");

    down = null;
    await expect(t.inbox.suggest(t.p, id)).rejects.toThrow("model timed out");
    expect(t.inbox.get(t.p, id)).toMatchObject({ suggestion: null, suggestError: "model timed out" });
    await expect(t.inbox.adopt(t.p, id)).rejects.toThrow(/no suggestion/);

    fail = false;
    expect((await t.inbox.suggest(t.p, id)).suggestError).toBeNull();
    expect((await t.inbox.accept(t.p, id)).entry.status).toBe("accepted");
    await expect(t.inbox.suggest(t.p, id)).rejects.toThrow(/reopen/);
  });

  it("keeps the triage when the reply fails, and says so", async () => {
    const t = await boot({ reply: async () => Promise.reject(new Error("offline")) });
    t.inbox.triager(triager(() => plain()).def);
    t.feed.push(report("R-AAAAAA", 1 * DAY));
    await t.inbox.setSource(t.p, "app", true);
    await t.inbox.suggestionsIdle(t.p);
    const out = await t.inbox.adopt(t.p, entryId("app", "R-AAAAAA"));
    expect(out.entry.status).toBe("accepted");
    expect(out.replyError).toBe("offline");
  });
});
