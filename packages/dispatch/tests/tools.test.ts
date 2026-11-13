import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type { DeviceView, DevicesInfo } from "@tomradex/hub-cloud";
import { Tools } from "@tomradex/tools";
import { account, cleanup, machine, type Account } from "./world.js";

let acct: Account;
beforeAll(async () => { acct = await account(); }, 60_000);
afterEach(async () => {
  await cleanup();
  await acct.admin("delete from public.tomrade_dispatches");
  await acct.admin("delete from public.tomrade_devices");
});
afterAll(async () => { await acct.close(); });

const by = "ai:test" as const;
const ACCEPT = { on: true, projects: "all" as const, ceiling: "edits" as const, concurrent: 1 };
const READY = [{ id: "claude-code", title: "Claude Code", ready: true }];
const device = (id: string, over: Partial<DeviceView> = {}): DeviceView => ({
  id, name: id, self: false, online: true, lastSeenAt: 1_700_000_000_000, activityAt: null, platform: "win32", arch: "x64", version: "1.0.0", git: true,
  agents: READY, repos: [], accept: ACCEPT, sessions: [], nightShifts: [], ...over
});

/** This machine, with an agent's tools, a ticket, and the account's other machines as the account service would list them. */
async function desk(others: DeviceView[], state: DevicesInfo["state"] = "ready") {
  const a = await machine(acct, "mac-a", { plugins: [Tools] });
  for (const other of others) await acct.register(other.id, other.platform);
  const ticket = a.items.create({ projectId: a.project.id, boardId: a.board.id, title: "Faster on Windows", status: "todo", workType: "coding", by: "human" });
  const list: DevicesInfo = { state, devices: state === "ready" ? [device("mac-a", { self: true, name: "Studio", platform: "darwin" }), ...others] : [], plan: { id: "free", limit: 2, subscribeUrl: "" } };
  Object.assign(a.ctx.get("cloudHub") as object, { devicesInfo: () => list });
  const questions: string[] = [];
  const call = (name: string, args: Record<string, unknown>, said?: string | null) =>
    a.ctx.tools.execute(name, args, { by, projectId: a.project.id, ...(said === undefined ? {} : { ask: async (text: string) => (questions.push(text), said) }) }) as Promise<any>;
  return { a, ticket, call, questions };
}

it("lists the account's computers, and which can take a ticket and why not", async () => {
  const { ticket, call } = await desk([
    device("win-b", { name: "Tower" }),
    device("win-off", { accept: { ...ACCEPT, on: false } }),
    device("win-picky", { accept: { ...ACCEPT, projects: ["another"] } }),
    device("win-bare", { agents: [{ id: "codex", title: "Codex", ready: false }] }),
    device("win-asleep", { online: false, sessions: [{ projectId: "p", key: "ZZ-1", title: "Other work", agent: "claude-code", state: "working", startedAt: 1, branch: null }] })
  ]);
  const plain = await call("list_devices", {});
  expect(plain.available).toBe(true);
  expect(plain.devices[0]).toMatchObject({ name: "Studio", thisComputer: true, platform: "macos", online: true });
  expect(plain.devices[1]).toMatchObject({ id: "win-b", name: "Tower", platform: "windows", agents: [{ id: "claude-code", ready: true }], acceptsWork: { on: true, projects: "all", ceiling: "edits", sessionsAtOnce: 1 } });
  expect(plain.devices[5]).toMatchObject({ online: false, lastSeen: new Date(1_700_000_000_000).toISOString(), workingOn: [{ key: "ZZ-1", state: "working" }] });
  // Without a ticket nothing is said of taking one.
  expect(plain.devices.every((d: any) => !("canTake" in d))).toBe(true);

  const forTicket = await call("list_devices", { key: ticket.key.toLowerCase() });
  const take = Object.fromEntries(forTicket.devices.map((d: any) => [d.id, d.canTake === undefined ? null : d.canTake ? true : d.why]));
  expect(take).toMatchObject({ "mac-a": null, "win-b": true });
  expect(take["win-off"]).toMatch(/does not accept work/);
  expect(take["win-picky"]).toMatch(/not for this project/);
  expect(take["win-bare"]).toMatch(/no coding agent/);
  expect(take["win-asleep"]).toMatch(/waits for it/);
  await expect(call("list_devices", { key: "NOPE-999" })).rejects.toThrow(/no ticket NOPE-999/);
});

it("says why when the account's computers cannot be read, without failing", async () => {
  expect(await (await desk([], "signed-out")).call("list_devices", {})).toMatchObject({ available: false, why: expect.stringMatching(/Nobody is signed in/) });
  await cleanup();
  const over = await desk([], "over-limit");
  expect(await over.call("list_devices", {})).toMatchObject({ available: false, why: expect.stringMatching(/no place for this computer \(2 computers\)/) });
  expect(await over.call("dispatch_ticket", { key: over.ticket.key, to: "win-b", userSaid: "yes, send it" })).toMatchObject({ sent: false, why: expect.stringMatching(/no place for this computer/) });
  await cleanup();
  // No account service at all.
  const bare = await desk([]);
  Object.assign(bare.a.ctx.get("cloudHub") as object, { devicesInfo: undefined });
  expect(await bare.call("list_devices", {})).toMatchObject({ available: false, why: expect.stringMatching(/no account service/) });
});

it("sends a ticket only with the person's yes", async () => {
  const { a, ticket, call, questions } = await desk([device("win-b", { name: "Tower" })]);
  // Asked, and they say no; or they close the question.
  expect(await call("dispatch_ticket", { key: ticket.key, to: "Tower" }, "Don't send")).toMatchObject({ sent: false, why: expect.stringMatching(/said no/) });
  expect(await call("dispatch_ticket", { key: ticket.key, to: "Tower" }, null)).toMatchObject({ sent: false });
  expect(questions[0]).toBe(`Send ${ticket.key} “Faster on Windows” to Tower? A coding agent starts on it there, with that computer's own sign-in and within the limits that computer set.`);
  // Nobody to ask, and no word of theirs: nothing goes, and the agent is told to ask.
  await expect(call("dispatch_ticket", { key: ticket.key, to: "Tower" })).rejects.toThrow(/cannot ask the person from here.*userSaid/s);
  expect(a.queue.list()).toEqual([]);

  const sent = await call("dispatch_ticket", { key: ticket.key, to: "tower" }, "Send");
  expect(sent).toMatchObject({ sent: true, key: ticket.key, to: "Tower", state: "queued" });
  expect(a.queue.list()).toMatchObject([{ id: sent.id, toDevice: "win-b", toPlatform: null, fromDevice: "mac-a", state: "queued", wish: {} }]);
  // This machine started nothing itself, and the ticket did not move.
  expect(a.code.starts).toEqual([]);
  expect(a.items.get(a.project.id, ticket.id)!.status).toBe("todo");
  // It shows among what was sent.
  expect((await call("list_devices", { key: ticket.key })).sent).toMatchObject([{ id: sent.id, key: ticket.key, to: "Tower", state: "queued" }]);
});

it("where nobody can be asked, the person's own words send it; a platform stands for any computer of it", async () => {
  const { a, ticket, call } = await desk([device("win-b", { name: "Tower", online: false })]);
  const sent = await call("dispatch_ticket", { key: ticket.key, platform: "windows", userSaid: "yes, run it on the Windows box" });
  expect(sent).toMatchObject({ sent: true, to: "any Windows computer", state: "queued", waits: expect.stringMatching(/No Windows computer is free right now/) });
  expect(a.queue.list()).toMatchObject([{ toDevice: null, toPlatform: "win32" }]);
  await expect(call("dispatch_ticket", { key: ticket.key, to: "Tower", platform: "windows", userSaid: "yes" })).rejects.toThrow(/not both/);
  await expect(call("dispatch_ticket", { key: ticket.key, userSaid: "yes" })).rejects.toThrow(/not both/);
});

it("does not send to a computer that cannot take it, and asks nobody about it", async () => {
  const { a, ticket, call, questions } = await desk([device("win-off", { name: "Tower", accept: { ...ACCEPT, on: false } }), device("win-bare", { name: "Bare", agents: [] })]);
  expect(await call("dispatch_ticket", { key: ticket.key, to: "Tower" }, "Send")).toMatchObject({ sent: false, why: expect.stringMatching(/Tower cannot take it: it does not accept work/) });
  expect(await call("dispatch_ticket", { key: ticket.key, to: "Nowhere" }, "Send")).toMatchObject({ sent: false, computers: ["Tower", "Bare"] });
  expect(await call("dispatch_ticket", { key: ticket.key, platform: "windows" }, "Send")).toMatchObject({ sent: false, why: expect.stringMatching(/No Windows computer can take it: Tower — .*; Bare — no coding agent/) });
  expect(await call("dispatch_ticket", { key: ticket.key, platform: "linux" }, "Send")).toMatchObject({ sent: false, why: "The account has no other Linux computer." });
  expect(questions).toEqual([]);
  expect(a.queue.list()).toEqual([]);
});

it("takes a sent ticket back", async () => {
  const { a, ticket, call } = await desk([device("win-b", { name: "Tower" })]);
  expect(await call("cancel_dispatch", { key: ticket.key })).toMatchObject({ cancelled: false, why: expect.stringMatching(/No request/) });
  const sent = await call("dispatch_ticket", { key: ticket.key, to: "Tower" }, "Send");
  expect(await call("cancel_dispatch", { key: ticket.key })).toMatchObject({ cancelled: true, id: sent.id, state: "cancelled" });
  expect(a.queue.list()).toMatchObject([{ id: sent.id, state: "cancelled" }]);
  // Nothing is left to take back.
  expect(await call("cancel_dispatch", { key: ticket.key })).toMatchObject({ cancelled: false });
});

it("leaves whether this machine accepts work to the person", async () => {
  const { a } = await desk([]);
  expect(a.ctx.tools.list().map((t) => t.name).filter((name) => /device|dispatch/.test(name)).sort()).toEqual(["cancel_dispatch", "dispatch_ticket", "list_devices"]);
  // Sending from here turned nothing on here.
  expect(a.s.policy().accept).toBe(false);
});
