import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, type Block, type TurnIO, type TurnInput } from "@tomradex/agent";
import { Llm, userMessage, type LentModel } from "@tomradex/llm";
import { Mcp } from "@tomradex/mcp";
import { Settings } from "@tomradex/settings";
import { Tools } from "@tomradex/tools";
import { localCli } from "@tomradex/engine-kit";
import { NotSignedIn, PERMISSION_CHOICES, definePlugin, type LocalAgentSpec, type PluginContext } from "@tomradex/plugin-sdk";
import { fresh, sdk, settle } from "@tomradex/testkit";
import { LocalAgents } from "../src/index.js";

const Options = z.object({ command: z.string().default("tomrade-fake-local-acp"), model: z.string().optional() });

describe("a plugin's local agent, run by the app's conductor", () => {
  let dir: string;
  let log: string;
  let bin: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-local-"));
    log = path.join(dir, "requests.jsonl");
    bin = path.join(dir, "fake-acp");
    fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve("packages/engine-acp/tests/fake-acp.mjs")}' "$@"\n`, { mode: 0o700 });
    process.env.TOMRADE_TEST_LOG = log;
  });
  afterEach(() => {
    delete process.env.TOMRADE_TEST_LOG;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function world(apply: (p: PluginContext) => Promise<void>) {
    const w = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json") }], Agent, [Mcp, { port: 0 }], Llm, LocalAgents] });
    w.ctx.settings.set({ ...w.ctx.settings.get(), agent: { ...w.ctx.agent.settingsOf(), engines: { demo: { command: bin, model: "Large" }, demo_terminal: { model: "fast" } } } });
    const fiber = w.ctx.plugin(sdk(definePlugin({ inject: ["agent"], apply }), { id: "someone/demo", namespace: "demo", origin: "extension", root: dir, dataDir: dir }));
    await fiber;
    await settle();
    const lent = (id: string) => (w.ctx.llm as unknown as { lent: LentModel[] }).lent.find((m) => m.id === id);
    return { ...w, fiber, lent };
  }

  const turnIO = () => {
    const blocks: Block[] = [];
    const io: TurnIO = {
      emit: (block) => blocks.push(block), delta: () => {}, progress: () => {}, signal: new AbortController().signal,
      tools: { describe: () => [], execute: async () => ({}) }, llm: null, playbooks: { index: () => [], open: () => null }, workflows: { list: () => [] },
      run: { id: "run", threadId: "thread", projectId: "project", author: "ai:demo", ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map() }
    };
    return { io, blocks };
  };

  it("drives an ACP agent a turn, keeps its connection and lends its sign-in, until the plugin unloads", async () => {
    const asked: unknown[] = [];
    let linked: string | null = null;
    let signedOut = false;
    const spec: LocalAgentSpec<z.infer<typeof Options>> = {
      id: "demo",
      title: "Demo",
      cli: { name: "tomrade-fake-local-acp" },
      install: "install the demo agent",
      setup: { install: ["npm i -g demo"], signIn: "demo login" },
      options: Options,
      acp: {
        permissionModes: { default: "full-access", choices: [PERMISSION_CHOICES["full-access"], PERMISSION_CHOICES.ask] },
        args: (options) => ["--acp", ...(options.model ? [`--model=${options.model}`] : [])],
        mode: (policy) => (policy === "full-access" ? "bypass" : "default"),
        usage: "turn",
        terminal: true
      },
      mcpLink: {
        status: (io) => ({ state: linked === io.mcp.url ? "connected" : "missing", url: io.mcp.url, configuredUrl: linked, file: "~/.demo/config", manual: { connect: "demo mcp add", disconnect: "demo mcp remove" } }),
        connect: (io) => {
          linked = io.mcp.url;
          return { state: "connected", url: io.mcp.url, configuredUrl: linked, file: "~/.demo/config", manual: { connect: "", disconnect: "" } };
        },
        disconnect: () => {
          throw new Error("the demo config is read-only");
        }
      },
      lend: {
        rank: 70,
        async ask(request, io) {
          asked.push({ request, model: io.options.model, cli: io.cli.name });
          if (signedOut) throw new NotSignedIn("Demo is not signed in — run `demo login`");
          const run = await io.cli.run(["--version"], { cwd: dir });
          return { text: `answered by ${run.stdout.trim()}`, inputTokens: 3, outputTokens: 2 };
        }
      }
    };
    const w = await world(async (p) => {
      await expect(p.agent.localAgent({ ...spec, id: "other" })).rejects.toThrow(/must be named "demo"/);
      await p.agent.localAgent(spec);
    });

    const engine = w.ctx.agent.engineOf("demo")!;
    expect(engine).toMatchObject({ id: "demo", title: "Demo", author: "ai:demo", capabilities: ["backlog", "code", "general"], terminal: { mode: "handoff" }, local: { setup: { install: ["npm i -g demo"], signIn: "demo login" } } });
    expect(engine.permissionModes).toEqual({ default: "full-access", choices: [PERMISSION_CHOICES["full-access"], PERMISSION_CHOICES.ask] });
    expect(await engine.available()).toMatchObject({ ok: true });

    const input: TurnInput = {
      threadId: "thread", projectId: "project", purpose: "code", cwd: dir, input: { kind: "text", text: "hello" }, messages: [], cards: [], brief: null, pending: null,
      options: { command: bin, model: "Large" }, env: { TOMRADE_TEST_LOG: log }
    };
    const { io } = turnIO();
    const turn = await engine.turn(input, io);
    expect(turn.stop, turn.error).toBe("end");
    const requests = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    // The turn's process, and the short session that read the model list, both started as the plugin says.
    expect(requests.filter((r) => r.spawn).map((r) => r.argv)).toContainEqual(["--acp", "--model=Large"]);
    expect(requests.find((r) => r.method === "session/set_config_option" && r.params.configId === "mode")?.params.value).toBe("bypass");

    expect(await engine.local!.mcpLink!.status()).toMatchObject({ state: "missing", url: w.ctx.mcp.url });
    expect(await engine.local!.mcpLink!.connect()).toMatchObject({ state: "connected", configuredUrl: w.ctx.mcp.url });
    expect(await engine.local!.mcpLink!.disconnect()).toMatchObject({ state: "unavailable", error: expect.stringMatching(/read-only/) });

    const lent = w.lent("demo")!;
    expect(lent).toMatchObject({ title: "Demo", rank: 70 });
    expect(await lent.ready()).toBe(true);
    let text = "";
    for await (const event of lent.model.chat({ system: "Be brief.", messages: [userMessage("hi")] })) if (event.type === "text") text += event.delta;
    expect(text).toBe("answered by 1.0.0");
    expect(asked.at(-1)).toEqual({ request: { system: "Be brief.", transcript: "hi" }, model: "Large", cli: "tomrade-fake-local-acp" });

    signedOut = true;
    await expect(async () => { for await (const _ of lent.model.chat({ system: "", messages: [userMessage("again")] })); }).rejects.toThrow(/not signed in/);
    expect(await lent.ready()).toBe(false);

    await w.fiber.dispose();
    await settle();
    expect(w.ctx.agent.engineOf("demo")).toBeUndefined();
    expect(w.lent("demo")).toBeUndefined();
    await w.ctx.fiber.dispose();
  });

  it("hands a terminal-only agent its ticket in a terminal, never a turn here, and its link through the agent's own CLI", async () => {
    const config = path.join(dir, "mcp.json");
    const w = await world(async (p) => {
      await p.agent.localAgent({
        id: "demo_terminal",
        title: "Demo Terminal",
        cli: { name: "tomrade-fake-local-acp" },
        install: "install the demo terminal agent",
        picks: [{ key: "model", title: "Model", choices: [], freeText: true }],
        probe: { args: ["--version"], says: (output) => (output.includes("1.0.0") ? true : null), reason: "Demo Terminal is not signed in" },
        mcpLink: {
          cli: {
            file: () => config,
            configuredUrl: () => (fs.existsSync(config) ? (JSON.parse(fs.readFileSync(config, "utf8")) as { url: string }).url : null),
            add: (url) => ["mcp", "add", url],
            remove: () => ["mcp", "remove"]
          }
        },
        // The try asks for OK; any other call answers with the model it runs, which names it.
        lend: { ask: async (request, io) => ({ text: request.transcript.includes("OK") ? "OK" : String(io.options.model), inputTokens: 1, outputTokens: 1 }) }
      });
    });
    w.ctx.settings.set({ ...w.ctx.settings.get(), agent: { ...w.ctx.agent.settingsOf(), engines: { demo_terminal: { command: bin, model: "fast" } } } });

    const engine = w.ctx.agent.engineOf("demo_terminal")!;
    expect(engine).toMatchObject({ id: "demo_terminal", author: "ai:demo_terminal", capabilities: ["code", "general"], terminal: { mode: "only", via: "link", claims: true } });
    expect(engine.options).toBeUndefined();
    expect(engine.local!.picks!()).toEqual([{ key: "model", title: "Model", choices: [], freeText: true }]);
    expect(await engine.available({ fresh: true })).toMatchObject({ ok: true });
    expect(await engine.turn({} as TurnInput, turnIO().io)).toEqual({ stop: "error", error: 'Demo Terminal runs only in a terminal — start the ticket "In a terminal"' });
    expect(await engine.local!.mcpLink!.status()).toMatchObject({ state: "missing", file: config, manual: { connect: `tomrade-fake-local-acp mcp add ${w.ctx.mcp.url}` } });

    let text = "";
    for await (const event of w.lent("demo_terminal")!.model.chat({ system: "", messages: [userMessage("hi")] })) if (event.type === "text") text += event.delta;
    expect(text).toBe("fast");
    // Its try is that one answer, not a turn it could never take.
    expect(await w.ctx.agent.tryEngine("no-project", "demo_terminal")).toMatchObject({ ok: true, reply: "OK" });
    expect((await w.ctx.agent.engineViews()).find((e) => e.id === "demo_terminal")).toMatchObject({ terminalOnly: true, asks: true, tried: { ok: true } });
    await w.ctx.fiber.dispose();
  });

  it("reads an ACP agent's terminal connection from SDK 0.2.23's terminal.via and from the flat terminalViaLink before it", async () => {
    const acp = (terminal: NonNullable<LocalAgentSpec["acp"]>["terminal"], flat?: boolean) => ({
      permissionModes: { default: "full-access", choices: [PERMISSION_CHOICES["full-access"]] }, args: () => ["--acp"], terminal, ...(flat ? { terminalViaLink: true } : {})
    });
    const w = await world(async (p) => {
      await p.agent.localAgent({ id: "demo_link", title: "Link", cli: { name: "tomrade-no-such-link-cli" }, install: "install it", options: Options, acp: acp({ via: "link" }) });
      await p.agent.localAgent({ id: "demo_flat", title: "Flat", cli: { name: "tomrade-no-such-flat-cli" }, install: "install it", options: Options, acp: acp(true, true) });
      await p.agent.localAgent({ id: "demo_session", title: "Session", cli: { name: "tomrade-no-such-session-cli" }, install: "install it", options: Options, acp: acp(true) });
    });
    expect(w.ctx.agent.engineOf("demo_link")!.terminal).toEqual({ mode: "handoff", via: "link" });
    expect(w.ctx.agent.engineOf("demo_flat")!.terminal).toEqual({ mode: "handoff", via: "link" });
    expect(w.ctx.agent.engineOf("demo_session")!.terminal).toEqual({ mode: "handoff" });
    await w.ctx.fiber.dispose();
  });

  it("writes an installer script out as the command the app runs, here and in the not-found words", async () => {
    const w = await world(async (p) => {
      await p.agent.localAgent({
        id: "demo",
        title: "Demo",
        cli: { name: "tomrade-no-such-demo-cli" },
        install: "install Demo ({install}) and sign in",
        setup: { install: [{ script: "https://demo.example/install.sh" }, { powershell: "https://demo.example/install.ps1" }, { npm: "demo-cli" }, "npm install -g demo"], signIn: "demo login" }
      });
    });
    w.ctx.settings.set({ ...w.ctx.settings.get(), agent: { ...w.ctx.agent.settingsOf(), engines: {} } });
    const engine = w.ctx.agent.engineOf("demo")!;
    expect(engine.local!.setup).toEqual({
      install: ["curl -fsSL https://demo.example/install.sh | bash", "irm https://demo.example/install.ps1 | iex", "npm install -g demo-cli", "npm install -g demo"],
      // the declared installers, for the one-click setup the app runs itself; the bare command stays terminal-only
      installers: [
        { kind: "script", url: "https://demo.example/install.sh", shell: "sh" },
        { kind: "script", url: "https://demo.example/install.ps1", shell: "powershell" },
        { kind: "npm", package: "demo-cli" }
      ],
      signIn: "demo login"
    });
    const state = await engine.available({ fresh: true });
    expect(state).toMatchObject({ ok: false, need: "install" });
    expect(state.reason).toContain("install Demo (curl -fsSL https://demo.example/install.sh | bash) and sign in");
    await w.ctx.fiber.dispose();
  });

  it("hands its download page and desktop app on to setup screens", async () => {
    const w = await world(async (p) => {
      await p.agent.localAgent({
        id: "demo",
        title: "Demo",
        cli: { name: "tomrade-no-such-demo-cli" },
        install: "install Demo ({install})",
        setup: { install: ["npm install -g demo"], download: "https://demo.example/download", desktop: { title: "Demo Desktop", shipsCli: false } }
      });
    });
    const engine = w.ctx.agent.engineOf("demo")!;
    expect(engine.local!.setup).toEqual({ install: ["npm install -g demo"], download: "https://demo.example/download", desktop: { title: "Demo Desktop", shipsCli: false } });
    await w.ctx.fiber.dispose();
  });

  it("stops using an earlier version's bundled CLI once the plugin is loaded again without one", async () => {
    const copy = path.join(dir, "App", "cli", "tomrade-no-such-bundled-cli");
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, '#!/bin/sh\necho "1.0.0"\n', { mode: 0o700 });
    const spec = (bundled: boolean): LocalAgentSpec => ({
      id: "demo_bundled",
      title: "Demo",
      cli: { name: "tomrade-no-such-bundled-cli", ...(bundled ? { bundled: () => [{ file: copy }] } : {}) },
      install: "install it"
    });
    const w = await world((p) => p.agent.localAgent(spec(true)));
    expect((await w.ctx.agent.engineOf("demo_bundled")!.available({ fresh: true })).cli).toMatchObject({ state: "ready", path: copy });
    // Asked for by name alone, as setup does, the locator keeps the finder it has.
    expect(await localCli("tomrade-no-such-bundled-cli").locate({ fresh: true })).toMatchObject({ state: "ready", path: copy });
    // An update in place: the old version goes, the new one comes without the finder.
    await w.fiber.dispose();
    const next = w.ctx.plugin(sdk(definePlugin({ inject: ["agent"], apply: (p) => p.agent.localAgent(spec(false)) }), { id: "someone/demo", namespace: "demo", origin: "extension", root: dir, dataDir: dir }));
    await next;
    await settle();
    const engine = w.ctx.agent.engineOf("demo_bundled")!;
    expect((await engine.available()).cli).toMatchObject({ state: "missing" });
    expect((await engine.available({ fresh: true })).cli).toMatchObject({ state: "missing" });
    await w.ctx.fiber.dispose();
  });

  it("keeps an agent the app still ships, and leaves the plugin's copy off", async () => {
    const w = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json") }], Agent, [Mcp, { port: 0 }], Llm, LocalAgents] });
    const builtIn = { id: "demo", title: "Built-in demo", author: "ai:demo" as const, available: async () => ({ ok: true }), turn: async () => ({ stop: "end" as const }) };
    w.ctx.agent.engine(builtIn);
    w.ctx.plugin(sdk(definePlugin({ inject: ["agent"], apply: (p) => p.agent.localAgent({ id: "demo", title: "Demo", cli: { name: "demo" }, install: "x" }) }), { id: "someone/demo", namespace: "demo", origin: "extension", root: dir, dataDir: dir }));
    await settle();
    expect(w.ctx.agent.engineOf("demo")).toBe(builtIn);
    await w.ctx.fiber.dispose();
  });
});
