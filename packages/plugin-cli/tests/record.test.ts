import { expect, it } from "vitest";
import { emptyRecording, recordingContext } from "@tomradex/plugin-cli";
import { z } from "zod";

it("records the CLI agent hook events a plugin hears, all of them when it names none", async () => {
  const rec = emptyRecording();
  const ctx = recordingContext("guard", ["agent"], rec);
  await ctx.agent.cliHook({ events: ["pre-tool", "stop"], handle: () => undefined });
  expect(rec.agentHooks).toEqual(["pre-tool", "stop"]);
  await ctx.agent.cliHook({ handle: () => undefined });
  expect(new Set(rec.agentHooks)).toEqual(new Set(["session-start", "prompt", "pre-tool", "post-tool", "stop", "session-end"]));
});

it("records the model providers a plugin registers, and what keeps one from working", async () => {
  const rec = emptyRecording();
  const ctx = recordingContext("acme", ["models"], rec);
  const chat = () => ({ capabilities: { tools: true, streaming: true, json: false }, chat: async function* () {} });
  await ctx.models.registerProvider({ id: "acme", title: "Acme", baseURL: { default: "https://api.acme.example/v1" }, presets: [{ id: "acme", title: "Acme", keyShapes: [/^ak-/] }], list: () => ({ ok: true, models: null }), build: chat });
  expect(rec.modelProviders).toEqual(["acme"]);
  expect(rec.invalid).toEqual([]);
  await ctx.models.registerProvider({ id: "acme-local", title: "", baseURL: undefined as never, presets: [{ id: "local", title: "Local", prefer: ["qwen" as never] }], list: undefined as never, build: chat });
  expect(rec.violations).toEqual([{ kind: "model preset", id: "local" }]);
  expect(rec.invalid).toEqual([
    'model provider "acme-local" has no title',
    'model provider "acme-local" needs baseURL.default, the address a profile without its own talks to',
    'model provider "acme-local" needs list(endpoint, signal), which doubles as the key check',
    'model provider "acme-local": preset "local" lists prefer or keyShapes that are not regular expressions'
  ]);
});

it("records the local agents a plugin registers, and what keeps one from running", async () => {
  const rec = emptyRecording();
  const ctx = recordingContext("acme", ["agent"], rec);
  await ctx.agent.localAgent({
    id: "acme",
    title: "Acme",
    cli: { name: "acme" },
    install: "install Acme",
    options: z.object({ command: z.string().default("acme") }),
    acp: { permissionModes: { default: "full-access", choices: [{ value: "full-access", label: "Full access" }] }, args: () => ["acp"] }
  });
  expect(rec.localAgents).toEqual(["acme"]);
  expect(rec.invalid).toEqual([]);
  await ctx.agent.localAgent({ id: "other", title: "", cli: { name: "" }, install: "", acp: { permissionModes: { default: "x", choices: [] }, args: undefined as never }, lend: {} as never });
  expect(rec.violations).toEqual([{ kind: "local agent", id: "other" }]);
  expect(rec.invalid).toEqual([
    'local agent "other" has no title',
    'local agent "other" needs cli.name, the command Tomrade looks for',
    'local agent "other" needs install, the words after "not found —"',
    'local agent "other" talks ACP but has no options schema (its settings, with `command`)',
    'local agent "other" needs acp.args(options), what starts its ACP server',
    'local agent "other" needs acp.permissionModes with at least one choice',
    'local agent "other": lend needs ask(request, io)'
  ]);
});

it("takes an installer only as a script's https address", async () => {
  const rec = emptyRecording();
  const ctx = recordingContext("acme", ["agent"], rec);
  await ctx.agent.localAgent({ id: "acme", title: "Acme", cli: { name: "acme" }, install: "install Acme ({install})", setup: { install: [{ script: "https://acme.example/install.sh" }, { powershell: "https://acme.example/install.ps1" }] } });
  expect(rec.invalid).toEqual([]);
  expect(rec.localAgentInstallers).toEqual(["acme"]);
  await ctx.agent.localAgent({ id: "acme_two", title: "Acme", cli: { name: "acme" }, install: "x", setup: { install: [{ script: "http://acme.example/install.sh" }, { script: "https://acme.example/i.sh | sh" }] } });
  expect(rec.invalid).toEqual([
    'local agent "acme_two": an installer is a script\'s https address, not "http://acme.example/install.sh"',
    'local agent "acme_two": an installer is a script\'s https address, not "https://acme.example/i.sh | sh"'
  ]);
});

it("takes a download page only as an https address, and a desktop app only with whether it ships the CLI", async () => {
  const rec = emptyRecording();
  const ctx = recordingContext("acme", ["agent"], rec);
  await ctx.agent.localAgent({ id: "acme", title: "Acme", cli: { name: "acme" }, install: "x", setup: { install: [], download: "https://acme.example/download", desktop: { title: "Acme", shipsCli: false } } });
  expect(rec.invalid).toEqual([]);
  await ctx.agent.localAgent({ id: "acme_two", title: "Acme", cli: { name: "acme" }, install: "x", setup: { install: [], download: "javascript:alert(1)", desktop: { title: "Acme" } as never } });
  expect(rec.invalid).toEqual([
    'local agent "acme_two": setup.download is a page\'s https address, not "javascript:alert(1)"',
    'local agent "acme_two": setup.desktop needs a title and shipsCli, whether the app puts the CLI where Tomrade finds it'
  ]);
});
