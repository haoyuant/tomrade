import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { afterEach, expect, it } from "vitest";
import { Agent } from "@tomradex/agent";
import { Mcp } from "@tomradex/mcp";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import engineCodex from "@tomradex/engine-codex";

const saved = process.env.CODEX_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = saved;
});

it("puts Tomrade in CODEX_HOME's config.toml, updates an old address and takes it out again", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-codex-link-"));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  process.env.CODEX_HOME = home;
  const file = path.join(home, "config.toml");
  fs.writeFileSync(file, 'model = "gpt-x"\n\n[mcp_servers.tomrade]\nurl = "http://127.0.0.1:1/mcp"\n');
  const bin = path.join(dir, "codex");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve("packages/engine-codex/tests/fake-codex-mcp.mjs")}' "$@"\n`, { mode: 0o700 });
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ agent: { engines: { codex: { command: bin } } } }));
  const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineCodex] });
  await settle();
  try {
    const link = ctx.agent.engineOf("codex")!.local!.mcpLink!;
    const url = ctx.mcp.url!;
    const stale = await link.status();
    expect(stale).toMatchObject({ state: "stale", url, configuredUrl: "http://127.0.0.1:1/mcp", file });
    expect(stale.manual.connect).toBe(`codex mcp remove tomrade; codex mcp add tomrade --url ${url}`);
    expect(await link.connect()).toMatchObject({ state: "connected", configuredUrl: url });
    expect(parse(fs.readFileSync(file, "utf8"))).toMatchObject({ model: "gpt-x", mcp_servers: { tomrade: { url } } });
    expect(await link.disconnect()).toMatchObject({ state: "missing", configuredUrl: null });
    expect(parse(fs.readFileSync(file, "utf8"))).toMatchObject({ model: "gpt-x" });

    fs.writeFileSync(file, "not = [toml");
    expect(await link.status()).toMatchObject({ state: "unavailable", error: expect.stringContaining(file) });
  } finally {
    await ctx.fiber.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
