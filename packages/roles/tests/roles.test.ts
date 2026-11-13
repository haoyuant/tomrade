import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import type { Context } from "cordis";
import { Agent, type Engine } from "@tomradex/agent";
import { IMPLEMENTER, REVIEWER, Roles, levelOf, modeWithin } from "@tomradex/roles";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { disposeFresh, fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-roles-"));
afterAll(async () => {
  await disposeFresh();
  fs.rmSync(root, { recursive: true, force: true });
});

let n = 0;
async function machine(opts: { locale?: string; storage?: boolean } = {}) {
  const hubDir = path.join(root, `hub-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  fs.writeFileSync(path.join(hubDir, "settings.json"), JSON.stringify({ language: opts.locale ?? "en" }));
  const engine = (id: string, modes: string[]): Engine => ({
    id, title: id, author: `ai:${id}`, capabilities: ["backlog", "code"],
    ...(modes.length ? { permissionModes: { default: modes.at(-1)!, choices: modes.map((value) => ({ value, label: value })) } } : {}),
    available: async () => ({ ok: true }),
    turn: async () => ({ stop: "end" })
  });
  const engines = { name: "engines", inject: ["agent"], apply: (ctx: Context) => { ctx.agent.engine(engine("claude-code", ["plan", "default", "acceptEdits", "bypassPermissions"])); ctx.agent.engine(engine("codex", ["read-only", "workspace", "full-access"])); ctx.agent.engine(engine("bare", [])); } };
  const bag = await fresh({
    hubDir,
    plugins: [Tools, [Settings, { path: path.join(hubDir, "settings.json") }], ...(opts.storage ? [[Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }] as [typeof Storage, object]] : []), Agent, engines, Roles]
  });
  await settle();
  const ctx = bag.ctx as Context;
  return { ...bag, ctx, hubDir, roles: ctx.roles, projectId: bag.project.id };
}

it("gives every project an implementer that leaves the choices to Start, and a reviewer that changes nothing", async () => {
  const t = await machine();
  expect(t.roles.list(t.projectId)).toEqual([
    { id: IMPLEMENTER, title: "Implementer", stage: "implement", engines: [], permission: null, instructions: "", needs: {}, builtin: true, changed: false, updatedAt: null },
    { id: REVIEWER, title: "Reviewer", stage: "review", engines: [], permission: "read", instructions: "", needs: {}, builtin: true, changed: false, updatedAt: null }
  ]);
  expect(t.roles.get(t.projectId, "absent")).toBeNull();
  expect(t.roles.orDefault(t.projectId, "absent", "implement").id).toBe(IMPLEMENTER);
  expect(t.roles.orDefault(t.projectId, null, "review").id).toBe(REVIEWER);
  // a role of the other stage is not the one to fall back on
  expect(t.roles.orDefault(t.projectId, REVIEWER, "implement").id).toBe(IMPLEMENTER);
  expect(t.roles.list("no-such-project")).toEqual([]);
  await t.ctx.fiber.dispose();

  const zh = await machine({ locale: "zh" });
  expect(zh.roles.list(zh.projectId).map((role) => role.title)).toEqual(["实现者", "审查者"]);
  await zh.ctx.fiber.dispose();
});

it("keeps a project's own roles: made, changed, told to whoever listens, and removed", async () => {
  const t = await machine();
  const heard: string[] = [];
  t.ctx.on("roles/changed", (projectId) => void heard.push(projectId));
  const made = t.roles.save(t.projectId, { title: "  Windows perf  ", engines: ["codex", " claude-code ", "codex"], permission: "edits", instructions: "  Measure before and after.  ", needs: { platform: "win32", device: " Tower " } });
  expect(made).toMatchObject({ title: "Windows perf", stage: "implement", engines: ["codex", "claude-code"], permission: "edits", instructions: "Measure before and after.", needs: { platform: "win32", device: "Tower" }, builtin: false, changed: false });
  expect(t.roles.list(t.projectId).map((role) => role.id)).toEqual([IMPLEMENTER, REVIEWER, made.id]);

  const changed = t.roles.save(t.projectId, { id: made.id, title: "Windows perf", permission: null });
  expect(changed).toMatchObject({ id: made.id, engines: ["codex", "claude-code"], permission: null, instructions: "Measure before and after." });

  expect(() => t.roles.save(t.projectId, { title: "  " })).toThrow("A role needs a name.");
  expect(() => t.roles.save(t.projectId, { title: "windows PERF" })).toThrow("Another role is already called windows PERF.");
  expect(() => t.roles.save(t.projectId, { title: "Reviewer" })).toThrow("Another role is already called Reviewer.");
  expect(() => t.roles.save(t.projectId, { id: "absent", title: "X" })).toThrow("This project has no role absent.");
  expect(() => t.roles.save(t.projectId, { title: "Typo", engines: ["not an id!"] })).toThrow("not an id! is not the id of a coding agent.");
  // an engine this machine has never heard of may be another machine's
  expect(t.roles.save(t.projectId, { title: "Elsewhere", engines: ["gemini"] }).engines).toEqual(["gemini"]);
  // a needed platform nobody has is dropped, not kept as nonsense
  expect(t.roles.save(t.projectId, { title: "Odd", needs: { platform: "beos" } }).needs).toEqual({});

  expect(t.roles.remove(t.projectId, made.id)).toBe(true);
  expect(t.roles.remove(t.projectId, made.id)).toBe(false);
  expect(t.roles.get(t.projectId, made.id)).toBeNull();
  expect(heard.length).toBe(5);
  await t.ctx.fiber.dispose();
});

it("lets a built-in role be changed and put back, never removed or moved to the other stage", async () => {
  const t = await machine();
  const changed = t.roles.save(t.projectId, { id: IMPLEMENTER, title: "Builder", engines: ["codex"], permission: "edits" });
  expect(changed).toMatchObject({ id: IMPLEMENTER, title: "Builder", stage: "implement", engines: ["codex"], permission: "edits", builtin: true, changed: true });
  expect(() => t.roles.save(t.projectId, { id: IMPLEMENTER, title: "Builder", stage: "review" })).toThrow("Builder is built in: its stage cannot change.");
  // a review changes nothing, whatever is asked for it
  expect(t.roles.save(t.projectId, { id: REVIEWER, title: "Reviewer", permission: "full", engines: ["codex"] })).toMatchObject({ permission: "read", engines: ["codex"], changed: true });
  expect(t.roles.save(t.projectId, { title: "Security review", stage: "review", permission: "edits" })).toMatchObject({ stage: "review", permission: "read" });

  expect(t.roles.remove(t.projectId, IMPLEMENTER)).toBe(true);
  expect(t.roles.get(t.projectId, IMPLEMENTER)).toMatchObject({ title: "Implementer", engines: [], permission: null, builtin: true, changed: false });
  expect(t.roles.remove(t.projectId, IMPLEMENTER)).toBe(false);
  await t.ctx.fiber.dispose();
});

it("names the permission mode a role's session starts in: the engine's most within the role's limit", async () => {
  const t = await machine();
  const role = (permission: "read" | "ask" | "edits" | "full" | null) => t.roles.save(t.projectId, { id: IMPLEMENTER, title: "Implementer", permission }).id;
  expect(t.roles.modeFor(t.projectId, role(null), "claude-code")).toBeNull();
  expect(t.roles.modeFor(t.projectId, role("read"), "claude-code")).toBe("plan");
  expect(t.roles.modeFor(t.projectId, role("ask"), "claude-code")).toBe("default");
  expect(t.roles.modeFor(t.projectId, role("edits"), "codex")).toBe("workspace");
  expect(t.roles.modeFor(t.projectId, role("full"), "codex")).toBe("full-access");
  // codex has nothing between reading and editing
  expect(t.roles.modeFor(t.projectId, role("ask"), "codex")).toBe("read-only");
  expect(t.roles.modeFor(t.projectId, role("edits"), "bare")).toBeNull();
  expect(t.roles.modeFor(t.projectId, role("edits"), "absent")).toBeNull();
  expect(t.roles.modeFor(t.projectId, REVIEWER, "codex")).toBe("read-only");
  // a mode nobody can vouch for counts as the most
  expect(levelOf("mystery")).toBe("full");
  expect(modeWithin("read", ["workspace"])).toBeNull();
  await t.ctx.fiber.dispose();
});

it("writes the project's roles into its folder, where its other machines read them", async () => {
  const t = await machine({ storage: true });
  await t.ctx.storage.ready;
  const made = t.roles.save(t.projectId, { title: "Docs", instructions: "Plain words." });
  await t.ctx.storage.flushAll("test");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(at);
      else if (at.endsWith(path.join("plugins", "roles", "plugin_roles_roles.jsonl")) || at.endsWith(path.join("plugins", "roles", "roles.jsonl"))) found.push(at);
    }
  };
  walk(t.hubDir);
  expect(found).toHaveLength(1);
  const rows = fs.readFileSync(found[0]!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { id: string; title: string; instructions: string });
  expect(rows).toEqual([expect.objectContaining({ id: made.id, title: "Docs", instructions: "Plain words." })]);
  // nothing of a machine is in them
  expect(JSON.stringify(rows)).not.toContain(os.homedir());
  await t.ctx.fiber.dispose();
});
