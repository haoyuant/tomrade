/**
 * A machine shared with another person, over the account server's real SQL: the owner's machine and the other
 * person's are machines of two accounts that hold the same project by its folder.
 */
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { OWNER_EMAIL, account, cleanup, machine, share, type Account, type Machine } from "./world.js";

let owner: Account;
beforeAll(async () => { owner = await account(); }, 60_000);
afterEach(async () => {
  await cleanup();
  await owner.admin("delete from public.tomrade_dispatches");
  await owner.admin("delete from public.tomrade_devices");
  await owner.admin("delete from auth.users where email <> $1", [OWNER_EMAIL]);
});
afterAll(async () => { await owner.close(); });

let n = 0;
/** The owner's machine, and another person's with a ticket of a project both hold. */
async function two() {
  const email = `guest-${n++}@example.test`;
  const other = await owner.guest(email);
  const theirs = await machine(other, "guest-mac");
  const ticket = theirs.items.create({ projectId: theirs.project.id, boardId: theirs.board.id, title: "Faster on Windows", status: "todo", workType: "coding", by: "human" });
  const mine = await machine(owner, "owner-win");
  await share(theirs, mine, theirs.project.id);
  return { email, theirs, mine, ticket, projectId: theirs.project.id };
}
const states = (m: Machine) => m.queue.list().map((d) => `${d.key}:${d.state}${d.reason ? ` (${d.reason})` : ""}`);

it("the owner shares this machine with one person, who then sees it and little of it", async () => {
  const { email, theirs, mine } = await two();
  expect(await mine.queue.shares()).toEqual([]);
  expect(await theirs.queue.shared()).toEqual([]);
  expect(await mine.queue.share({ email: email.toUpperCase(), ceiling: "ask", auto: false })).toEqual([{ email, ceiling: "ask", auto: false }]);
  const seen = await theirs.queue.shared();
  expect(seen).toMatchObject([{ owner: OWNER_EMAIL, deviceId: "owner-win", name: "owner-win", ceiling: "ask", auto: false }]);
  expect(Object.keys(seen[0]!).sort()).toEqual(["accept", "agents", "auto", "ceiling", "deviceId", "lastSeenAt", "name", "owner", "platform", "share"]);
  // changed in place, and taken back
  expect(await mine.queue.share({ email, ceiling: "edits", auto: true })).toEqual([{ email, ceiling: "edits", auto: true }]);
  expect(await mine.queue.unshare(email)).toEqual([]);
  expect(await theirs.queue.shared()).toEqual([]);
  // the other way round there is nothing: sharing is the owner's alone
  expect(await mine.queue.shared()).toEqual([]);
}, 60_000);

it("a ticket from that person waits for the owner's yes, and then starts within the lowest of the limits", async () => {
  const { email, theirs, mine, ticket, projectId } = await two();
  await mine.queue.share({ email, ceiling: "ask", auto: false });
  const [device] = await theirs.queue.shared();
  const sent = await theirs.queue.send({ projectId, itemId: ticket.id, share: device!.share });
  expect(sent).toMatchObject({ state: "queued", toDevice: "owner-win", fromEmail: email, needsYes: true, approved: false, ceiling: "ask" });

  // The owner's machine takes work from the account's own machines: that says nothing of this one.
  mine.accept();
  await mine.queue.tick();
  await mine.queue.tick();
  expect(mine.code.starts).toEqual([]);
  expect(mine.queue.asks()).toMatchObject([{ id: sent.id, fromEmail: email, key: ticket.key, title: "Faster on Windows" }]);
  expect(states(mine)).toEqual([`${ticket.key}:queued`]);
  // The other person's machine has nothing to answer.
  expect(theirs.queue.asks()).toEqual([]);

  await mine.queue.approve(sent.id);
  expect(mine.queue.asks()).toEqual([]);
  // The machine allows edits, the owner lets this person's tickets ask before each change: the lower holds.
  expect(mine.code.starts).toEqual([{ projectId, itemId: ticket.id, opts: { mode: "run", engine: "claude-code", permissionMode: "default", source: { dispatch: sent.id, device: "guest-mac", from: email } } }]);
  expect(mine.s.recent()).toMatchObject([{ from: email, key: ticket.key, accepted: true, permissionMode: "default" }]);
  await theirs.queue.tick();
  expect(theirs.queue.list()).toMatchObject([{ id: sent.id, state: "running", claimedBy: "owner-win" }]);
  [...mine.code.sessions.values()][0]!.state = "idle";
  await mine.queue.tick();
  await theirs.queue.tick();
  expect(states(theirs)).toEqual([`${ticket.key}:done`]);
}, 60_000);

it("a yes from the owner is enough where the machine takes nothing unasked, and a no is read by the person who asked", async () => {
  const { email, theirs, mine, ticket, projectId } = await two();
  await mine.queue.share({ email, ceiling: "edits", auto: false });
  const [device] = await theirs.queue.shared();
  // Accepting work from the account's own machines is off, as on every machine until its person says otherwise.
  const first = await theirs.queue.send({ projectId, itemId: ticket.id, share: device!.share });
  await mine.queue.tick();
  await mine.queue.approve(first.id);
  expect(mine.code.starts).toHaveLength(1);
  expect(mine.code.starts[0]!.opts).toMatchObject({ permissionMode: "acceptEdits" });
  [...mine.code.sessions.values()][0]!.state = "idle";
  await mine.queue.tick();

  const second = await theirs.queue.send({ projectId, itemId: ticket.id, share: device!.share });
  await mine.queue.tick();
  await mine.queue.decline(second.id);
  expect(mine.queue.asks()).toEqual([]);
  expect(mine.code.starts).toHaveLength(1);
  await theirs.queue.tick();
  expect(theirs.queue.list().find((d) => d.id === second.id)).toMatchObject({ state: "refused", reason: "declined" });
}, 60_000);

it("needs no yes where the owner said so for that person, and then goes by the machine's own switch", async () => {
  const { email, theirs, mine, ticket, projectId } = await two();
  await mine.queue.share({ email, ceiling: "edits", auto: true });
  const [device] = await theirs.queue.shared();
  const off = await theirs.queue.send({ projectId, itemId: ticket.id, share: device!.share });
  expect(off).toMatchObject({ needsYes: false, approved: true });
  await mine.queue.tick();
  // Nobody said yes to this one by hand: with accepting off, the machine takes nothing unasked.
  expect(mine.queue.list().find((d) => d.id === off.id)).toMatchObject({ state: "refused", reason: "off" });
  expect(mine.queue.asks()).toEqual([]);
  mine.accept();
  const on = await theirs.queue.send({ projectId, itemId: ticket.id, share: device!.share });
  await mine.queue.tick();
  expect(mine.queue.list().find((d) => d.id === on.id)).toMatchObject({ state: "running" });
  expect(mine.code.starts).toHaveLength(1);
}, 60_000);

it("taking the share back stops what that person has running here, and the person who asked may take a request back", async () => {
  const { email, theirs, mine, ticket, projectId } = await two();
  mine.accept();
  await mine.queue.share({ email, ceiling: "edits", auto: true });
  const [device] = await theirs.queue.shared();
  const sent = await theirs.queue.send({ projectId, itemId: ticket.id, share: device!.share });
  await mine.queue.tick();
  expect(mine.code.sessions.size).toBe(1);
  await mine.queue.unshare(email);
  expect(mine.code.stopped).toEqual([[...mine.code.sessions.keys()][0]]);
  expect(mine.queue.list().find((d) => d.id === sent.id)).toMatchObject({ state: "cancelled", reason: "unshared" });
  await theirs.queue.tick();
  expect(states(theirs)).toEqual([`${ticket.key}:cancelled (unshared)`]);
  await expect(theirs.queue.send({ projectId, itemId: ticket.id, share: device!.share })).rejects.toThrow(/No such shared device/);

  // Shared again: a request still waiting is the asker's to take back.
  await mine.queue.share({ email, ceiling: "edits", auto: false });
  const [again] = await theirs.queue.shared();
  const waiting = await theirs.queue.send({ projectId, itemId: ticket.id, share: again!.share });
  await mine.queue.tick();
  expect(mine.queue.asks()).toHaveLength(1);
  await theirs.queue.cancel(waiting.id);
  await mine.queue.tick();
  expect(mine.queue.asks()).toEqual([]);
  expect(mine.code.starts).toHaveLength(1);
}, 60_000);
