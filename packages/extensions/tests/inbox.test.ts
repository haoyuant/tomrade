import { describe, expect, it } from "vitest";
import { Contributions } from "@tomradex/contributions";
import { Inbox } from "@tomradex/inbox";
import { definePlugin, type InboxEntry, type InboxEntryInput, type InboxTriageChange } from "@tomradex/plugin-sdk";
import { fresh, sdk, settle } from "@tomradex/testkit";

const ext = (plugin: Parameters<typeof sdk>[0]) => sdk(plugin, { id: "someone/demo", namespace: "demo", origin: "extension", root: null, dataDir: null });

const comment = (externalId: string, at: number): InboxEntryInput => ({ externalId, title: `Comment ${externalId}`, body: "Love it, but it crashes.", kind: "bug", reporter: "@fan", url: `https://example.com/${externalId}`, receivedAt: at });

describe("an extension's inbox source", () => {
  it("shows in the Sources pane, pulls into a project that switched it on once per externalId, hears triage, and goes when the plugin unloads while its entries stay", async () => {
    const w = await fresh({ plugins: [Contributions, [Inbox, { pullMs: 3_600_000 }]] });
    const feed: InboxEntryInput[] = [];
    const scopes: unknown[] = [];
    const replies: { entry: InboxEntry; text: string }[] = [];
    const told: InboxTriageChange[] = [];
    const fiber = w.ctx.plugin(
      ext(
        definePlugin({
          inject: ["inbox"],
          async apply(p) {
            await expect(p.inbox.source({ id: "other", title: "x", pull: () => [] })).rejects.toThrow(/must be named "demo"/);
            await p.inbox.source({
              id: "demo",
              title: { en: "Social comments", zh: "社交评论" },
              keyPattern: "C-\\d+",
              available: async (projectId) => (projectId ? null : "no project"),
              pull: async (scope) => {
                scopes.push(scope);
                return { entries: feed.filter((e) => scope.since === null || e.receivedAt > scope.since), cursor: feed.at(-1)?.receivedAt ?? null, state: { page: 2 } };
              },
              reply: (entry, text) => void replies.push({ entry, text }),
              setStatus: (_entry, change) => void told.push(change),
              options: [{ id: "close", title: "Close at the source", default: false }]
            });
          }
        })
      )
    );
    await fiber;
    await settle();
    const p = w.project.id;

    const [view] = await w.ctx.inbox.sources(p);
    expect(view).toMatchObject({ id: "demo", title: "Social comments", enabled: false, unavailable: null, canReply: true, keyPattern: "C-\\d+", options: [{ id: "close", title: "Close at the source", description: null, value: false }] });

    feed.push(comment("C-1", 1_000), comment("C-2", 2_000));
    await w.ctx.inbox.setSource(p, "demo", true);
    expect(w.ctx.inbox.list(p).map((e) => e.externalId)).toEqual(["C-2", "C-1"]);
    expect(w.ctx.inbox.list(p)[0]).toMatchObject({ source: "demo", kind: "bug", reporter: "@fan", url: "https://example.com/C-2" });

    // the same comments pulled again, from the start, are the same entries
    expect(await w.ctx.inbox.refresh(p)).toBe(0);
    w.db.prepare("UPDATE plugin_inbox_pulls SET cursor = NULL").run();
    expect(await w.ctx.inbox.refresh(p)).toBe(0);
    expect(w.ctx.inbox.list(p, "all")).toHaveLength(2);
    expect(scopes[1]).toEqual({ projectId: p, since: 2_000, state: { page: 2 } });

    const entry = w.ctx.inbox.list(p).find((e) => e.externalId === "C-1")!;
    await w.ctx.inbox.reply(p, entry.id, "Fixed in the next build");
    expect(replies).toMatchObject([{ entry: { externalId: "C-1" }, text: "Fixed in the next build" }]);
    const { item } = await w.ctx.inbox.accept(p, entry.id);
    await w.ctx.inbox.refresh(p);
    expect(told).toEqual([{ state: "accepted", ticket: { key: item.key, title: item.title } }]);

    await fiber.dispose();
    await settle();
    expect(await w.ctx.inbox.sources(p)).toEqual([]);
    expect(w.ctx.inbox.list(p, "all").map((e) => e.externalId).sort()).toEqual(["C-1", "C-2"]);
  });

  it("refuses a plugin that did not name inbox, and says so", async () => {
    const w = await fresh({ plugins: [Contributions, [Inbox, { pullMs: 3_600_000 }]] });
    let refused: unknown = null;
    await w.ctx.plugin(ext(definePlugin({ inject: ["items"], apply: (p) => p.inbox.source({ id: "demo", title: "Demo", pull: () => [] }).catch((error: unknown) => void (refused = error)) })));
    await settle();
    expect(String(refused)).toMatch(/someone\/demo did not name "inbox" in inject or optional/);
    expect(await w.ctx.inbox.sources(w.project.id)).toEqual([]);
  });

  it("records a pull that is not inbox entries as the source's error, adding nothing", async () => {
    const w = await fresh({ plugins: [Contributions, [Inbox, { pullMs: 3_600_000 }]] });
    await w.ctx.plugin(ext(definePlugin({ inject: ["inbox"], apply: (p) => void p.inbox.source({ id: "demo", title: "Demo", pull: () => [{ title: "no id", receivedAt: 1 }] as never }) })));
    await settle();
    const [view] = await w.ctx.inbox.setSource(w.project.id, "demo", true);
    expect(view?.error).toMatch(/demo pulled something that is not inbox entries/);
    expect(w.ctx.inbox.list(w.project.id, "all")).toEqual([]);
  });
});
