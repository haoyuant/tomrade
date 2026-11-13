import { afterAll, beforeAll, expect, it } from "vitest";
import { account, type Account } from "./world.js";

// The real migrations in PostgreSQL (WASM). An app from before roles claims with two arguments; one that knows roles
// says so with the third.
let acct: Account;
beforeAll(async () => {
  acct = await account();
  for (const device of ["mac-a", "mac-b", "mac-c"]) await acct.register(device, "darwin");
}, 60_000);
afterAll(async () => { await acct.close(); });

interface Row { id: string; state: string }
const rpc = async (name: string, args: Record<string, unknown>) => {
  const { data, error } = await acct.client().rpc(name, args);
  if (error) throw new Error(error.message);
  return data as Row | null;
};
const send = async (key: string, to: string | null, wish: Record<string, string>) =>
  (await rpc("tomrade_create_dispatch", { p_from: "mac-a", p_to: to, p_platform: to ? null : "darwin", p_project: "p-0001", p_key: key, p_title: key, p_wish: wish }))!;
const older = (id: string, device: string) => rpc("tomrade_claim_dispatch", { p_id: id, p_device: device });
const newer = (id: string, device: string) => rpc("tomrade_claim_dispatch", { p_id: id, p_device: device, p_roles: true });
const now = async (id: string) => (await acct.admin<{ state: string; reason: string | null; claimed_by: string | null }>("select state, reason, claimed_by from public.tomrade_dispatches where id = $1", [id]))[0];

it("leaves a request with a role, made for a platform, to a machine that knows roles", async () => {
  const sent = await send("AL-1", null, { role: "role-0001" });
  await expect(older(sent.id, "mac-b")).resolves.toBeNull();
  await expect(now(sent.id)).resolves.toEqual({ state: "queued", reason: null, claimed_by: null });
  await expect(newer(sent.id, "mac-c")).resolves.toMatchObject({ state: "accepted" });
  await expect(now(sent.id)).resolves.toMatchObject({ state: "accepted", claimed_by: "mac-c" });
});

it("refuses a request with a role addressed to a machine whose app is from before roles, and says why", async () => {
  const sent = await send("AL-2", "mac-b", { role: "role-0001" });
  // Another machine's older app asking changes nothing: the request is not for it.
  await expect(older(sent.id, "mac-c")).resolves.toBeNull();
  await expect(now(sent.id)).resolves.toMatchObject({ state: "queued" });
  await expect(older(sent.id, "mac-b")).resolves.toBeNull();
  await expect(now(sent.id)).resolves.toEqual({ state: "refused", reason: "outdated", claimed_by: null });
  // Over: an updated app there does not get it either, and the ticket can be sent again.
  await expect(newer(sent.id, "mac-b")).resolves.toBeNull();
  await expect(send("AL-2", "mac-b", { role: "role-0001" })).resolves.toMatchObject({ state: "queued" });
});

it("gives a request without a role to either, as before", async () => {
  const first = await send("AL-3", "mac-b", { engine: "claude-code" });
  await expect(older(first.id, "mac-b")).resolves.toMatchObject({ state: "accepted" });
  const second = await send("AL-4", null, {});
  await expect(newer(second.id, "mac-c")).resolves.toMatchObject({ state: "accepted" });
});
