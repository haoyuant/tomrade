/** The live token line: each request's prompt once, a dropped one not at all, subagents beside the main loop. */
import { expect, it } from "vitest";
import { LiveUsage } from "../src/usage.js";

const start = (input: number) => ({ type: "message_start", message: { usage: { input_tokens: input, output_tokens: 0 } } });
const delta = (output: number) => ({ type: "message_delta", usage: { output_tokens: output } });
const stop = { type: "message_stop" };

it("drops a request that failed and is sent again", () => {
  const live = new LiveUsage();
  live.observe(start(40_000));
  live.observe(delta(12));
  expect(live.retry()).toEqual({ inputTokens: 0, outputTokens: 0 });
  live.observe(start(40_000));
  live.observe(delta(30));
  expect(live.observe(stop)).toEqual({ inputTokens: 40_000, outputTokens: 30 });
});

it("keeps a subagent's request apart from the main loop's", () => {
  const live = new LiveUsage();
  live.observe(start(100));
  live.observe(start(50), "task-1");
  live.observe(delta(7), "task-1");
  live.observe(delta(3));
  expect(live.observe(stop, "task-1")).toEqual({ inputTokens: 150, outputTokens: 10 });
  expect(live.observe(stop)).toEqual({ inputTokens: 150, outputTokens: 10 });
});
