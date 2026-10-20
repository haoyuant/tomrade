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
    expect(engine).toMatchObject({ id: "demo", title: "Demo", author: "ai:demo", capabilities: ["backlog", "code", "general"], terminal: true, setup: { install: ["npm i -g demo"], signIn: "demo login" } });
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

    expect(await engine.mcpLink!.status()).toMatchObject({ state: "missing", url: w.ctx.mcp.url });
    expect(await engine.mcpLink!.connect()).toMatchObject({ state: "connected", configuredUrl: w.ctx.mcp.url });
    expect(await engine.mcpLink!.disconnect()).toMatchObject({ state: "unavailable", error: expect.stringMatching(/read-only/) });

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
        lend: { ask: async (_request, io) => ({ text: String(io.options.model), inputTokens: 1, outputTokens: 1 }) }
      });
    });
    w.ctx.settings.set({ ...w.ctx.settings.get(), agent: { ...w.ctx.agent.settingsOf(), engines: { demo_terminal: { command: bin, model: "fast" } } } });

    const engine = w.ctx.agent.engineOf("demo_terminal")!;
    expect(engine).toMatchObject({ id: "demo_terminal", author: "ai:demo_terminal", capabilities: ["code", "general"], terminalOnly: true, terminalViaLink: true, terminalClaims: true });
    expect(engine.options).toBeUndefined();
    expect(engine.picks!()).toEqual([{ key: "model", title: "Model", choices: [], freeText: true }]);
    expect(await engine.available({ fresh: true })).toMatchObject({ ok: true });
    expect(await engine.turn({} as TurnInput, turnIO().io)).toEqual({ stop: "error", error: 'Demo Terminal runs only in a terminal — start the ticket "In a terminal"' });
    expect(await engine.mcpLink!.status()).toMatchObject({ state: "missing", file: config, manual: { connect: `tomrade-fake-local-acp mcp add ${w.ctx.mcp.url}` } });

    let text = "";
    for await (const event of w.lent("demo_terminal")!.model.chat({ system: "", messages: [userMessage("hi")] })) if (event.type === "text") text += event.delta;
    expect(text).toBe("fast");
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
