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
