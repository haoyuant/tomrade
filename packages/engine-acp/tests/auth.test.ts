import { expect, it } from "vitest";
import { authMethodsOf, commandLine } from "../src/index.js";

it("reads the sign-in methods an agent lists, in each form agents use", () => {
  expect(authMethodsOf([
    { id: "oauth", name: "Log in", description: "Opens your browser" },
    { methodId: "v2", name: "Terminal", type: "terminal", args: ["--login"], env: [{ name: "A", value: "1" }] },
    // qwen puts the type in `_meta`; claude-agent-acp and pi-acp add the older terminal-auth command there.
    { id: "meta", name: "Key", _meta: { type: "terminal", args: ["--auth-type=openai"] } },
    { id: "legacy", name: "Legacy", _meta: { "terminal-auth": { command: "/usr/bin/node", args: ["cli.js", "--login"], label: "Log in" } } },
    { id: "key", name: "API key", type: "env_var" },
    { name: "no id" },
    "junk"
  ])).toEqual([
    { id: "oauth", name: "Log in", description: "Opens your browser", type: "agent", args: [], env: {} },
    { id: "v2", name: "Terminal", type: "terminal", args: ["--login"], env: { A: "1" } },
    { id: "meta", name: "Key", type: "terminal", args: ["--auth-type=openai"], env: {} },
    { id: "legacy", name: "Legacy", type: "terminal", args: [], env: {}, command: { command: "/usr/bin/node", args: ["cli.js", "--login"], env: {} } },
    { id: "key", name: "API key", type: "env_var", args: [], env: {} }
  ]);
  expect(authMethodsOf(undefined)).toEqual([]);
});

it("writes a terminal method as the person's shell reads it", () => {
  expect(commandLine(["/opt/a b/npx", "--yes", "pkg@1.0.0", "--login"], { LOGIN: "it's" }, "darwin")).toBe(`LOGIN='it'\\''s' '/opt/a b/npx' --yes pkg@1.0.0 --login`);
  expect(commandLine(["C:\\npm\\npx.cmd", "--yes", "pkg@1.0.0"], { LOGIN: "1" }, "win32")).toBe(`$env:LOGIN='1'; & 'C:\\npm\\npx.cmd' '--yes' 'pkg@1.0.0'`);
});
