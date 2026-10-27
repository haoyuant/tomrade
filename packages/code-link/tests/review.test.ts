import { describe, expect, it } from "vitest";
import type { RecordLine, ThreadMessage } from "@tomradex/agent";
import { fresh } from "@tomradex/testkit";
import { CodeLinkStore, MIGRATIONS, Review, TABLES, cutByTicket, cutFrom, cutThread, joinCuts, mergePage, threadLines, ticketOutcome, type CodeLinkView, type ReviewRow } from "@tomradex/code-link";

const itemOfKey = (key: string) => ({ "TOM-634": "a", "TOM-638": "b" })[key] ?? null;
const me = (text: string, at?: number): RecordLine => ({ who: "person", text, ...(at !== undefined ? { at } : {}) });
const ag = (text: string, at?: number): RecordLine => ({ who: "agent", text, ...(at !== undefined ? { at } : {}) });
const tool = (text: string, at?: number): RecordLine => ({ who: "tool", text, detail: { input: "" }, ...(at !== undefined ? { at } : {}) });

describe("a conversation cut by ticket", () => {
  it("begins a ticket's stretch at its mark, another at the next, and one more when the session comes back to it", () => {
    const lines = [me("看看哪个先做", 100), ag("先做录制。", 110), me("开始做 TOM-634。", 200), tool("Write · record.ts", 210), me("先插一个 TOM-638", 300), tool("Edit · Sidebar.tsx", 310), me("回到录制", 400), tool("Bash · pnpm test", 410)];
    const marks = [{ itemId: "a", at: 190 }, { itemId: "b", at: 295 }, { itemId: "a", at: 395 }];
    expect(cutByTicket(lines, marks, itemOfKey).map((c) => [c.itemId, c.lines.length])).toEqual([[null, 2], ["a", 2], ["b", 2], ["a", 2]]);
  });

  it("opens the ticket's stretch at the claim the record itself shows, and keeps unstamped lines where they are", () => {
    const lines = [me("开始", 100), ag("我来认领。", 105), tool("mcp__tomrade__claim_ticket · TOM-638", 106), ag("认领了。", 108), me("没时间戳的一句"), tool("claim_ticket · tom-634"), ag("换了一张")];
    // the mark lands after the claim line's stamp, as a hook speaks after the record wrote the call
    const marks = [{ itemId: "b", at: 107 }];
    expect(cutByTicket(lines, marks, itemOfKey).map((c) => [c.itemId, c.lines.map((l) => l.text)])).toEqual([
      [null, ["开始", "我来认领。"]],
      ["b", ["mcp__tomrade__claim_ticket · TOM-638", "认领了。", "没时间戳的一句"]],
      ["a", ["claim_ticket · tom-634", "换了一张"]]
    ]);
  });

  it("cuts a running session a page at a time: the newest page goes on from where the earlier ones ended, as if cut at once", () => {
    const lines = [me("看看", 100), tool("claim_ticket · TOM-634", 150), tool("Write · a.ts", 160), me("插一个", 300), tool("Edit · b.ts", 310), me("回到录制", 400), tool("Bash · pnpm test", 410), ag("测试过了", 420)];
    const marks = [{ itemId: "b", at: 295 }, { itemId: "a", at: 395 }];
    const whole = cutByTicket(lines, marks, itemOfKey);
    for (let at = 0; at <= lines.length; at++) {
      const earlier = cutFrom(lines.slice(0, at), marks, itemOfKey);
      const tail = cutFrom(lines.slice(at), marks, itemOfKey, earlier.state);
      expect(joinCuts(earlier.cuts, tail.cuts)).toEqual(whole);
    }
    // the session moved: only its newest page is cut again, from the state the earlier pages left
    const earlier = cutFrom(lines.slice(0, 5), marks, itemOfKey);
    const grown = [...lines.slice(5), tool("Write · c.ts", 430)];
    expect(joinCuts(earlier.cuts, cutFrom(grown, marks, itemOfKey, earlier.state).cuts).map((c) => [c.itemId, c.lines.length])).toEqual([[null, 1], ["a", 2], ["b", 2], ["a", 4]]);
  });

  it("gives every line to the ticket a session started on, from the first", () => {
    const lines = [me("Implement TOM-634", 100), tool("Write · a.ts", 200)];
    expect(cutByTicket(lines, [{ itemId: "a", at: 100 }], itemOfKey)).toEqual([{ itemId: "a", lines }]);
    expect(cutByTicket([], [], itemOfKey)).toEqual([]);
  });
});

describe("an assistant conversation cut as a session is", () => {
  let seq = 0;
  const msg = (role: ThreadMessage["role"], block: ThreadMessage["block"]): ThreadMessage => ({ id: `m${++seq}`, threadId: "t", seq, role, block, runId: "r", at: seq });
  const said = (text: string) => msg("agent", { type: "text", text });
  const asked = (text: string) => msg("user", { type: "text", text });
  const step = (tool: string) => msg("agent", { type: "trace", tool, args: { path: "a.ts" }, ok: true, summary: "", ms: 1 });
  const claim = (key: string) => msg("system", { type: "note", text: `Claimed ${key}`, claimed: key });
  const shape = (cuts: ReturnType<typeof cutThread>) => cuts.map((c) => [c.itemId, c.messages.length]);

  it("reads its chat apart from its code, and the code as the ticket's it claimed for it", () => {
    const chat = [asked("整理 Q4"), said("有 3 组重复。"), asked("写个脚本")];
    const code = [step("read_file"), step("write_file"), said("写好了。")];
    // claimed for the code it had just started writing: that stretch is the ticket's
    expect(shape(cutThread([...chat, ...code, claim("TOM-634"), step("bash")], itemOfKey, null))).toEqual([[null, 3], ["a", 5]]);
    // claimed before it wrote: the ticket's stretch starts at the claim, and its code is the ticket's too
    expect(shape(cutThread([...chat, claim("TOM-634"), ...code], itemOfKey, null))).toEqual([[null, 3], ["a", 1], ["a", 3]]);
    // opened on a ticket: all of it is the ticket's, chat and code apart
    expect(shape(cutThread([...chat, ...code], itemOfKey, "b"))).toEqual([["b", 3], ["b", 3]]);
    // never wrote, never claimed: one stretch
    expect(shape(cutThread(chat, itemOfKey, null))).toEqual([[null, 3]]);
    expect(cutThread([], itemOfKey, null)).toEqual([]);
  });
});

describe("what a ticket came to", () => {
  const link = (over: Partial<CodeLinkView>): CodeLinkView => ({ id: "l", projectId: "p", itemId: "a", repoId: "r", delivery: 1, branch: "tom-634/x", headSha: null, headAt: null, ahead: 0, behind: 0, mergedSha: null, prNumber: null, prUrl: null, prState: null, threadId: null, source: "scan", lastSeenAt: null, createdAt: 1, updatedAt: 1, ...over });
  const session = { branch: "tom-634/x", delivery: 1, worked: [] };

  it("reads the pull request and commits off the link on the session's branch for its delivery", () => {
    const links = [link({ id: "old", delivery: 1, branch: "tom-634/old", ahead: 9 }), link({ id: "now", ahead: 4, prNumber: 407, prState: "merged", prUrl: "https://x/407" })];
    expect(ticketOutcome(session, "a", links)).toEqual({ pr: { number: 407, state: "merged", url: "https://x/407" }, commits: 4 });
    expect(ticketOutcome(session, "b", links)).toEqual({ pr: null, commits: 0 });
  });

  it("says merged locally when the branch merged without a pull request, and the delivery a left ticket was worked in", () => {
    expect(ticketOutcome(session, "a", [link({ mergedSha: "abc", ahead: 2 })])).toEqual({ pr: { number: null, state: "merged", url: null }, commits: 2 });
    const left = { branch: "", delivery: 2, worked: [{ itemId: "a", delivery: 1 }] };
    expect(ticketOutcome(left, "a", [link({ delivery: 1, ahead: 3 }), link({ id: "l2", delivery: 2, ahead: 7 })])).toEqual({ pr: null, commits: 3 });
  });
});

describe("one page from three sources", () => {
  const row = (id: string, kind: ReviewRow["kind"], endedAt: number): ReviewRow => ({ id, kind, agent: "x", title: id, tickets: [], asked: null, commits: 0, pr: null, said: null, where: "panel", threadId: null, resumable: false, startedAt: 0, endedAt });

  it("orders sessions and conversations together by end, and says where each source goes on", () => {
    const page = mergePage({ session: [row("s1", "session", 50), row("s2", "session", 30)], thread: [row("t1", "thread", 40), row("t2", "thread", 20)], idle: [] }, null, 3);
    expect(page.rows.map((r) => r.id)).toEqual(["s1", "t1", "s2"]);
    // the sessions ran dry within the page; the conversations go on from the last one taken
    expect(page.next).toEqual({ session: null, thread: { at: 40, id: "t1" }, idle: null });
  });

  it("lists idle conversations with the rest, by when they last moved, and pages them on their own", () => {
    const page = mergePage({ session: [row("s1", "session", 50)], thread: [], idle: [row("i1", "idle", 60), row("i2", "idle", 40), row("i3", "idle", 10)] }, null, 3);
    expect(page.rows.map((r) => r.id)).toEqual(["i1", "s1", "i2"]);
    expect(page.next).toEqual({ session: null, thread: null, idle: { at: 40, id: "i2" } });
    // a source that gave a full page goes on even when none of its rows were taken yet
    const later = mergePage({ session: [], thread: [], idle: [row("i3", "idle", 10)] }, page.next, 1);
    expect(later.rows.map((r) => r.id)).toEqual(["i3"]);
    expect(later.next).toEqual({ session: null, thread: null, idle: { at: 10, id: "i3" } });
  });

  it("ends when every source ran dry within the page", () => {
    expect(mergePage({ session: [row("s1", "session", 5)], thread: [], idle: [] }, null, 30).next).toBeNull();
    const page = mergePage({ session: [row("s1", "session", 5)], thread: [], idle: [] }, { session: { at: 9, id: "z" }, thread: null, idle: null }, 30);
    expect(page.next).toBeNull();
  });
});

describe("an assistant conversation as record lines", () => {
  it("keeps what was said and each step with its output, and leaves the machine-written brief out", () => {
    const m = (role: ThreadMessage["role"], block: ThreadMessage["block"], at: number): ThreadMessage => ({ id: `${at}`, threadId: "t", seq: at, role, block, runId: null, at });
    const lines = threadLines([
      m("user", { type: "text", text: "Implement TOM-1 — do it" }, 1),
      m("user", { type: "text", text: "写发布说明" }, 2),
      m("agent", { type: "trace", tool: "write_file", args: { path: "releases/0.21.md" }, ok: true, summary: "", ms: 1 }, 3),
      m("agent", { type: "trace", tool: "bash", args: { command: "pnpm test" }, ok: true, summary: "", ms: 1, commandResult: { status: "success", exitCode: 0, output: "4 passed" } }, 4),
      m("agent", { type: "text", text: "写好了。" }, 5),
      m("agent", { type: "status", text: "thinking" }, 6)
    ]);
    expect(lines).toEqual([
      { who: "person", text: "写发布说明", at: 2 },
      { who: "tool", text: "write_file · releases/0.21.md", detail: { input: '{\n  "path": "releases/0.21.md"\n}' }, at: 3 },
      { who: "tool", text: "bash · pnpm test", detail: { input: "$ pnpm test", output: "4 passed" }, at: 4 },
      { who: "agent", text: "写好了。", at: 5 }
    ]);
  });
});

describe("the look back over the store", () => {
  it("pages ended sessions newest first without overlap, finds them by title or ticket, and opens one cut by its marks", async () => {
    const { ctx, items, project, board } = await fresh();
    ctx.db.migrate("code_link", MIGRATIONS, { tables: TABLES });
    const store = new CodeLinkStore(ctx.db);
    const snap = items.create({ projectId: project.id, boardId: board.id, title: "结束时存下记录快照", by: "human" });
    const mcp = items.create({ projectId: project.id, boardId: board.id, title: "MCP 残留", by: "human" });
    const mk = (over: { title?: string; itemIds?: string[]; endedAt: number; prompted?: boolean }) => {
      const s = store.createSession(project.id, { repoId: "r", branch: "b", itemIds: over.itemIds ?? [], mode: "terminal", agent: "claude-code", threadId: null, device: "d" });
      store.patchSession(project.id, s.id, { state: "ended", endedAt: over.endedAt, ...(over.title ? { title: over.title } : {}), ...(over.prompted ? { prompted: true } : {}) });
      return s.id;
    };
    const ids = [mk({ itemIds: [snap.id], endedAt: 500 }), mk({ title: "0.21 发布说明", endedAt: 400 }), mk({ title: "整理 backlog", endedAt: 300 }), mk({ endedAt: 200, prompted: true }), mk({ endedAt: 100 })];
    const session = store.session(project.id, ids[0]!)!;
    expect(session.marks).toEqual([{ itemId: snap.id, at: session.startedAt }]);
    expect(session.asked).toBe(0);
    const base = session.startedAt;
    store.patchSession(project.id, ids[0]!, { externalId: "cc-1", asked: 2, marks: [...session.marks, { itemId: mcp.id, at: base + 50 }], worked: [{ itemId: mcp.id, delivery: 1 }] });
    store.upsertLink(project.id, { itemId: snap.id, repoId: "r", branch: "b" }, { ahead: 4, prNumber: 407, prState: "merged", prUrl: "https://x/407" });

    const read = (_projectId: string, sessionId: string) => (sessionId === ids[0] ? { lines: [me("开始做", base + 10), tool("Write · snapshots.ts", base + 20), tool("claim_ticket · " + mcp.key, base + 60), tool("Edit · check-env.mjs", base + 70)], cut: false } : null);
    const review = new Review({ ctx, store, read, recorded: async () => true });
    const first = review.list(project.id, { limit: 2 });
    expect(first.rows.map((r) => r.id)).toEqual([ids[0], ids[1]]);
    expect(first.rows[0]).toMatchObject({ title: "结束时存下记录快照", asked: 2, commits: 4, pr: { number: 407, state: "merged" }, where: "outside" });
    expect(first.rows[0]!.tickets.map((t) => t.key)).toEqual([snap.key, mcp.key]);
    const second = review.list(project.id, { limit: 2, before: first.next });
    expect(second.rows.map((r) => r.id)).toEqual([ids[2], ids[3]]);
    // a start nobody spoke to, with no ticket and no title, is not kept: the page after is empty and the last
    const third = review.list(project.id, { limit: 2, before: second.next });
    expect(third).toEqual({ rows: [], next: null });

    expect(review.list(project.id, { query: "发布" }).rows.map((r) => r.id)).toEqual([ids[1]]);
    expect(review.list(project.id, { query: mcp.key.toLowerCase() }).rows.map((r) => r.id)).toEqual([ids[0]]);

    const opened = await review.open(project.id, { sessionId: ids[0] });
    expect(opened?.segments.map((s) => [s.key, s.lines.length, s.from, s.to])).toEqual([[snap.key, 2, base + 10, base + 20], [mcp.key, 2, base + 60, base + 70]]);
    expect(opened).toMatchObject({ cut: false, unreadable: false, raw: false });
    expect(await review.open(project.id, { sessionId: "nope" })).toBeNull();

    const said = await review.saidIn(project.id, "snapshots");
    expect(said.rows.map((r) => r.id)).toEqual([ids[0]]);
    expect(said.said[ids[0]!]).toBe("Write · snapshots.ts");
    await ctx.fiber.dispose();
  });
});
