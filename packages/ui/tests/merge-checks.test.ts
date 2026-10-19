import { expect, it } from "vitest";
import { splitMergeChecks } from "../src/lib/codeLink";

it("gives each agent whose settings were read its own row and names the rest together", () => {
  const allowed = { engine: "codex", title: "Codex", check: { state: "allowed" as const, why: "bypass" as const, mode: "full-access" } };
  const split = splitMergeChecks([
    { engine: "pi", title: "Pi", check: null },
    allowed,
    { engine: "gemini", title: "Gemini CLI", check: null }
  ]);
  expect(split).toEqual({ known: [allowed], unknown: ["Pi", "Gemini CLI"] });
});
