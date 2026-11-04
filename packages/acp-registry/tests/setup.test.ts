/**
 * A registry agent set up end to end, against a fake registry, a fake npm and
 * a fake ACP agent behind a fake npx: it needs installing until npm has the
 * pinned package, the install streams npm's lines, sign-in shows the agent's
 * own methods and runs them, and the first turn starts the installed copy.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Agent, type Block, type Engine, type EngineSetupProgress, type TurnIO, type TurnInput } from "@tomradex/agent";
import AgentSetup, { machineSetupHost } from "@tomradex/agent-setup";
import type { AcpSignIn } from "@tomradex/engine-acp";
import { LocalAgents } from "@tomradex/engine-acp";
import { Mcp } from "@tomradex/mcp";
import { Settings } from "@tomradex/settings";
import { Tools } from "@tomradex/tools";
import { fakeProgram, fresh } from "@tomradex/testkit";
import AcpRegistry, { addedOf, NpxPackage, RegistryAgent, specOf } from "@tomradex/acp-registry";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-registry-setup-"));
const bin = path.join(dir, "bin");
const root = path.join(dir, "global");
const log = path.join(dir, "log.jsonl");
const signed = path.join(dir, "signed");
const PATH = process.env.PATH;

beforeAll(() => {
  fs.mkdirSync(bin);
  const wrap = (name: string, script: string) => fakeProgram(path.join(bin, name), `#!/bin/sh\nexec '${process.execPath}' '${path.join(here, script)}' "$@"\n`);
  wrap("npx", "fake-agent.mjs");
  wrap("npm", "fake-npm.mjs");
  Object.assign(process.env, { PATH: `${bin}${path.delimiter}${PATH}`, FAKE_NPM_ROOT: root, FAKE_LOG: log, FAKE_SIGNED: signed });
});
afterAll(() => {
  process.env.PATH = PATH;
  for (const key of ["FAKE_NPM_ROOT", "FAKE_LOG", "FAKE_SIGNED"]) delete process.env[key];
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const entry = (version: string) => ({ id: "fake-agent", name: "Fake Agent", version, description: "", distribution: { npx: { package: `fake-agent@${version}`, args: ["--acp"] } } });
const logged = (): Record<string, any>[] => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);

async function finish(ctx: { agentSetup: AgentSetup }, id: string, first: EngineSetupProgress): Promise<EngineSetupProgress[]> {
  const seen = [first];
  for (const t0 = Date.now(); ; ) {
    const now = ctx.agentSetup.state(id)!;
    if (now !== seen.at(-1)) seen.push(now);
    if (now.phase === "done" || now.phase === "failed") return seen;
    if (Date.now() - t0 > 20_000) throw new Error(`timed out at ${JSON.stringify(now)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const turnIO = () => {
  const blocks: Block[] = [];
  const io: TurnIO = {
    emit: (block) => blocks.push(block), delta: () => {}, progress: () => {}, signal: new AbortController().signal,
    tools: { describe: () => [], execute: async () => ({}) }, llm: null, playbooks: { index: () => [], open: () => null }, workflows: { list: () => [] },
    run: { id: "run", threadId: "thread", projectId: "project", author: "ai:registry:fake-agent", ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map() }
  };
  return { io, blocks };
};
const turnInput = (): TurnInput => ({ threadId: "thread", projectId: "project", purpose: "code", cwd: dir, input: { kind: "text", text: "ping" }, messages: [], cards: [], brief: null, pending: null });

it("installs the pinned package before it counts as found, signs in the agent's way, and follows the registry", async () => {
  const w = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json") }], Agent, [Mcp, { port: 0 }], LocalAgents, AgentSetup, AcpRegistry] });
  const ctx = w.ctx;
  ctx.agentSetup.host = { ...machineSetupHost(), pingRegistry: undefined };
  let version = "1.0.0";
  ctx.acpRegistry.fetcher = (async () => ({ ok: true, json: async () => ({ agents: [entry(version)] }) })) as unknown as typeof fetch;
  await ctx.acpRegistry.list();
  expect(ctx.acpRegistry.add("fake-agent")).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const id = "registry:fake-agent";
  const engine = (): Engine => ctx.agent.engineOf(id)!;

  // npx is there, the package is not: that is an install, not a ready agent.
  let state = await engine().available({ fresh: true });
  expect(state).toMatchObject({ ok: false, need: "install", cli: { name: "fake-agent@1.0.0", state: "missing" } });

  const install = await finish(ctx, id, ctx.agentSetup.start(id, "install"));
  expect(install.some((p) => p.phase === "running" && p.installer === "npm" && p.output?.includes("npm http fetch GET 200"))).toBe(true);
  expect(install.at(-1)).toMatchObject({ phase: "done", version: "1.0.0" });
  expect(logged().find((line) => line.npm)?.npm).toEqual(["install", "-g", "--loglevel", "http", "fake-agent@1.0.0"]);

  // Installed, it is asked how it signs in: no session opens yet.
  state = await engine().available({ fresh: true });
  expect(state).toMatchObject({ ok: false, need: "sign-in", cli: { name: "fake-agent@1.0.0", state: "ready", path: path.join(root, "fake-agent"), version: "1.0.0" } });
  const asked = logged().find((line) => line.method === "initialize");
  expect(asked?.params.clientCapabilities).toMatchObject({ auth: { terminal: true }, _meta: { "terminal-auth": true } });
  // Its terminal method is the agent's own command with the method's args, for the terminal step and the manual guide.
  expect(state.setup?.signIn).toBe(process.platform === "win32"
    ? `$env:FAKE_LOGIN='1'; & '${path.join(bin, "npx.exe")}' '--yes' '--prefer-offline' 'fake-agent@1.0.0' '--acp' '--login'`
    : `FAKE_LOGIN=1 ${path.join(bin, "npx")} --yes --prefer-offline fake-agent@1.0.0 --acp --login`);

  const signIn = await finish(ctx, id, ctx.agentSetup.start(id, "sign-in"));
  const methods = signIn.at(-1)!.methods;
  expect(methods).toEqual([
    { id: "browser", name: "Log in with a browser", description: "Opens your browser", kind: "agent" },
    { id: "terminal-login", name: "Log in from the terminal", kind: "terminal" },
    { id: "key", name: "API key", description: "Set FAKE_KEY", kind: "other" }
  ]);
  expect(signIn.some((p) => p.phase === "waiting" && p.url === "https://example.test/login?code=1" && p.method === "browser")).toBe(true);
  expect(signIn.at(-1)).toMatchObject({ phase: "done", method: "browser" });
  expect(logged().filter((line) => line.method === "authenticate").map((line) => line.params)).toEqual([{ methodId: "browser" }]);
  expect(await engine().available({ fresh: true })).toMatchObject({ ok: true });

  // The first turn runs the installed copy through npx, which needs no registry for it.
  const { io, blocks } = turnIO();
  const result = await engine().turn(turnInput(), io);
  expect(result.stop).toBe("end");
  expect(blocks).toContainEqual({ type: "text", text: "pong" });
  expect(logged().filter((line) => line.argv && !line.argv.includes("--version")).at(-1)?.argv).toEqual(["--yes", "--prefer-offline", "fake-agent@1.0.0", "--acp"]);

  // A newer pin from the registry is a new install.
  version = "1.1.0";
  await ctx.acpRegistry.list(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await engine().available({ fresh: true })).toMatchObject({ ok: false, need: "install", cli: { name: "fake-agent@1.1.0" } });
  await w.ctx.fiber.dispose();
}, 60_000);

it("leaves a terminal method to the terminal and notices when it is done; a turn told to sign in counts it signed out", async () => {
  fs.rmSync(signed, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
  const w = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings-2.json") }], Agent, [Mcp, { port: 0 }], LocalAgents, AgentSetup, AcpRegistry] });
  const ctx = w.ctx;
  ctx.agentSetup.host = { ...machineSetupHost(), pingRegistry: undefined };
  ctx.acpRegistry.fetcher = (async () => ({ ok: true, json: async () => ({ agents: [entry("2.0.0")] }) })) as unknown as typeof fetch;
  await ctx.acpRegistry.list();
  ctx.acpRegistry.add("fake-agent");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const id = "registry:fake-agent";
  const engine = ctx.agent.engineOf(id)!;
  (engine.local!.signIn as AcpSignIn).againMs = 0;
  expect((await finish(ctx, id, ctx.agentSetup.start(id, "install"))).at(-1)).toMatchObject({ phase: "done" });

  const first = ctx.agentSetup.start(id, "sign-in", { method: "terminal-login" });
  for (const t0 = Date.now(); !(ctx.agentSetup.state(id)?.phase === "waiting"); ) {
    if (Date.now() - t0 > 20_000) throw new Error("never waited");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(ctx.agentSetup.state(id)).toMatchObject({ phase: "waiting", terminal: true, method: "terminal-login" });
  // The person finishes in the terminal.
  fs.writeFileSync(signed, "yes");
  expect((await finish(ctx, id, first)).at(-1)).toMatchObject({ phase: "done", method: "terminal-login" });
  expect(logged().filter((line) => line.method === "authenticate" && line.params.methodId === "terminal-login")).toEqual([]);

  fs.rmSync(signed);
  const { io } = turnIO();
  const result = await engine.turn(turnInput(), io);
  expect(result.stop).toBe("error");
  expect(await (engine.local!.signIn as AcpSignIn).signedIn()).toBe(false);
  await w.ctx.fiber.dispose();
}, 60_000);

it("finds a copy npm put under Tomrade's own prefix, and points npx there", async () => {
  const own = path.join(dir, "own");
  fs.rmSync(root, { recursive: true, force: true });
  process.env.TOMRADE_NPM_PREFIX = own;
  try {
    const cli = new NpxPackage("fake-agent@3.0.0");
    const spec = specOf(addedOf(RegistryAgent.parse(entry("3.0.0"))), cli);
    expect(await cli.locate({ fresh: true })).toMatchObject({ state: "missing" });

    const pkg = path.join(own, process.platform === "win32" ? "" : "lib", "node_modules", "fake-agent");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "fake-agent", version: "3.0.0" }));
    expect(await cli.locate({ fresh: true })).toMatchObject({ state: "ready", path: pkg, version: "3.0.0" });
    expect(spec.acp!.env!({})).toEqual({ NPM_CONFIG_PREFIX: own });

    // In npm's own global folder it needs no prefix.
    fs.mkdirSync(path.join(root, "fake-agent"), { recursive: true });
    fs.writeFileSync(path.join(root, "fake-agent", "package.json"), JSON.stringify({ name: "fake-agent", version: "3.0.0" }));
    expect(await cli.locate({ fresh: true })).toMatchObject({ state: "ready", path: path.join(root, "fake-agent") });
    expect(spec.acp!.env!({})).toEqual({});
  } finally {
    delete process.env.TOMRADE_NPM_PREFIX;
  }
});
