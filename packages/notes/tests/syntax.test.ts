import { describe, expect, it } from "vitest";
import { decodeHref, encodeHref, linkKey, linkTarget, newNotePath, parseNote, resolveLink, rewriteLink } from "@tomradex/notes";

describe("parseNote", () => {
  it("reads wiki links with anchors, aliases and embeds, and markdown links to local files", () => {
    const text = [
      "# Plan",
      "See [[Roadmap]] and [[specs/API#Errors|the error table]].",
      "![[diagram.png]] and [the brief](../docs/brief%20v2.md#scope)",
      "Not these: [site](https://example.com), [top](#plan)."
    ].join("\n");
    const { title, links } = parseNote(text);
    expect(title).toBe("Plan");
    expect(links.map((l) => [l.kind, l.target, l.anchor, l.alias, l.embed, l.line])).toEqual([
      ["wiki", "Roadmap", null, null, false, 2],
      ["wiki", "specs/API", "Errors", "the error table", false, 2],
      ["wiki", "diagram.png", null, null, true, 3],
      ["markdown", "../docs/brief v2.md", "scope", "the brief", false, 3]
    ]);
    expect(text.slice(links[1]!.from, links[1]!.to)).toBe("[[specs/API#Errors|the error table]]");
  });

  it("finds tags in prose only — not in code, headings, links or numbers", () => {
    const text = [
      "---",
      "tags: [Planning, q4/goals]",
      "---",
      "Status #draft, owner #team/web.",
      "Issue #123 is not a tag, nor is [[Note#Heading]].",
      "`#inline` and",
      "```",
      "#fenced",
      "```",
      "## A heading",
      "%% #hidden %%"
    ].join("\n");
    const parsed = parseNote(text);
    expect(parsed.tagSpans.map((t) => t.tag)).toEqual(["draft", "team/web"]);
    expect(parsed.tags.sort()).toEqual(["draft", "planning", "q4/goals", "team/web"]);
  });

  it("takes the title from front matter first, then the first H1", () => {
    expect(parseNote("---\ntitle: \"From front\"\n---\n# Heading").title).toBe("From front");
    expect(parseNote("Intro\n\n## Second\n# First H1 #").title).toBe("First H1");
    expect(parseNote("```\n# not a title\n```\nplain").title).toBeNull();
  });

  it("reads no tag out of a link to a place in the page or on the web", () => {
    expect(parseNote("See [intro](#intro) and [docs](https://x.dev/#setup) #real").tags).toEqual(["real"]);
  });

  it("ignores links inside code", () => {
    expect(parseNote("`[[Nope]]`\n```md\n[[Also nope]]\n```\n[[Yes]]").links.map((l) => l.target)).toEqual(["Yes"]);
  });
});

describe("resolveLink", () => {
  const paths = ["Roadmap.md", "docs/Roadmap.md", "docs/specs/API.md", "projects/web/API.md", "img/diagram.png", "docs/brief v2.md", "Journal/2026-10-10.md", "v1.2 release.md"];

  it("prefers the whole path, then the linking note's folder, then the shallowest match", () => {
    expect(resolveLink({ target: "Roadmap", kind: "wiki" }, "docs/plan.md", paths)).toBe("docs/Roadmap.md");
    expect(resolveLink({ target: "Roadmap", kind: "wiki" }, "elsewhere/plan.md", paths)).toBe("Roadmap.md");
    expect(resolveLink({ target: "API", kind: "wiki" }, "notes/x.md", paths)).toBe("docs/specs/API.md");
    expect(resolveLink({ target: "web/API", kind: "wiki" }, "notes/x.md", paths)).toBe("projects/web/API.md");
    expect(resolveLink({ target: "docs/specs/api.md", kind: "wiki" }, "x.md", paths)).toBe("docs/specs/API.md");
  });

  it("reads a name with a dot as a note before a file", () => {
    expect(resolveLink({ target: "v1.2 release", kind: "wiki" }, "x.md", paths)).toBe("v1.2 release.md");
    expect(resolveLink({ target: "diagram.png", kind: "wiki" }, "docs/x.md", paths)).toBe("img/diagram.png");
    expect(resolveLink({ target: "Missing", kind: "wiki" }, "x.md", paths)).toBeNull();
  });

  it("resolves a markdown link relative to the linking note", () => {
    expect(resolveLink({ target: "../docs/brief v2.md", kind: "markdown" }, "notes/x.md", paths)).toBe("docs/brief v2.md");
    expect(resolveLink({ target: "specs/API", kind: "markdown" }, "docs/x.md", paths)).toBe("docs/specs/API.md");
    expect(resolveLink({ target: "../../escape.md", kind: "markdown" }, "x.md", paths)).toBeNull();
  });

  it("keys spellings of one link alike", () => {
    expect(linkKey("./Docs\\Plan.md")).toBe("docs/plan");
  });
});

describe("rewriting", () => {
  it("writes the shortest unambiguous target and keeps alias, anchor and embed", () => {
    const paths = ["a/Plan.md", "b/Plan.md", "Ideas.md"];
    expect(linkTarget("Ideas.md", "x.md", paths)).toBe("Ideas");
    expect(linkTarget("b/Plan.md", "a/x.md", paths)).toBe("b/Plan");
    const [link] = parseNote("![[Old#Part|shown]]").links;
    expect(rewriteLink(link!, "Ideas.md", "x.md", paths)).toBe("![[Ideas#Part|shown]]");
    const [md] = parseNote("[text](old.md#h)").links;
    expect(rewriteLink(md!, "b/Plan.md", "a/x.md", paths)).toBe("[text](../b/Plan.md#h)");
  });

  it("writes a markdown link that reads back as the same file, brackets and hashes included", () => {
    for (const name of ["Plan (mine).md", "C# notes.md", "a b/it's 100%.md"]) {
      const [link] = parseNote(`[x](${encodeHref(name)})`).links;
      expect(link!.target).toBe(name);
      expect(decodeHref(encodeHref(name))).toBe(name);
    }
    const [old] = parseNote("[x](old.md)").links;
    expect(rewriteLink(old!, "Plan (mine).md", "x.md", ["Plan (mine).md"])).toBe("[x](Plan%20%28mine%29.md)");
  });

  it("places a new note beside the linking one unless the link names a folder", () => {
    expect(newNotePath("Next steps", "docs/plan.md")).toBe("docs/Next steps.md");
    expect(newNotePath("ideas/Later", "docs/plan.md")).toBe("ideas/Later.md");
    expect(newNotePath("  ", "x.md")).toBeNull();
  });
});
