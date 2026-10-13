/** The one line under a step an engine ran itself. */
import { expect, it } from "vitest";
import { stepHint, stepSummary } from "@tomradex/agent";

it("names a step by its most telling argument", () => {
  expect(stepHint({ command: "grep -rn foo\n  src", description: "Find foo" })).toBe("grep -rn foo src");
  expect(stepHint({ file_path: "/a/b.ts", content: "…" })).toBe("/a/b.ts");
  expect(stepHint({ x: 1 })).toBe("");
});

it("adds why a step failed, from the first line of its output", () => {
  expect(stepSummary({ command: "ls nope" }, [{ type: "text", text: "\nls: nope: No such file\nmore" }], false)).toBe("ls nope — ls: nope: No such file");
  expect(stepSummary({ command: "ls" }, "a\nb", true)).toBe("ls");
  expect(stepSummary({}, { content: [{ type: "text", text: "12 matches" }] }, true)).toBe("12 matches");
});
