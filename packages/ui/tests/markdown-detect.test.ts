import { expect, it } from "vitest";
import { looksLikeMarkdown } from "../src/lib/markdownDetect";

it("takes a reply with Markdown's plain marks as Markdown", () => {
  expect(looksLikeMarkdown("Done.\n\n```ts\nconst a = 1;\n```")).toBe(true);
  // a fence still open while the reply streams
  expect(looksLikeMarkdown("Here:\n```bash\npnpm test")).toBe(true);
  expect(looksLikeMarkdown("## Summary\nAll good")).toBe(true);
  expect(looksLikeMarkdown("| a | b |\n| --- | :-: |\n| 1 | 2 |")).toBe(true);
  expect(looksLikeMarkdown("Changed:\n- a.ts\n- b.ts")).toBe(true);
  expect(looksLikeMarkdown("Steps:\n1. build\n2. test")).toBe(true);
  expect(looksLikeMarkdown("This is **important** now")).toBe(true);
  expect(looksLikeMarkdown("> quoted\n> twice")).toBe(true);
});

it("leaves plain prose plain", () => {
  expect(looksLikeMarkdown("Filed TOM-12 and started it.")).toBe(false);
  expect(looksLikeMarkdown("Saw /Users/me/a.ts and https://example.com/x")).toBe(false);
  expect(looksLikeMarkdown("- one dash line only")).toBe(false);
  expect(looksLikeMarkdown("Tagged #design and #ui")).toBe(false);
  expect(looksLikeMarkdown("2 * 3 * 4 = 24, a ** b")).toBe(false);
  expect(looksLikeMarkdown("cost - 5 and then\nmore - text")).toBe(false);
  expect(looksLikeMarkdown("一、先做这个\n二、再做那个")).toBe(false);
});
