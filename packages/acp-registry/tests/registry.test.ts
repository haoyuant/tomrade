/**
 * The ACP registry as Tomrade reads it: only well-formed npx entries are
 * offered, an added entry becomes a local-agent spec and survives in settings,
 * and the cached listing answers when the CDN does not.
 */
import os from "node:os";
import path from "node:path";
import { Context } from "cordis";
import { expect, it } from "vitest";
import { Settings } from "@tomradex/settings";
import { LocalAgents } from "@tomradex/engine-acp";
import AcpRegistry, { addedOf, NpxPackage, packageOf, parseRegistry, RegistryAgent, specOf, type AddedAgent } from "@tomradex/acp-registry";

const manifest = (over: Record<string, unknown> = {}) => ({
  id: "opencode",
  name: "OpenCode",
  version: "1.2.3",
  description: "Terminal coding agent",
  license: "MIT",
  repository: "https://github.com/sst/opencode",
  distribution: { npx: { package: "opencode-ai", args: ["acp"] } },
  ...over
});

it("offers only well-formed entries with an npx distribution", () => {
  const agents = parseRegistry({
    agents: [manifest(), { id: "BAD ID", name: "X", distribution: {} }, manifest({ id: "binary-only", distribution: { binary: {} } }), "junk"]
  });
  expect(agents.map((a) => a.id)).toEqual(["opencode"]);
  expect(parseRegistry("junk")).toEqual([]);
  expect(parseRegistry({ agents: "junk" })).toEqual([]);
});

it("turns a manifest into the spec a plugin would declare", () => {
  const added = addedOf(RegistryAgent.parse(manifest()));
  const spec = specOf(added);
  expect(spec.id).toBe("registry:opencode");
  expect(spec.title).toBe("OpenCode");
  expect(spec.cli.name).toBe("npx");
  expect(spec.acp!.args({} as never)).toEqual(["--yes", "--prefer-offline", "opencode-ai", "acp"]);
  expect(spec.acp!.env).toBeUndefined();
  expect(spec.setup?.install).toEqual([{ npm: "opencode-ai" }]);
  expect(spec.setup?.docs).toBe("https://github.com/sst/opencode");
});

it("hands the agent its declared environment", () => {
  const entry = RegistryAgent.parse(manifest({ distribution: { npx: { package: "x", env: { ACP_MODE: "stdio" } } } }));
  const spec = specOf(addedOf(entry));
  expect(spec.acp!.env!({} as never)).toEqual({ ACP_MODE: "stdio" });
});

async function boot(answer: () => unknown) {
  const ctx = new Context();
  await ctx.plugin(Settings, { path: path.join(os.tmpdir(), `tomrade-registry-${Date.now()}-${Math.random()}.json`) });
  await ctx.plugin(LocalAgents);
  await ctx.plugin(AcpRegistry);
  let asked = 0;
  ctx.acpRegistry.fetcher = (async () => {
    asked += 1;
    const raw = answer();
    if (raw instanceof Error) throw raw;
    return { ok: true, json: async () => raw };
  }) as unknown as typeof fetch;
  return { ctx, asked: () => asked };
}

it("lists from one fetch and answers the next look from the cache", async () => {
  const { ctx, asked } = await boot(() => ({ agents: [manifest()] }));
  const first = await ctx.acpRegistry.list();
  expect(first.state).toBe("ok");
  expect(first.agents).toEqual([{ id: "opencode", name: "OpenCode", description: "Terminal coding agent", version: "1.2.3", license: "MIT", added: false }]);
  await ctx.acpRegistry.list();
  expect(asked()).toBe(1);
});

it("says the registry is unavailable rather than showing an empty catalog", async () => {
  const { ctx, asked } = await boot(() => new Error("offline"));
  expect(await ctx.acpRegistry.list()).toEqual({ state: "unavailable", agents: [] });
  expect(asked()).toBe(1);
});

it("adding registers the agent, keeps its manifest in settings, and removing takes it back out", async () => {
  const { ctx } = await boot(() => ({ agents: [manifest()] }));
  const registered: string[] = [];
  const removed: string[] = [];
  const owns: unknown[] = [];
  (ctx.localAgents as unknown as { register(spec: { id: string }, own: unknown): () => void }).register = (spec, own) => {
    registered.push(spec.id);
    owns.push(own);
    return () => removed.push(spec.id);
  };
  await ctx.acpRegistry.list();
  expect(ctx.acpRegistry.add("opencode")).toBe(true);
  expect(registered).toEqual(["registry:opencode"]);
  // Found once its package is installed, and signed in the way the agent lists.
  expect(owns[0]).toMatchObject({ cli: expect.any(NpxPackage), acpAuth: true });
  expect((owns[0] as { cli: NpxPackage }).cli.pkg).toBe("opencode-ai");
  const kept = (ctx.settings.get().acpRegistry as { added: AddedAgent[] }).added;
  expect(kept).toHaveLength(1);
  expect(kept[0]).toMatchObject({ id: "opencode", package: "opencode-ai", args: ["acp"] });
  expect((await ctx.acpRegistry.list()).agents[0]).toMatchObject({ added: true });
  expect(ctx.acpRegistry.remove("opencode")).toBe(true);
  expect(removed).toEqual(["registry:opencode"]);
  expect((await ctx.acpRegistry.list()).agents[0]).toMatchObject({ added: false });
  expect(ctx.acpRegistry.remove("opencode")).toBe(false);
});

it("adds nothing the registry does not offer", async () => {
  const { ctx } = await boot(() => ({ agents: [manifest()] }));
  await ctx.acpRegistry.list();
  expect(ctx.acpRegistry.add("nope")).toBe(false);
});

it("reads a pinned package as its name and version", () => {
  expect(packageOf("@agentclientprotocol/claude-agent-acp@0.94.0")).toEqual({ name: "@agentclientprotocol/claude-agent-acp", version: "0.94.0" });
  expect(packageOf("pi-acp@0.0.34")).toEqual({ name: "pi-acp", version: "0.0.34" });
  expect(packageOf("@scope/name")).toEqual({ name: "@scope/name" });
});

it("does not offer an adapter of an agent Tomrade already has under another name", async () => {
  const { ctx } = await boot(() => ({ agents: ["claude-acp", "pi-acp", "codebuddy-code", "opencode"].map((id) => manifest({ id, name: id })) }));
  ctx.provide("agent", { allEngines: () => [{ id: "claude-code", title: "Claude Code" }, { id: "pi", title: "Pi" }, { id: "workbuddy", title: "WorkBuddy" }] } as never);
  expect((await ctx.acpRegistry.list()).agents.map((a) => a.id)).toEqual(["opencode"]);
});

it("moves an added agent to the version the registry pins when it is read again", async () => {
  let version = "1.2.3";
  const { ctx } = await boot(() => ({ agents: [manifest({ version, distribution: { npx: { package: `opencode-ai@${version}`, args: ["acp"] } } })] }));
  const registered: string[] = [];
  const removed: string[] = [];
  (ctx.localAgents as unknown as { register(spec: { id: string; acp: { args(o: unknown): string[] } }): () => void }).register = (spec) => {
    registered.push(spec.acp.args({}).join(" "));
    return () => removed.push(spec.id);
  };
  await ctx.acpRegistry.list();
  ctx.acpRegistry.add("opencode");
  version = "1.3.0";
  // The cache still answers: nothing moves until the registry is read.
  await ctx.acpRegistry.list();
  expect((ctx.settings.get().acpRegistry as { added: AddedAgent[] }).added[0]!.version).toBe("1.2.3");
  await ctx.acpRegistry.list(true);
  expect((ctx.settings.get().acpRegistry as { added: AddedAgent[] }).added[0]).toMatchObject({ version: "1.3.0", package: "opencode-ai@1.3.0" });
  expect(registered).toEqual(["--yes --prefer-offline opencode-ai@1.2.3 acp", "--yes --prefer-offline opencode-ai@1.3.0 acp"]);
  expect(removed).toEqual(["registry:opencode"]);
  // Read again with nothing new, it stays as it is.
  await ctx.acpRegistry.list(true);
  expect(registered).toHaveLength(2);
});
