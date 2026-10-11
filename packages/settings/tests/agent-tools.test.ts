import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Settings } from "@tomradex/settings";
import { Tools, type RunHandle, type ToolInvocation } from "@tomradex/tools";
import { fresh } from "@tomradex/testkit";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-settings-agent-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;

const run = (id: string, projectId: string): RunHandle => ({
  id, threadId: "thread", projectId, author: "ai:loop", ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map()
});

async function boot() {
  const bag = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, `settings-${n++}.json`) }]] });
  const { ctx, project } = bag;
  ctx.settings.register({
    id: "pet", title: "Pet", agent: "write",
    schema: z.object({ enabled: z.boolean(), size: z.enum(["small", "medium", "large"]) }),
    defaults: { enabled: true, size: "medium" }
  });
  ctx.settings.register({
    id: "models", title: "Models",
    schema: z.object({ profiles: z.array(z.object({ id: z.string(), apiKey: z.string(), model: z.string() })), headers: z.record(z.string(), z.string()) }),
    defaults: { profiles: [], headers: {} }
  });
  ctx.settings.register({ id: "github", title: "GitHub", agent: "write", schema: z.object({ token: z.string().meta({ format: "password" }) }), defaults: { token: "" } });
  const inv: ToolInvocation = { by: "ai:loop", projectId: project.id, run: run("run-1", project.id) };
  const call = (name: string, args: unknown, invocation = inv) => ctx.tools.execute(name, args, invocation);
  return { ...bag, inv, call };
}

describe("settings as agent tools", () => {
  it("lists every section with what an agent may do, and never shows a secret", async () => {
    const { ctx, call } = await boot();
    ctx.settings.set({ ...ctx.settings.get(), models: { profiles: [{ id: "ds", apiKey: "sk-live", model: "deepseek-chat" }, { id: "local", apiKey: "", model: "qwen" }], headers: { "X-Org": "acme" } }, github: { token: "ghp_x" } });
    const { sections } = (await call("get_settings", {})) as { sections: { id: string; access: string; value?: unknown }[] };
    const byId = Object.fromEntries(sections.map((s) => [s.id, s]));
    expect(byId.theme).toMatchObject({ access: "write", value: "dawn" });
    expect(byId.pet).toMatchObject({ access: "write", value: { enabled: true, size: "medium" } });
    // Unannounced means read; a password field means none, whatever the section says.
    expect(byId.models!.access).toBe("read");
    expect(byId.models!.value).toEqual({ profiles: [{ id: "ds", apiKey: "[hidden]", model: "deepseek-chat" }, { id: "local", apiKey: "", model: "qwen" }], headers: { "X-Org": "[hidden]" } });
    expect(byId.github).toEqual({ id: "github", title: "GitHub", access: "none" });
    expect(JSON.stringify(sections)).not.toContain("sk-live");
    expect(JSON.stringify(sections)).not.toContain("ghp_x");

    const one = (await call("get_settings", { section: "pet" })) as { schema: { properties: Record<string, unknown> } };
    expect(one.schema.properties.size).toMatchObject({ enum: ["small", "medium", "large"] });
    await expect(call("get_settings", { section: "nope" })).rejects.toThrow(/No settings section "nope"/);
  });

  it("changes what is open to it, merges object fields, and refuses the rest", async () => {
    const { ctx, call } = await boot();
    const result = (await call("update_settings", { changes: { theme: "dark", pet: { size: "large" } } })) as { changed: { section: string; before: unknown; after: unknown }[] };
    expect(result.changed).toEqual([
      { section: "theme", title: "Appearance", before: "dawn", after: "dark" },
      { section: "pet", title: "Pet", before: { enabled: true, size: "medium" }, after: { enabled: true, size: "large" } }
    ]);
    expect(ctx.settings.get().theme).toBe("dark");
    expect(ctx.settings.get().pet).toEqual({ enabled: true, size: "large" });

    await expect(call("update_settings", { changes: { models: { profiles: [] } } })).rejects.toThrow(/Models is the user's to change/);
    await expect(call("update_settings", { changes: { github: { token: "mine" } } })).rejects.toThrow(/GitHub is the user's to change/);
    await expect(call("update_settings", { changes: { pet: { size: "huge" } } })).rejects.toThrow(/pet\.size/);
    // One bad section and nothing lands.
    await expect(call("update_settings", { changes: { language: "zh", theme: "neon" } })).rejects.toThrow(/theme/);
    expect(ctx.settings.get().language).toBe("system");
    expect(await call("update_settings", { changes: { theme: "dark" } })).toMatchObject({ changed: [] });
  });

  it("joins the project's history: undo, redo, and a refusal once the setting moved on", async () => {
    const { ctx, call, project } = await boot();
    await call("update_settings", { changes: { theme: "matcha" } });
    const [record] = await ctx.oplog.timeline(project.id);
    expect(record).toMatchObject({ provider: "settings", entity: "setting", op: "set", label: "Appearance", by: "ai:loop", runId: "run-1", undoable: true, undoneAt: null });

    expect((await ctx.oplog.undo(project.id))?.summary).toBe("Put Appearance back");
    expect(ctx.settings.get().theme).toBe("dawn");
    expect((await ctx.oplog.redo(project.id))?.summary).toBe("Changed Appearance again");
    expect(ctx.settings.get().theme).toBe("matcha");

    ctx.settings.set({ ...ctx.settings.get(), theme: "light" });
    await expect(ctx.oplog.revert(project.id, record!.ref)).rejects.toThrow(/Appearance changed again since/);
    expect(ctx.settings.get().theme).toBe("light");
  });

  it("counts toward the run and goes with its Undo", async () => {
    const { ctx, call, project, inv } = await boot();
    await call("update_settings", { changes: { theme: "dark" } });
    await call("update_settings", { changes: { pet: { enabled: false }, language: "zh" } });
    await call("update_settings", { changes: { theme: "light" } }, { ...inv, run: run("run-2", project.id) });
    expect(ctx.oplog.runChanges(project.id, "run-1")).toEqual([
      { key: "Appearance", label: "dawn → dark", op: "updated" },
      { key: "Pet", label: "enabled → false", op: "updated" },
      { key: "Language", label: "system → zh", op: "updated" }
    ]);

    // run-2 moved the theme on after run-1, so run-1's theme stays where it is now.
    const result = ctx.oplog.undoRun(project.id, "run-1");
    expect(result.reverted).toBe(2);
    expect(result.kept).toEqual([expect.objectContaining({ entity: "setting", label: "Appearance", reason: expect.stringMatching(/changed again since/) })]);
    expect(ctx.settings.get()).toMatchObject({ theme: "light", language: "system", pet: { enabled: true } });
  });

  it("keeps a value it was shown as hidden when an agent writes it back", async () => {
    const { ctx, call } = await boot();
    ctx.settings.register({
      id: "relay", title: "Relay", agent: "write",
      schema: z.object({ url: z.string(), apiKey: z.string() }),
      defaults: { url: "", apiKey: "" }
    });
    ctx.settings.set({ ...ctx.settings.get(), relay: { url: "https://a", apiKey: "k-1" } });
    const shown = (await call("get_settings", { section: "relay" })) as { value: { url: string; apiKey: string } };
    expect(shown.value.apiKey).toBe("[hidden]");
    await call("update_settings", { changes: { relay: { ...shown.value, url: "https://b" } } });
    expect(ctx.settings.get().relay).toEqual({ url: "https://b", apiKey: "k-1" });
  });

  it("applies without a project, and then leaves no history behind", async () => {
    const { ctx, call, project } = await boot();
    await call("update_settings", { changes: { language: "en" } }, { by: "ai:claude-code" });
    expect(ctx.settings.get().language).toBe("en");
    expect((await ctx.oplog.timeline(project.id)).filter((r) => r.provider === "settings")).toEqual([]);
  });
});
