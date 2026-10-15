/** Backlog tools, run through the tool registry like an agent would call them. */
import { describe, expect, it } from "vitest";
import { NotFoundError } from "@tomradex/domain";
import { ToolInputError, Tools } from "@tomradex/tools";
import { fresh } from "@tomradex/testkit";
import { RECOMMEND_WITHIN_MS } from "@tomradex/items";

async function withTools() {
  const f = await fresh();
  await f.ctx.plugin(Tools);
  await new Promise((r) => setTimeout(r, 0));
  const run = (name: string, args: unknown) => f.ctx.tools.execute(name, args, { by: "ai:test", projectId: f.project.id });
  return { ...f, run };
}

describe("get_item tool", () => {
  it("lists the files a body links, as Files describes them, and stays quiet when nothing can", async () => {
    const { run, items, board, project, ctx } = await withTools();
    const shot = "0f1e2d3c-4b5a-4968-8776-655443322110";
    const gone = "11111111-2222-4333-8444-555555555555";
    const linked = items.create({ projectId: project.id, title: "Header", body: `![shot](tomrade-file://${shot}) [spec](tomrade-file://${gone}) ![again](tomrade-file://${shot})`, boardId: board.id, by: "human" });
    const plain = items.create({ projectId: project.id, title: "Plain", body: "no links", boardId: board.id, by: "human" });
    expect(await run("get_item", { id: linked.id })).not.toHaveProperty("attachments");

    const asked: string[][] = [];
    const describe = async (_projectId: string, ids: string[]) => {
      asked.push(ids);
      return ids.filter((id) => id === shot).map((fileId) => ({ fileId, path: "Web/attachments/TOM-1/shot.png", name: "shot.png", mime: "image/png", size: 3, localPath: "/tmp/shot.png" }));
    };
    const off = ctx.items.files({ getVersion: async () => null, describe });
    expect(await run("get_item", { id: linked.id })).toMatchObject({ id: linked.id, attachments: [{ fileId: shot, path: "Web/attachments/TOM-1/shot.png", localPath: "/tmp/shot.png" }] });
    expect(asked).toEqual([[shot, gone]]);
    // a brief names the ticket by key, and the key answers the same
    expect(await run("get_item", { id: linked.key })).toMatchObject({ id: linked.id, attachments: [{ fileId: shot }] });
    expect(await run("get_item", { id: plain.id })).not.toHaveProperty("attachments");
    off();

    ctx.items.files({ getVersion: async () => null, describe: async () => { throw new Error("store unavailable"); } });
    expect(await run("get_item", { id: linked.id })).toMatchObject({ id: linked.id });
    expect(await run("get_item", { id: linked.id })).not.toHaveProperty("attachments");
  });
});

describe("list_items tool", () => {
  it("a boardId naming no real workstream is refused rather than silently matching nothing", async () => {
    const { run, items, board, project } = await withTools();
    items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    await expect(run("list_items", { boardId: "no-such-board" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a real boardId still filters as before", async () => {
    const { run, items, boards, board, project } = await withTools();
    const other = boards.create({ projectId: project.id, name: "Other" });
    const a = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    items.create({ projectId: project.id, title: "B", boardId: other.id, by: "human" });
    expect(((await run("list_items", { boardId: board.id })) as { id: string }[]).map((i) => i.id)).toEqual([a.id]);
  });

  it("no boardId still lists every item in scope", async () => {
    const { run, items, board, project } = await withTools();
    items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    items.create({ projectId: project.id, title: "B", boardId: board.id, by: "human" });
    expect(((await run("list_items", {})) as unknown[]).length).toBe(2);
  });

  it("a limit caps list_items but never count_items, and survives the scalar filters", async () => {
    const { run, items, board, project } = await withTools();
    for (const title of ["Dark mode toggle", "Dark theme", "Light mode"]) items.create({ projectId: project.id, title, boardId: board.id, status: "todo", by: "human" });
    const titles = async (args: object) => ((await run("list_items", args)) as { title: string }[]).map((i) => i.title);
    expect(await titles({ search: "dark", limit: 1 })).toHaveLength(1);
    expect(await titles({ search: "dark", sort: [{ field: "title", dir: "asc" }], limit: 1 })).toEqual(["Dark mode toggle"]);
    // A scalar filter forces the cut after the JS filter, so it still yields a full page.
    expect(await titles({ status: "todo", sort: [{ field: "title", dir: "asc" }], limit: 2 })).toEqual(["Dark mode toggle", "Dark theme"]);
    expect(await run("count_items", { search: "dark" })).toMatchObject({ count: 2 });
    // A count is over every match, so it takes no limit — and says so rather than dropping it.
    await expect(run("count_items", { search: "dark", limit: 1 })).rejects.toThrow(/unknown parameter "limit"/);
  });

  it("a projectId naming no open project is refused rather than silently matching nothing", async () => {
    const { run } = await withTools();
    await expect(run("list_items", { projectId: "tomrade" })).rejects.toBeInstanceOf(ToolInputError);
    await expect(run("count_items", { projectId: "tomrade" })).rejects.toBeInstanceOf(ToolInputError);
  });

  it("list_items widens a search that matched nothing; count_items stays strict", async () => {
    const { run, items, board, project } = await withTools();
    items.create({ projectId: project.id, title: "Dark mode toggle", body: "Add a dark theme", boardId: board.id, by: "human" });
    items.create({ projectId: project.id, title: "Light mode", body: "Nothing dark here", boardId: board.id, by: "human" });
    expect(((await run("list_items", { search: "toggle nothing" })) as { title: string }[]).map((i) => i.title).sort()).toEqual(["Dark mode toggle", "Light mode"]);
    expect(((await run("list_items", { search: "toggle" })) as unknown[]).length).toBe(1);
    expect(await run("count_items", { search: "toggle nothing" })).toMatchObject({ count: 0 });
  });

  it("lists a page of 50 by default; a larger limit and count_items see everything", async () => {
    const { run, items, board, project } = await withTools();
    for (let i = 0; i < 60; i++) items.create({ projectId: project.id, title: `Ticket ${i}`, boardId: board.id, by: "human" });
    expect(((await run("list_items", {})) as unknown[]).length).toBe(50);
    expect(((await run("list_items", { limit: 100 })) as unknown[]).length).toBe(60);
    expect(await run("count_items", {})).toMatchObject({ count: 60 });
  });

  it("lists rows without the project, the number the key repeats, or a lock that is not set", async () => {
    const { run, items, board, project } = await withTools();
    const open = items.create({ projectId: project.id, title: "Open", boardId: board.id, by: "human" });
    const locked = items.create({ projectId: project.id, title: "Locked", boardId: board.id, by: "human" });
    items.update(project.id, locked.id, { humanLocked: true } as Parameters<typeof items.update>[2], "human");
    const rows = new Map(((await run("list_items", {})) as Record<string, unknown>[]).map((row) => [row.id, row]));
    for (const row of rows.values()) for (const gone of ["projectId", "keyNum"]) expect(row).not.toHaveProperty(gone);
    expect(rows.get(open.id)).not.toHaveProperty("humanLocked");
    expect(rows.get(locked.id)).toMatchObject({ key: locked.key, humanLocked: true, rank: expect.any(Number), version: 2 });
    expect(await run("get_item", { id: open.id })).toMatchObject({ projectId: project.id, keyNum: open.keyNum, humanLocked: false });
  });

  it("counts tickets exactly and returns compact breakdowns without listing rows", async () => {
    const { run, items, boards, board, project } = await withTools();
    const cloud = boards.create({ projectId: project.id, name: "Cloud" });
    items.create({ projectId: project.id, title: "Backlog ticket", boardId: board.id, kind: "ticket", status: "backlog", by: "human" });
    items.create({ projectId: project.id, title: "Done ticket", boardId: cloud.id, kind: "ticket", status: "done", by: "human" });
    items.create({ projectId: project.id, title: "Epic", boardId: board.id, kind: "epic", status: "backlog", by: "human" });

    expect(await run("count_items", { kind: "ticket" })).toEqual({
      count: 2,
      byKind: { ticket: 2, epic: 0 },
      byStatus: { backlog: 1, todo: 0, doing: 0, verifying: 0, done: 1, cancelled: 0 },
      byWorkstream: { Main: 1, Cloud: 1 }
    });
    expect(await run("count_items", {})).toMatchObject({ count: 3, byKind: { ticket: 2, epic: 1 } });
  });
});

describe("tool arguments", () => {
  it("refuses a parameter the tool does not take, naming the one it most likely meant", async () => {
    const { run, items, board, project } = await withTools();
    const item = items.create({ projectId: project.id, title: "A", boardId: board.id, by: "human" });
    await expect(run("list_items", { query: "dark" })).rejects.toThrow(/unknown parameter "query" \(did you mean "search"\?\) — accepted: .*search/);
    await expect(run("get_item", { itemId: item.id })).rejects.toThrow(/did you mean "id"/);
    // nested objects too: a patch key that does not exist used to vanish and the write "succeeded"
    await expect(run("update_item", { id: item.id, patch: { blockedBy: [] } })).rejects.toThrow(/patch: unknown parameter "blockedBy" \(did you mean "blocks"\?\)/);
    expect(items.get(project.id, item.id)?.version).toBe(1);
  });

  it("takes a key wherever it takes an id, and names a key that matches nothing", async () => {
    const { run, items, board, project } = await withTools();
    const ticket = items.create({ projectId: project.id, title: "Ship it", boardId: board.id, by: "human" });
    expect(await run("change_status", { id: ticket.key, status: "doing" })).toMatchObject({ id: ticket.id, status: "doing" });
    expect(await run("submit_delivery", { id: ticket.key.toLowerCase(), submission: { report: "Done" } })).toMatchObject({ id: ticket.id, status: "verifying" });
    await expect(run("submit_delivery", { id: "TOM-999", submission: { report: "Done" } })).rejects.toThrow("Item TOM-999 not found");
    // another project's prefix is not this item
    await expect(run("get_item", { id: `XYZ-${ticket.keyNum}` })).resolves.toBeNull();
  });
});

describe("review_delivery tool", () => {
  async function submitted() {
    const f = await withTools();
    const ticket = f.items.create({ projectId: f.project.id, title: "Ship it", boardId: f.board.id, status: "doing", workType: "coding", by: "human" });
    f.items.submitDelivery(f.project.id, ticket.id, { report: "Merged in #12" }, "ai:test");
    return { ...f, ticket };
  }
  const runHandle = (projectId: string, ledger: { tool: string; ok: boolean }[]) => ({
    id: "run-1", threadId: "thread-1", projectId, author: "ai:test" as const,
    ledger: { all: () => ledger as never[], find: (pred: (e: never) => boolean) => (ledger as never[]).find(pred) },
    waivers: new Set<string>(), scratch: new Map<string, unknown>()
  });

  it("an agent cannot finish a ticket over a delivery nobody accepted; a person still can", async () => {
    const { run, items, project, ticket } = await submitted();
    await expect(run("change_status", { id: ticket.key, status: "done" })).rejects.toThrow(/has not been accepted.*review_delivery/);
    expect(items.update(project.id, ticket.id, { status: "done" }, "human").status).toBe("done");
  });

  it("records the user's verdict as theirs, quoting their words and who relayed them", async () => {
    const { run, items, project, ticket } = await submitted();
    await expect(run("review_delivery", { id: ticket.key, decision: "accepted" })).rejects.toBeInstanceOf(ToolInputError);
    const reviewed = (await run("review_delivery", { id: ticket.key, decision: "accepted", userSaid: "可以直接验收" })) as { status: string };
    expect(reviewed.status).toBe("done");
    const review = items.get(project.id, ticket.id)!.evidence.reviews.at(-1)!;
    expect(review).toMatchObject({ decision: "accepted", reviewedBy: "human" });
    expect(review.comment).toBe("Relayed by ai:test; the user said: “可以直接验收”");
  });

  it("asks the person to confirm where it can, and records nothing when they decline", async () => {
    const { ctx, items, project, ticket } = await submitted();
    const asked: string[] = [];
    const call = (answer: (options: string[]) => string | null) =>
      ctx.tools.execute("review_delivery", { id: ticket.id, decision: "accepted", userSaid: "ship it" }, { by: "ai:test", projectId: project.id, ask: async (text, options) => (asked.push(text), answer(options)) });
    expect(await call((options) => options[1])).toMatchObject({ recorded: false });
    expect(items.get(project.id, ticket.id)).toMatchObject({ status: "verifying" });
    expect(asked[0]).toContain(ticket.key);
    expect(await call((options) => options[0])).toMatchObject({ status: "done" });
  });

  it("refuses a run that delivered work itself", async () => {
    const { ctx, project, ticket } = await submitted();
    const run = runHandle(project.id, [{ tool: "submit_delivery", ok: true }]);
    await expect(ctx.tools.execute("review_delivery", { id: ticket.id, decision: "accepted", userSaid: "ok" }, { by: "ai:test", projectId: project.id, run })).rejects.toThrow(/this run delivered work/);
  });
});

describe("create_item tool", () => {
  it("returns the first item for a repeated requestId instead of creating another", async () => {
    const { run, items, project } = await withTools();
    const [a, b] = (await Promise.all([run("create_item", { title: "Once", requestId: "r-1" }), run("create_item", { title: "Once", requestId: "r-1" })])) as { id: string }[];
    expect(b.id).toBe(a.id);
    expect(((await run("create_item", { title: "Once", requestId: "r-1" })) as { id: string }).id).toBe(a.id);
    await expect(run("create_item", { title: "Something else", requestId: "r-1" })).rejects.toThrow(/already used for another item/);
    expect(((await run("create_item", { title: "Once", requestId: "r-2" })) as { id: string }).id).not.toBe(a.id);
    expect(items.list({ projectId: project.id }).filter((i) => i.title === "Once")).toHaveLength(2);
  });

  it("gives the playbook recommendation a time budget and the caller's signal", async () => {
    const f = await withTools();
    const seen: unknown[] = [];
    await f.ctx.plugin({ name: "fake-agent", apply: (ctx: typeof f.ctx) => ctx.provide("agent", { recommendPlaybook: async (_p: string, _i: unknown, opts: unknown) => (seen.push(opts), { playbookId: null, workType: "general" }) }) });
    const signal = new AbortController().signal;
    await f.ctx.tools.execute("create_item", { title: "Recommend me" }, { by: "ai:test", projectId: f.project.id, signal });
    expect(seen).toEqual([{ withinMs: RECOMMEND_WITHIN_MS, signal }]);
  });
});
