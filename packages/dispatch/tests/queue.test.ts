import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { Roles } from "@tomradex/roles";
import { account, cleanup, machine, share, until, type Account, type FakeEngine, type Machine } from "./world.js";

let acct: Account;
beforeAll(async () => { acct = await account(); }, 60_000);
afterEach(async () => {
  await cleanup();
  // Each test starts with an empty queue and no machines.
  await acct.admin("delete from public.tomrade_dispatches");
  await acct.admin("delete from public.tomrade_devices");
});
afterAll(async () => { await acct.close(); });

/** The asking machine with a ticket, and the machines that hold the same project. */
async function pair(others: string[] = ["win-b"], opts: { plugins?: unknown[] } = {}) {
  const a = await machine(acct, "mac-a", opts);
  const ticket = a.items.create({ projectId: a.project.id, boardId: a.board.id, title: "Faster on Windows", status: "todo", workType: "coding", by: "human" });
  const rest: Machine[] = [];
  for (const device of others) {
    const m = await machine(acct, device, opts);
    await share(a, m, a.project.id);
    rest.push(m);
  }
  return { a, ticket, b: rest[0]!, rest, projectId: a.project.id };
}
const states = (m: Machine) => m.queue.list().map((d) => `${d.key}:${d.state}${d.reason ? ` (${d.reason})` : ""}`);

it("a ticket sent to another machine is taken there, started as its own Start would, and done when its session is over", async () => {
  const { a, b, ticket, projectId } = await pair();
  b.accept();
  const sent = await a.queue.send({ projectId, itemId: ticket.id, to: "win-b", engine: "claude-code" });
  expect(sent).toMatchObject({ state: "queued", fromDevice: "mac-a", toDevice: "win-b", key: ticket.key, title: "Faster on Windows", wish: { engine: "claude-code" } });
  // The machine that asked takes nothing of its own.
  await a.queue.tick();
  expect(a.code.starts).toEqual([]);

  await b.queue.tick();
  expect(b.code.starts).toEqual([{ projectId, itemId: ticket.id, opts: { mode: "run", engine: "claude-code", permissionMode: "acceptEdits", source: { dispatch: sent.id, device: "mac-a" } } }]);
  expect(states(b)).toEqual([`${ticket.key}:running`]);
  expect(b.s.recent()).toMatchObject([{ from: "mac-a", key: ticket.key, accepted: true, permissionMode: "acceptEdits" }]);
  await a.queue.tick();
  expect(a.queue.list()).toMatchObject([{ state: "running", claimedBy: "win-b" }]);
  // Sending it moved nothing on the ticket: its status is git's to change.
  expect([a.items.get(projectId, ticket.id)!.status, b.items.get(projectId, ticket.id)!.status]).toEqual(["todo", "todo"]);

  // Still working, then waiting on the person: still going.
  await b.queue.tick();
  [...b.code.sessions.values()][0]!.state = "waiting";
  await b.queue.tick();
  expect(states(b)).toEqual([`${ticket.key}:running`]);
  [...b.code.sessions.values()][0]!.state = "idle";
  await b.queue.tick();
  expect(states(b)).toEqual([`${ticket.key}:done`]);
  await a.queue.tick();
  expect(states(a)).toEqual([`${ticket.key}:done`]);
  // One that stopped on its own account says why.
  const again = await a.queue.send({ projectId, itemId: ticket.id, to: "win-b" });
  await b.queue.tick();
  Object.assign([...b.code.sessions.values()][1]!, { state: "error", summary: "stopped: out of quota" });
  await b.queue.tick();
  expect(b.queue.list().find((d) => d.id === again.id)).toMatchObject({ state: "done", reason: "stopped: out of quota" });
}, 60_000);

it("is refused, with the reason, by a machine that does not take it — and the asking machine reads why", async () => {
  const { a, b, ticket, projectId } = await pair();
  const refused = async (input: Partial<Parameters<Machine["queue"]["send"]>[0]> = {}) => {
    const sent = await a.queue.send({ projectId, itemId: ticket.id, to: "win-b", ...input });
    await b.queue.tick();
    await a.queue.tick();
    const row = a.queue.list().find((d) => d.id === sent.id)!;
    expect(row.state).toBe("refused");
    return row.reason;
  };
  // Off, as every machine is until its person says otherwise.
  expect(await refused()).toBe("off");
  b.accept({ allProjects: false, projects: ["another-project"] });
  expect(await refused()).toBe("project-not-allowed");
  b.accept();
  expect(await refused({ permissionMode: "bypassPermissions" })).toBe("permission: bypassPermissions is above this machine's limit (edits)");
  b.engines[0] = { ...b.engines[0]!, ok: false };
  expect(await refused({ engine: "claude-code" })).toBe("no-agent: claude-code is not ready here, and no other coding agent is");
  expect(await refused()).toBe("no-agent: no coding agent is installed and signed in here");
  b.engines[0] = { ...b.engines[0]!, ok: true };
  b.code.gate = { gate: "readiness", message: "the repository has no brief yet" };
  expect(await refused()).toBe("start: readiness — the repository has no brief yet");
  expect(b.code.sessions.size).toBe(0);

  // Each is in the taking machine's record, with who asked.
  expect(b.s.recent(10).map((d) => [d.from, d.accepted, d.reason])).toEqual([
    ["mac-a", false, "start"], ["mac-a", true, undefined], ["mac-a", false, "no-agent"], ["mac-a", false, "no-agent"],
    ["mac-a", false, "permission"], ["mac-a", false, "project-not-allowed"], ["mac-a", false, "off"]
  ]);
}, 60_000);

it("takes the agent that is ready when the one asked for is not, and never more at once than it allows", async () => {
  const { a, b, ticket, projectId } = await pair();
  b.accept();
  b.engines.splice(0, 1, { id: "claude-code", title: "Claude Code", ok: false }, { id: "codex", title: "Codex", ok: true, modes: ["full-access", "workspace", "read-only"] });
  await a.queue.send({ projectId, itemId: ticket.id, to: "win-b", engine: "claude-code" });
  await b.queue.tick();
  expect(b.code.starts[0]!.opts).toMatchObject({ engine: "codex", permissionMode: "workspace" });

  // A second ticket while the first runs: this machine takes one at a time.
  const other = a.items.create({ projectId, boardId: a.board.id, title: "Another", status: "todo", workType: "coding", by: "human" });
  await share(a, b, projectId);
  const second = await a.queue.send({ projectId, itemId: other.id, to: "win-b" });
  await b.queue.tick();
  expect(b.queue.list().find((d) => d.id === second.id)).toMatchObject({ state: "refused", reason: "busy: 1 of 1 running" });
  expect(b.code.starts).toHaveLength(1);
}, 60_000);

it("made for any machine of a platform, it is started on exactly one of two that could take it", async () => {
  const { a, rest, ticket, projectId } = await pair(["win-b", "win-c"]);
  const [b, c] = rest as [Machine, Machine];
  b.accept();
  c.accept();
  const sent = await a.queue.send({ projectId, itemId: ticket.id, platform: process.platform });
  expect(sent).toMatchObject({ toDevice: null, toPlatform: process.platform });
  await Promise.all([b.queue.tick(), c.queue.tick()]);
  await Promise.all([b.queue.tick(), c.queue.tick()]);
  expect(b.code.starts.length + c.code.starts.length).toBe(1);
  const winner = b.code.starts.length ? b : c;
  expect(winner.queue.list()).toMatchObject([{ state: "running", claimedBy: winner.device }]);
  // The one that lost the claim turned nothing away.
  const loser = winner === b ? c : b;
  expect(loser.s.recent()).toEqual([]);
}, 60_000);

it("a machine that cannot take one made for its platform leaves it for another", async () => {
  const { a, rest, ticket, projectId } = await pair(["win-b", "win-c"]);
  const [b, c] = rest as [Machine, Machine];
  c.accept();
  await a.queue.send({ projectId, itemId: ticket.id, platform: process.platform });
  for (let i = 0; i < 2; i++) await b.queue.tick();
  expect(b.queue.list()).toMatchObject([{ state: "queued" }]);
  expect(b.s.recent()).toEqual([]);
  await c.queue.tick();
  expect(c.queue.list()).toMatchObject([{ state: "running", claimedBy: "win-c" }]);
}, 60_000);

it("made for any machine of a platform, it is taken by one that could not take it at first, once it can", async () => {
  const bus = new Set<{ device: string; ctx: never }>();
  const a = await machine(acct, "mac-a", { bus: bus as never });
  const b = await machine(acct, "win-b", { bus: bus as never });
  const projectId = a.project.id;
  const make = (title: string) => a.items.create({ projectId, boardId: a.board.id, title, status: "todo", workType: "coding", by: "human" });
  const [first, second, third] = [make("One"), make("Two"), make("Three")];
  await share(a, b, projectId);
  let told = 0, probed = 0;
  a.ctx.on("cloudHub/signal" as never, (() => { told++; }) as never);
  const agent = b.ctx.get("agent") as { codeEngines(): { available(): Promise<unknown> }[] };
  const engines = agent.codeEngines.bind(agent);
  agent.codeEngines = () => engines().map((e) => ({ ...e, available: () => { probed++; return e.available(); } }));

  // Seen while this machine takes nothing: it looks, by its own settings alone, and says nothing to the others.
  await a.queue.send({ projectId, itemId: first.id, platform: process.platform });
  for (let i = 0; i < 3; i++) await b.queue.tick();
  expect(b.queue.list()).toMatchObject([{ state: "queued" }]);
  expect({ told, probed }).toEqual({ told: 0, probed: 0 });
  // Turned on: taken without waiting for the next look.
  b.accept();
  await until(() => b.code.starts.length === 1);

  // Busy: the next one waits, and is taken when the first is over.
  await a.queue.send({ projectId, itemId: second.id, platform: process.platform });
  for (let i = 0; i < 2; i++) await b.queue.tick();
  expect(b.code.starts).toHaveLength(1);
  b.code.sessions.get("session-1")!.state = "ended";
  await b.queue.tick();
  await until(() => b.code.starts.length === 2);
  expect(b.code.starts[1]).toMatchObject({ itemId: second.id });
  b.code.sessions.get("session-2")!.state = "ended";
  await b.queue.tick();

  // No agent ready, and nothing here says when one is: looked at again after a while.
  b.engines[0]!.ok = false;
  await a.queue.send({ projectId, itemId: third.id, platform: process.platform });
  await b.queue.tick();
  b.engines[0]!.ok = true;
  await b.queue.tick();
  expect(b.code.starts).toHaveLength(2);
  const now = Date.now();
  const later = vi.spyOn(Date, "now").mockImplementation(() => now + 61_000);
  try { await b.queue.tick(); } finally { later.mockRestore(); }
  expect(b.code.starts[2]).toMatchObject({ itemId: third.id });
}, 60_000);

it("waits for a machine that is off, and is no longer on offer once its time has run out", async () => {
  const a = await machine(acct, "mac-a");
  const ticket = a.items.create({ projectId: a.project.id, boardId: a.board.id, title: "While you were out", status: "todo", workType: "coding", by: "human" });
  await acct.register("win-b");
  const sent = await a.queue.send({ projectId: a.project.id, itemId: ticket.id, to: "win-b" });
  for (let i = 0; i < 2; i++) await a.queue.tick();
  expect(states(a)).toEqual([`${ticket.key}:queued`]);

  // The other machine comes on later, with the project.
  const b = await machine(acct, "win-b");
  await share(a, b, a.project.id);
  b.accept();
  await b.queue.tick();
  expect(states(b)).toEqual([`${ticket.key}:running`]);
  await a.queue.cancel(sent.id);

  // One nobody takes in time: the asking machine takes it back, and it can be sent again.
  const late = await a.queue.send({ projectId: a.project.id, itemId: ticket.id, to: "win-b" });
  await acct.admin("update public.tomrade_dispatches set expires_at = now() - interval '1 second' where id = $1", [late.id]);
  await b.queue.tick();
  expect(b.code.starts).toHaveLength(1);
  await a.queue.tick();
  expect(a.queue.list().find((d) => d.id === late.id)).toMatchObject({ state: "cancelled", reason: "expired" });
  await expect(a.queue.send({ projectId: a.project.id, itemId: ticket.id, to: "win-b" })).resolves.toMatchObject({ state: "queued" });
}, 60_000);

it("taken back by the machine that asked, its session is stopped where it runs, and the place is free again", async () => {
  const { a, b, ticket, projectId } = await pair();
  b.accept();
  const sent = await a.queue.send({ projectId, itemId: ticket.id, to: "win-b" });
  await b.queue.tick();
  const session = [...b.code.sessions.keys()][0]!;
  expect(await a.queue.cancel(sent.id)).toMatchObject([{ id: sent.id, state: "cancelled" }]);
  await b.queue.tick();
  expect(b.code.stopped).toEqual([session]);
  expect(states(b)).toEqual([`${ticket.key}:cancelled`]);
  // Not stopped twice, and the next one is taken.
  await b.queue.tick();
  expect(b.code.stopped).toHaveLength(1);
  await a.queue.send({ projectId, itemId: ticket.id, to: "win-b" });
  await b.queue.tick();
  expect(b.code.starts).toHaveLength(2);
  // Taken back before it was taken: it never starts.
  const other = a.items.create({ projectId, boardId: a.board.id, title: "Never mind", status: "todo", workType: "coding", by: "human" });
  await share(a, b, projectId);
  const early = await a.queue.send({ projectId, itemId: other.id, to: "win-b" });
  await a.queue.cancel(early.id);
  await b.queue.tick();
  expect(b.code.starts).toHaveLength(2);
}, 60_000);

it("waits for a ticket that has not reached the machine yet, and clones a repository it has no checkout of", async () => {
  const { a, b, projectId } = await pair();
  b.accept();
  const fresh = a.items.create({ projectId, boardId: a.board.id, title: "Just written", status: "todo", workType: "coding", by: "human" });
  await a.queue.send({ projectId, itemId: fresh.id, to: "win-b" });
  for (let i = 0; i < 2; i++) await b.queue.tick();
  // Neither taken nor turned away: the project's folder has not brought it yet.
  expect(states(b)).toEqual([`${fresh.key}:queued`]);
  expect(b.s.recent()).toEqual([]);

  await share(a, b, projectId);
  b.code.gate = { gate: "checkout", message: "No checkout of app on this machine", remote: "https://github.com/acme/app", repo: { id: "r1", name: "app" } };
  b.code.clearsOnClone = true;
  await b.queue.tick();
  expect(b.cloned).toMatchObject([{ remote: "https://github.com/acme/app", branch: "main" }]);
  expect(b.cloned[0]!.parent).toMatch(/hub[/\\]repos$/);
  expect(b.code.starts).toHaveLength(2);
  expect(states(b)).toEqual([`${fresh.key}:running`]);
}, 60_000);

it("finds what it runs again after a restart, and puts back on offer one it took but never started", async () => {
  const { a, b, ticket, projectId } = await pair();
  b.accept();
  const running = await a.queue.send({ projectId, itemId: ticket.id, to: "win-b" });
  await b.queue.tick();
  const before = [...b.code.sessions.values()][0]!;
  // Tomrade starts again on the same machine: its settings and the project are as they were, its memory is not.
  const again = await machine(acct, "win-b", { dir: b.dir, prepare: async (m) => {
    await share(a, m, projectId);
    m.code.sessions.set(before.id, { ...before });
  } });
  await again.queue.tick();
  expect(again.queue.list().find((d) => d.id === running.id)).toMatchObject({ state: "running" });
  // It counts against its sessions at once, as before.
  expect(again.s.peek({ from: "mac-a", projectId, key: ticket.key })).toMatchObject({ ok: false, reason: "busy" });
  again.code.sessions.get(before.id)!.state = "idle";
  await again.queue.tick();
  expect(again.queue.list().find((d) => d.id === running.id)).toMatchObject({ state: "done" });

  // Taken, and then Tomrade stopped before it began.
  const other = a.items.create({ projectId, boardId: a.board.id, title: "Interrupted", status: "todo", workType: "coding", by: "human" });
  await share(a, again, projectId);
  const taken = await a.queue.send({ projectId, itemId: other.id, to: "win-b" });
  await acct.client().rpc("tomrade_claim_dispatch", { p_id: taken.id, p_device: "win-b" });
  await again.queue.tick();
  // Not refused: nobody decided against it. It waits again, for this machine or the next it is for.
  expect(again.queue.list().find((d) => d.id === taken.id)).toMatchObject({ state: "queued", claimedBy: null, reason: null });
  expect(again.code.starts).toEqual([]);
  await again.queue.tick();
  expect(again.queue.list().find((d) => d.id === taken.id)).toMatchObject({ state: "running", claimedBy: "win-b" });
  expect(again.code.starts).toHaveLength(1);
}, 60_000);

it("is taken by the next machine it is for when the one that took it goes quiet before starting, and never once it runs", async () => {
  const { a, rest: [b, c], ticket, projectId } = await pair(["win-b", "win-c"]);
  b!.accept();
  c!.accept();
  const sent = await a.queue.send({ projectId, itemId: ticket.id, platform: process.platform });
  // win-b takes it and is never heard of again.
  await acct.client().rpc("tomrade_claim_dispatch", { p_id: sent.id, p_device: "win-b" });
  await c!.queue.tick();
  expect(c!.code.starts).toEqual([]);
  await acct.admin("update public.tomrade_dispatches set updated_at = now() - interval '4 minutes' where id = $1", [sent.id]);
  await c!.queue.tick();
  expect(c!.code.starts).toEqual([]);
  await acct.admin("update public.tomrade_dispatches set updated_at = now() - interval '7 minutes' where id = $1", [sent.id]);
  await c!.queue.tick();
  expect(c!.code.starts).toHaveLength(1);
  expect(c!.queue.list().find((d) => d.id === sent.id)).toMatchObject({ state: "running", claimedBy: "win-c" });
  // Running, however long ago it last said so: losing touch with a machine is no proof its work stopped.
  await acct.admin("update public.tomrade_dispatches set updated_at = now() - interval '3 hours' where id = $1", [sent.id]);
  await b!.queue.tick();
  expect(b!.code.starts).toEqual([]);
  expect(b!.queue.list().find((d) => d.id === sent.id)).toMatchObject({ state: "running", claimedBy: "win-c" });
}, 60_000);

const CODEX: FakeEngine = { id: "codex", title: "Codex", ok: true, modes: ["read-only", "workspace", "full-access"] };

it("sent with a role, it is worked the way the role says on the machine that takes it", async () => {
  const { a, b, ticket, projectId } = await pair(["win-b"], { plugins: [Roles] });
  b.accept();
  b.engines.push(CODEX);
  const role = a.ctx.roles.save(projectId, { title: "Careful", engines: ["codex", "claude-code"], permission: "ask", instructions: "Measure before and after." });
  // The role reaches the other machine with the project's folder, never through the account.
  await share(a, b, projectId);
  expect(b.ctx.roles.get(projectId, role.id)).toMatchObject({ title: "Careful", engines: ["codex", "claude-code"], permission: "ask", instructions: "Measure before and after." });

  const sent = await a.queue.send({ projectId, itemId: ticket.id, to: "win-b", role: role.id });
  expect(sent.wish).toEqual({ role: role.id });
  await b.queue.tick();
  // The role's first agent that is ready there, and the lower of the role's limit and that machine's own.
  expect(b.code.starts).toEqual([{ projectId, itemId: ticket.id, opts: { mode: "run", engine: "codex", permissionMode: "read-only", role: role.id, source: { dispatch: sent.id, device: "mac-a" } } }]);
  expect(b.s.recent()).toMatchObject([{ accepted: true, permissionMode: "read-only" }]);
  [...b.code.sessions.values()][0]!.state = "idle";
  await b.queue.tick();

  // The role's first agent is not ready: its next one, and still no other.
  b.engines[1] = { ...CODEX, ok: false };
  const second = await a.queue.send({ projectId, itemId: ticket.id, to: "win-b", role: role.id });
  await b.queue.tick();
  expect(b.code.starts[1]!.opts).toEqual({ mode: "run", engine: "claude-code", permissionMode: "default", role: role.id, source: { dispatch: second.id, device: "mac-a" } });
  [...b.code.sessions.values()][1]!.state = "idle";
  await b.queue.tick();

  // More than the role allows is turned away, by the role's limit.
  const over = await a.queue.send({ projectId, itemId: ticket.id, to: "win-b", role: role.id, permissionMode: "acceptEdits" });
  await b.queue.tick();
  expect(b.queue.list().find((d) => d.id === over.id)).toMatchObject({ state: "refused", reason: "permission: acceptEdits is above the role's limit (ask)" });
  // A role that reviews works no ticket, and one the project lacks is not sent at all.
  await expect(a.queue.send({ projectId, itemId: ticket.id, to: "win-b", role: "reviewer" })).rejects.toThrow("This project has no role reviewer that works tickets.");
  await expect(a.queue.send({ projectId, itemId: ticket.id, to: "win-b", role: "absent" })).rejects.toThrow("This project has no role absent that works tickets.");
}, 60_000);

it("waits for a role that has not reached the machine yet, and starts once it has", async () => {
  const { a, b, ticket, projectId } = await pair(["win-b"], { plugins: [Roles] });
  b.accept();
  const role = a.ctx.roles.save(projectId, { title: "New here", instructions: "Small commits." });
  const sent = await a.queue.send({ projectId, itemId: ticket.id, to: "win-b", role: role.id });
  await b.queue.tick();
  await b.queue.tick();
  // Neither taken nor refused: the project has not brought the role yet.
  expect(b.code.starts).toEqual([]);
  expect(states(b)).toEqual([`${ticket.key}:queued`]);
  expect(b.s.recent()).toEqual([]);
  await share(a, b, projectId);
  await b.queue.tick();
  expect(b.code.starts).toMatchObject([{ opts: { role: role.id, engine: "claude-code" } }]);
  expect(b.queue.list().find((d) => d.id === sent.id)).toMatchObject({ state: "running" });
}, 60_000);

it("a machine with none of the role's agents says so when the ticket was sent to it, and leaves one made for its platform to another", async () => {
  const { a, rest: [b, c], ticket, projectId } = await pair(["win-b", "win-c"], { plugins: [Roles] });
  b!.accept();
  c!.accept();
  c!.engines.push(CODEX);
  const role = a.ctx.roles.save(projectId, { title: "Codex only", engines: ["codex"] });
  await share(a, b!, projectId);
  await share(a, c!, projectId);
  const named = await a.queue.send({ projectId, itemId: ticket.id, to: "win-b", role: role.id });
  await b!.queue.tick();
  expect(b!.queue.list().find((d) => d.id === named.id)).toMatchObject({ state: "refused", reason: "no-agent: none of the agents of the role Codex only is ready here (codex)" });
  expect(b!.code.starts).toEqual([]);

  // What the role asks of a machine names where it goes when the sender names nothing.
  a.ctx.roles.save(projectId, { id: role.id, title: "Codex only", needs: { platform: process.platform } });
  await share(a, b!, projectId);
  await share(a, c!, projectId);
  const any = await a.queue.send({ projectId, itemId: ticket.id, role: role.id });
  expect(any).toMatchObject({ toDevice: null, toPlatform: process.platform });
  await b!.queue.tick();
  expect(b!.code.starts).toEqual([]);
  expect(b!.queue.list().find((d) => d.id === any.id)).toMatchObject({ state: "queued" });
  await c!.queue.tick();
  expect(c!.code.starts).toMatchObject([{ opts: { engine: "codex", role: role.id } }]);
  // With neither a machine, a platform nor a role that names one, there is nowhere to send it.
  const plain = a.ctx.roles.save(projectId, { title: "Anywhere" });
  await expect(a.queue.send({ projectId, itemId: ticket.id, role: plain.id })).rejects.toThrow("Name the device, or the platform, to send the ticket to.");
}, 60_000);

it("sends only what a request may carry, between machines of the account", async () => {
  const { a, ticket, projectId } = await pair();
  await expect(a.queue.send({ projectId, itemId: ticket.id })).rejects.toThrow(/Name the device/);
  await expect(a.queue.send({ projectId, itemId: "no-such-item", to: "win-b" })).rejects.toThrow(/unknown item/);
  await expect(a.queue.send({ projectId, itemId: ticket.id, to: "not-a-device" })).rejects.toThrow(/No such device/);
  await a.queue.send({ projectId, itemId: ticket.id, to: "win-b" });
  await expect(a.queue.send({ projectId, itemId: ticket.id, to: "win-b" })).rejects.toThrow(/already sent to a machine/);
  const row = (await acct.admin<Record<string, unknown>>("select * from public.tomrade_dispatches"))[0]!;
  expect(Object.keys(row).sort()).toEqual(["claimed_by", "created_at", "expires_at", "from_device", "id", "item_key", "project_id", "reason", "state", "title", "to_device", "to_platform", "updated_at", "user_id", "wish"]);
  expect(JSON.stringify(row)).not.toMatch(new RegExp(a.dir.replace(/[\\/]/g, ".")));
}, 60_000);
