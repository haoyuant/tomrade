import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Agent, type TurnInput } from "@tomradex/agent";
import { Mcp } from "@tomradex/mcp";
import engineTerminal, { agyMcpFile, gemini, geminiCallName, geminiCanSignIn } from "@tomradex/engine-terminal";

it("registers Gemini CLI as an in-app agent that also takes a ticket in a terminal", async () => {
  const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: `/tmp/tomrade-engine-terminal-${Date.now()}.json` }], Agent, [Mcp, { port: 0 }], engineTerminal] });
  await settle();
  try {
    const views = await ctx.agent.engineViews();
    const view = views.find((v) => v.id === "gemini");
    expect(view).toMatchObject({ capabilities: ["backlog", "code", "general"], permissionModes: { default: "full-access" } });
    expect(view?.terminalOnly).toBeUndefined();
    expect(view?.terminal).toBeUndefined();
    expect(view?.permissionModes?.choices.map((c) => c.value)).toEqual(["full-access", "ask", "read-only"]);
    expect(ctx.agent.codeEngines().map((e) => e.id)).toEqual(["gemini", "agy"]);
  } finally {
    await ctx.fiber.dispose();
  }
});

it("starts Gemini CLI's ACP server asking before it acts, in a folder it trusts, and names its calls from their ids", () => {
  const input = {} as TurnInput;
  expect(gemini.args(input, { command: "gemini" })).toEqual(["--acp", "--approval-mode", "default"]);
  expect(gemini.env?.(input, { command: "gemini" })).toEqual({ GEMINI_CLI_TRUST_WORKSPACE: "true" });
  expect(geminiCallName("mcp_tomrade_list_items__a1b2")).toBe("mcp_tomrade_list_items");
  expect(geminiCallName("run_shell_command__run_shell_command_1792_0")).toBe("run_shell_command");
  expect(geminiCallName("opaque-id")).toBeUndefined();
});

it("registers Antigravity CLI for a terminal only, connected through its own config and claiming first", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-agy-"));
  // Stands in for `agy mcp add|remove` as 1.4.0 does it: servers in ~/.gemini/config/mcp_config.json, `serverUrl` for http.
  const bin = path.join(dir, "agy");
  fs.writeFileSync(bin, `#!/bin/sh
f="$HOME/.gemini/config/mcp_config.json"
[ "$1" = "--version" ] && { echo 1.4.0; exit 0; }
mkdir -p "$(dirname "$f")"
if [ "$2" = "add" ]; then printf '{"mcpServers":{"%s":{"serverUrl":"%s","disabled":false}}}' "$3" "$4" > "$f"; else printf '{"mcpServers":{}}' > "$f"; fi
`, { mode: 0o700 });
  const home = process.env.HOME;
  process.env.HOME = dir;
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ agent: { engines: { agy: { command: bin } } } }));
  const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineTerminal] });
  await settle();
  try {
    const engine = ctx.agent.engineOf("agy")!;
    expect(engine).toMatchObject({ title: "Antigravity CLI", capabilities: ["code", "general"], terminalOnly: true, terminalViaLink: true, terminalClaims: true });
    expect(engine.setup?.install[0]).toContain("antigravity.google/cli/install");
    expect(agyMcpFile(dir)).toBe(path.join(dir, ".gemini", "config", "mcp_config.json"));
    const link = engine.mcpLink!;
    expect(await link.status()).toMatchObject({ state: "missing" });
    expect(await link.connect()).toMatchObject({ state: "connected", configuredUrl: ctx.mcp.url });
    expect(JSON.parse(fs.readFileSync(agyMcpFile(dir), "utf8")).mcpServers.tomrade.serverUrl).toBe(ctx.mcp.url);
    expect(await link.disconnect()).toMatchObject({ state: "missing" });
  } finally {
    process.env.HOME = home;
    await ctx.fiber.dispose();
  }
});

it("reads from Gemini CLI's own settings whether it can sign in, now that a personal Google sign-in is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-gemini-auth-"));
  const auth = (selectedType?: string) => fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(selectedType ? { security: { auth: { selectedType } } } : {}));
  auth("oauth-personal");
  expect(geminiCanSignIn({}, dir)).toBe(false);
  // A Cloud project means a Code Assist licence, which still signs in with Google.
  expect(geminiCanSignIn({ GOOGLE_CLOUD_PROJECT: "acme" }, dir)).toBeNull();
  auth("gemini-api-key");
  expect(geminiCanSignIn({}, dir)).toBe(false);
  expect(geminiCanSignIn({ GEMINI_API_KEY: "AIza…" }, dir)).toBe(true);
  fs.writeFileSync(path.join(dir, ".env"), "GEMINI_API_KEY=AIzaSyExample\n");
  expect(geminiCanSignIn({}, dir)).toBe(true);
  auth("vertex-ai");
  expect(geminiCanSignIn({}, dir)).toBeNull();
  auth();
  // Not chosen yet, but a key is there: nothing says no.
  expect(geminiCanSignIn({}, dir)).toBeNull();
  fs.rmSync(path.join(dir, ".env"));
  expect(geminiCanSignIn({}, dir)).toBe(false);
  expect(gemini.signedIn?.reason).toContain("personal Google account");
});
