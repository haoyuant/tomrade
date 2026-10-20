import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "@tomradex/agent";
import { collect, userMessage } from "@tomradex/llm";
import { Mcp } from "@tomradex/mcp";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import engineCursor, { cursorLentModel, cursorWorkerDir, cursorMcpFile, cursorSignedIn, withMcpEntry } from "../src/index.js";
import { localCli } from "@tomradex/engine-claude-code";

const home = process.env.HOME;
afterEach(() => {
  process.env.HOME = home;
  delete process.env.FAKE_CURSOR_SIGNED_OUT;
});

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-cursor-"));
  process.env.HOME = dir;
  const bin = path.join(dir, "cursor-agent");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve("packages/engine-cursor/tests/fake-cursor-agent.mjs")}' "$@"\n`, { mode: 0o700 });
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ agent: { engines: { cursor: { command: bin, model: "gpt-5" } } } }));
  const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineCursor] });
  await settle();
  return { ctx, dir, engine: ctx.agent.engineOf("cursor")! };
}

describe("Cursor as an engine", () => {
  it("is offered for a terminal only, reached through its own config, and claims first", async () => {
    const { ctx, engine } = await setup();
    try {
      expect(engine).toMatchObject({ title: "Cursor", capabilities: ["code", "general"], terminalOnly: true, terminalViaLink: true, terminalClaims: true });
      expect(engine.setup?.install[0]).toContain("cursor.com/install");
      expect(await engine.available({ fresh: true })).toMatchObject({ ok: true });
      expect(await engine.turn({} as never, {} as never)).toMatchObject({ stop: "error", error: expect.stringContaining("only in a terminal") });
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("says, without failing, that it needs signing in", async () => {
    process.env.FAKE_CURSOR_SIGNED_OUT = "1";
    const { ctx, engine } = await setup();
    try {
      expect(await engine.available({ fresh: true })).toMatchObject({ ok: false, need: "sign-in", reason: expect.stringContaining("cursor-agent login") });
    } finally {
      await ctx.fiber.dispose();
    }
    expect([cursorSignedIn("✓ Logged in as a@b.c"), cursorSignedIn("Not logged in"), cursorSignedIn("")]).toEqual([true, false, null]);
  });

  it("connects ~/.cursor/mcp.json, keeps the person's other servers, and takes it back out", async () => {
    const { ctx, dir, engine } = await setup();
    try {
      const file = cursorMcpFile();
      expect(file).toBe(path.join(dir, ".cursor", "mcp.json"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { codegraph: { type: "stdio", command: "codegraph" } } }));
      const link = engine.mcpLink!;
      expect(await link.status()).toMatchObject({ state: "missing", file });
      expect(await link.connect()).toMatchObject({ state: "connected", configuredUrl: ctx.mcp.url });
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ mcpServers: { codegraph: { type: "stdio", command: "codegraph" }, tomrade: { url: ctx.mcp.url } } });
      fs.writeFileSync(file, withMcpEntry(fs.readFileSync(file, "utf8"), "http://127.0.0.1:1/mcp"));
      expect(await link.status()).toMatchObject({ state: "stale", configuredUrl: "http://127.0.0.1:1/mcp" });
      expect(await link.disconnect()).toMatchObject({ state: "missing" });
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ mcpServers: { codegraph: { type: "stdio", command: "codegraph" } } });
      fs.writeFileSync(file, "{ not json");
      expect(await link.status()).toMatchObject({ state: "unavailable", error: expect.stringContaining(file) });
      expect(await link.connect()).toMatchObject({ state: "unavailable", error: expect.stringContaining("JSON") });
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("answers worker calls in ask mode from an empty folder, its whole input counted", async () => {
    const { ctx } = await setup();
    try {
      const lent = cursorLentModel(ctx, { cli: localCli("cursor-agent"), found: async () => true, options: () => ({ model: "gpt-5" }) });
      expect(lent).toMatchObject({ id: "cursor", title: "Cursor", rank: 80 });
      const answer = await collect(lent.model.chat({ system: "Be brief.", messages: [userMessage("hello")] }));
      const seen = JSON.parse(answer.text) as { args: string[]; prompt: string; cwd: string };
      expect(seen.args).toEqual(["-p", "--output-format", "json", "--mode", "ask", "--trust", "--model", "gpt-5"]);
      expect(seen.prompt.startsWith("Be brief.\n\n---\n\n")).toBe(true);
      expect(seen.prompt).toContain("hello");
      // One folder for every call, so cursor-agent keeps one background worker, not one per call.
      expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(cursorWorkerDir()));
      expect(answer.usage).toMatchObject({ inputTokens: 120 + 3840 + 2, outputTokens: 7, cacheReadTokens: 3840 });

      await expect(collect(lent.model.chat({ system: "", messages: [userMessage("SIGNED_OUT")] }))).rejects.toThrow("cursor-agent login");
      expect(await lent.ready()).toBe(false);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
