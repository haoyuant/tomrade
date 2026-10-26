import { expect, it } from "vitest";
import { startProgress } from "../src/lib/codeLink";

it("walks a coding start through worktree, branch and MCP, then holds on the launch", () => {
  const at = (ms: number, mode: "run" | "terminal" = "run") => startProgress(ms, { mode, general: false });
  expect(at(0).steps).toEqual(["worktree", "branch", "mcp", "agent"]);
  expect(at(0).current).toBe(0);
  expect(at(3000).current).toBe(1);
  expect(at(6000).current).toBe(2);
  expect(at(9000).current).toBe(3);
  expect(at(120_000).current).toBe(3);
  expect(at(0, "terminal").steps.at(-1)).toBe("terminal");
});

it("skips worktree and branch for General work", () => {
  expect(startProgress(0, { mode: "run", general: true }).steps).toEqual(["mcp", "agent"]);
});

it("says it is not stuck past 10 s and where to look past 60 s", () => {
  const at = (ms: number) => startProgress(ms, { mode: "run", general: false });
  expect(at(9_999)).toMatchObject({ slow: false, stalled: false });
  expect(at(10_000)).toMatchObject({ slow: true, stalled: false });
  expect(at(60_000)).toMatchObject({ slow: true, stalled: true });
});
