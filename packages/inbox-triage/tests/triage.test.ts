import { describe, expect, it } from "vitest";
import type { Item } from "@tomradex/domain";
import type { InboxEntry } from "@tomradex/inbox";
import { FakeLlm } from "@tomradex/llm";
import { candidates, suggest } from "@tomradex/inbox-triage";

const entry = (id: string, title: string, body = ""): InboxEntry => ({
  id,
  projectId: "p",
  source: "app",
  externalId: id.toUpperCase(),
  url: null,
  kind: "feedback",
  reporter: null,
  title,
  body,
  attachments: [],
  receivedAt: 0,
  status: "new",
  itemId: null,
  closeReason: null,
  reply: null,
  repliedAt: null,
  triagedAt: null,
  activityAt: null,
  shippedIn: null,
  duplicateOf: null,
  suggestion: null,
  suggestError: null
});

const item = (id: string, key: string, title: string, extra: Partial<Item> = {}) => ({ id, key, title, body: "", kind: "ticket", status: "todo", ...extra }) as Item;

describe("inbox triage", () => {
  const items = [item("i1", "TOM-1", "Login times out on slow networks"), item("i2", "TOM-2", "Dark mode for the board"), item("i3", "TOM-3", "Login timeout old", { status: "cancelled" })];

  it("shows the model only the tickets and entries near the feedback", () => {
    const near = candidates(entry("a", "Login times out"), items, [entry("a", "Login times out"), entry("b", "Login keeps timing out"), entry("c", "Export to CSV")]);
    expect(near.tickets.map((t) => t.key)).toEqual(["TOM-1"]);
    expect(near.entries.map((e) => e.id)).toEqual(["b"]);
  });

  it("maps the model's labels back to the ticket or entry it means", async () => {
    let prompt = "";
    const llm = new FakeLlm((_system, user) => ((prompt = user), { action: "merge", target: "T1", kind: "bug", priority: 3, title: "Login times out", reason: "Same as TOM-1", reply: "Thanks, we know." }));
    const out = await suggest(llm, entry("a", "Login times out"), { canReply: true, items, entries: [], locale: "en" });
    expect(prompt).toContain("T1 [TOM-1, todo] Login times out on slow networks");
    expect(out).toEqual({ action: "merge", kind: "bug", priority: 3, title: "Login times out", itemId: "i1", duplicateOf: null, reason: "Same as TOM-1", reply: "Thanks, we know." });

    const dup = new FakeLlm(() => ({ action: "duplicate", target: "E1", kind: "bug", priority: 2, title: "x", reason: "r", reply: "hi" }));
    expect(await suggest(dup, entry("a", "Login times out"), { canReply: false, items: [], entries: [entry("b", "Login times out again")], locale: "en" })).toMatchObject({ action: "duplicate", duplicateOf: "b", reply: null });
  });

  it("falls back to accept when the model names something it was not shown", async () => {
    const llm = new FakeLlm(() => ({ action: "merge", target: "T9", kind: "idea", priority: 1, title: "  ", reason: "r", reply: null }));
    expect(await suggest(llm, entry("a", "Dark mode please"), { canReply: true, items, entries: [], locale: "zh" })).toMatchObject({ action: "accept", itemId: null, title: "Dark mode please", reply: null });
  });
});
