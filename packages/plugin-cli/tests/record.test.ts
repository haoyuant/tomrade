import { expect, it } from "vitest";
import { emptyRecording, recordingContext } from "@tomradex/plugin-cli";

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
