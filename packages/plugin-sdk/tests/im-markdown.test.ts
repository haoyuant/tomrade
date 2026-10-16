import { describe, expect, it } from "vitest";
import { IM_MARKDOWN_DIALECTS, splitImText, toImDialect } from "@tomradex/plugin-sdk";

const sample = [
  "## Plan",
  "Use **bold**, *italic*, ~~old~~ and `a < b` in [the docs](https://example.com/a?b=1&c=2).",
  "- first item with snake_case_name",
  "1. numbered",
  "> quoted",
  "```ts",
  "const x = a < b && **not bold**;",
  "```"
].join("\n");

describe("Markdown to IM dialects", () => {
  it("writes each platform's dialect without touching code", () => {
    expect(toImDialect(sample, "markdown")).toBe(sample);
    expect(toImDialect(sample, "slack")).toBe([
      "*Plan*",
      "Use *bold*, _italic_, ~old~ and `a &lt; b` in <https://example.com/a?b=1&c=2|the docs>.",
      "• first item with snake_case_name",
      "1. numbered",
      "> quoted",
      "```\nconst x = a &lt; b &amp;&amp; **not bold**;\n```"
    ].join("\n"));
    expect(toImDialect(sample, "telegram-html")).toBe([
      "<b>Plan</b>",
      "Use <b>bold</b>, <i>italic</i>, <s>old</s> and <code>a &lt; b</code> in <a href=\"https://example.com/a?b=1&amp;c=2\">the docs</a>.",
      "• first item with snake_case_name",
      "1. numbered",
      "<blockquote>quoted</blockquote>",
      "<pre><code class=\"language-ts\">const x = a &lt; b &amp;&amp; **not bold**;</code></pre>"
    ].join("\n"));
    expect(toImDialect(sample, "plain")).toBe([
      "Plan",
      "Use bold, italic, old and a < b in the docs (https://example.com/a?b=1&c=2).",
      "• first item with snake_case_name",
      "1. numbered",
      "> quoted",
      "const x = a < b && **not bold**;"
    ].join("\n"));
    expect(toImDialect(sample, "discord")).toBe(sample);
    expect(toImDialect(sample, "lark").split("\n")[0]).toBe("**Plan**");
    expect(toImDialect(sample, "wecom").split("\n")[1]).toBe("Use **bold**, italic, old and `a < b` in [the docs](https://example.com/a?b=1&c=2).");
    expect(toImDialect(sample, "dingtalk").split("\n")[1]).toContain("*italic*, old and");
  });

  it("keeps escapes, merges Telegram quotes and leaves unmatched markers alone", () => {
    expect(toImDialect("2 \\* 3 * 4", "slack")).toBe("2 * 3 * 4");
    expect(toImDialect("2 \\* 3", "discord")).toBe("2 \\* 3");
    expect(toImDialect("> one\n> two", "telegram-html")).toBe("<blockquote>one\ntwo</blockquote>");
    expect(toImDialect("a ** b and `open", "telegram-html")).toBe("a ** b and `open");
  });

  it("splits between lines, never inside a code block or a surrogate pair", () => {
    const code = "```py\n" + Array.from({ length: 40 }, (_, i) => `print(${i})`).join("\n") + "\n```";
    const text = ["Intro paragraph.", "", code, "", "After the code."].join("\n");
    for (const dialect of IM_MARKDOWN_DIALECTS) {
      const parts = splitImText(text, 200, dialect);
      for (const part of parts) expect(part.length).toBeLessThanOrEqual(200);
      if (dialect === "markdown" || dialect === "discord") {
        for (const part of parts) expect((part.match(/```/g) ?? []).length % 2).toBe(0);
        expect(parts.filter(p => p.includes("```py")).length).toBeGreaterThan(1);
        expect(parts.join("\n").match(/print\(\d+\)/g)).toHaveLength(40);
      }
    }
    const small = splitImText(["a".repeat(100), "```\nshort code\n```", "b".repeat(100)].join("\n"), 150);
    expect(small).toEqual(["a".repeat(100) + "\n```\nshort code\n```", "b".repeat(100)]);
    const emoji = "😀".repeat(200);
    const parts = splitImText(emoji, 129);
    expect(parts.join("")).toBe(emoji);
    for (const p of parts) expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(p)).toBe(false);
  });

  it("measures limits after conversion", () => {
    const parts = splitImText(Array.from({ length: 60 }, () => "a < b").join("\n"), 128, "telegram-html");
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(128);
    expect(parts.join("\n")).toBe(Array.from({ length: 60 }, () => "a &lt; b").join("\n"));
  });
});
