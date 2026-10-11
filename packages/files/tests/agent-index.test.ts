import { describe, expect, it } from "vitest";
import { buildAgentIndex, estimateTokens, type FileEntry, type FilesAgentPolicy } from "@tomradex/files";

const day = 24 * 60 * 60 * 1000;
const listed: FilesAgentPolicy = { default: "listed", rules: [] };

let clock = Date.now();
const file = (path: string, opts: { size?: number; age?: number } = {}): FileEntry => ({
  path,
  name: path.split("/").pop()!,
  kind: "file",
  size: opts.size ?? 1024,
  modifiedAt: clock - (opts.age ?? 0) * day,
  fileId: path
});
const dir = (path: string): FileEntry => ({ path, name: path.split("/").pop()!, kind: "dir", size: 0, modifiedAt: clock, fileId: null });

/** Depth first, folders before files — the order `tree()` promises. */
function tree(...paths: string[]): FileEntry[] {
  const seen = new Set<string>();
  const out: FileEntry[] = [];
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      if (!seen.has(folder)) { seen.add(folder); out.push(dir(folder)); }
    }
    out.push(file(p));
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "dir" ? -1 : 1));
}

const build = (entries: FileEntry[], over: Partial<Parameters<typeof buildAgentIndex>[0]> = {}) =>
  buildAgentIndex({ entries, policy: listed, titleOf: () => null, ...over });

describe("the agent index", () => {
  it("names every file while the project is small, with its size and date", () => {
    const index = build(tree("Specs/brief.md", "Specs/api/auth.md", "notes.md"));
    expect(index.markdown).toContain("Specs/brief.md");
    expect(index.markdown).toContain("Specs/api/auth.md");
    expect(index.markdown).toContain("notes.md");
    expect(index.listed).toBe(3);
    expect(index.total).toBe(3);
    // A file without a title is still a line; the size and date are what make it worth reading.
    expect(index.markdown).toMatch(/notes\.md — 1k · \d/);
    expect(index.markdown).not.toContain("keeps out of this index");
  });

  it("quotes the title a document gives itself, and a folder's README", () => {
    const entries = tree("Specs/brief.md", "Specs/README.md");
    const titles: Record<string, string> = { "Specs/brief.md": "Product brief v3", Specs: "Interfaces and contracts" };
    const index = build(entries, { titleOf: (e) => titles[e.path] ?? null });
    expect(index.markdown).toContain("Specs/brief.md — 1k · ");
    expect(index.markdown).toContain("Product brief v3");
    expect(index.markdown).toContain("Specs/ (2) — Interfaces and contracts");
  });

  it("folds the biggest folders to fit the budget, keeping what it folded countable", () => {
    const entries = tree(...Array.from({ length: 120 }, (_, i) => `Meetings/${String(i).padStart(3, "0")}.md`), "Specs/brief.md");
    const index = build(entries, { budget: 200 });
    expect(index.tokens).toBeLessThanOrEqual(200);
    expect(index.markdown).toMatch(/Meetings\/ \(120 files, newest /);
    expect(index.markdown).not.toContain("Meetings/001.md");
    // Folding hides names, never the fact that there is something there.
    expect(index.listed).toBe(121);
  });

  it("keeps the ticket's own folder open however tight the budget", () => {
    const entries = tree(
      ...Array.from({ length: 60 }, (_, i) => `Meetings/${String(i).padStart(3, "0")}.md`),
      ...Array.from({ length: 20 }, (_, i) => `Payments/doc-${String(i).padStart(2, "0")}.md`)
    );
    const index = build(entries, { budget: 220, focus: ["Payments"] });
    expect(index.markdown).toContain("Payments/doc-00.md");
    expect(index.markdown).toMatch(/Meetings\/ \(60 files/);
  });

  it("shows the newest of a crowded folder and says how many it did not", () => {
    const entries = tree(...Array.from({ length: 30 }, (_, i) => `Inbox/n${String(i).padStart(2, "0")}.md`));
    entries.forEach((e, i) => { if (e.kind === "file") e.modifiedAt = clock - i * day; });
    const index = build(entries, { budget: 5_000 });
    expect(index.markdown).toContain("Inbox/n00.md");
    expect(index.markdown).toContain("… 18 more here (list_files to see them)");
    expect(index.markdown).not.toContain("Inbox/n29.md");
  });

  it("drops an unlisted subtree whole, and says that something is missing without naming it", () => {
    const entries = tree("Specs/brief.md", "Private/pay.md", "Private/deep/more.md");
    const index = build(entries, { policy: { default: "listed", rules: [{ path: "Private", mode: "unlisted" }] } });
    expect(index.markdown).not.toContain("Private");
    expect(index.markdown).not.toContain("pay.md");
    expect(index.listed).toBe(1);
    expect(index.total).toBe(3);
    expect(index.markdown).toContain("Paths the person keeps out of this index");
    expect(index.markdown).toContain("still reads and writes normally");
  });

  it("leaves a workstream's attachments out by default, and says so apart from the person's rules", () => {
    const entries = tree("Web/brief.md", "Web/attachments/TOM-1/shot.png", "attachments/top-level.png");
    const index = build(entries);
    expect(index.markdown).not.toContain("shot.png");
    expect(index.markdown).toContain("attachments/top-level.png");
    expect(index.markdown).toContain("Tickets' attachments/ folders are not shown");
    expect(index.markdown).not.toContain("Paths the person keeps out");

    const opened = build(entries, { policy: { default: "listed", rules: [{ path: "Web/attachments", mode: "listed" }] } });
    expect(opened.markdown).toContain("Web/attachments/TOM-1/shot.png");
    // a rule above the folder does not reach past its built-in default
    const above = build(entries, { policy: { default: "listed", rules: [{ path: "Web", mode: "listed" }] } });
    expect(above.markdown).not.toContain("shot.png");
  });

  it("lets a deeper rule open one file inside an unlisted folder", () => {
    const entries = tree("Private/pay.md", "Private/for-agent.md");
    const index = build(entries, {
      policy: { default: "listed", rules: [{ path: "Private", mode: "unlisted" }, { path: "Private/for-agent.md", mode: "listed" }] }
    });
    expect(index.markdown).toContain("Private/for-agent.md");
    expect(index.markdown).not.toContain("pay.md");
  });

  it("tells an engine with its own file tools where the folder is, and one without which tool to call", () => {
    const entries = tree("Specs/brief.md");
    const native = build(entries, { native: true, root: "/Users/h/Tomrade/projects/p/files" });
    expect(native.markdown).toContain("/Users/h/Tomrade/projects/p/files");
    expect(native.markdown).toContain("Skip .tomrade-files/");
    expect(native.markdown).not.toContain("search_files finds text");

    const inApp = build(entries, { root: "/Users/h/Tomrade/projects/p/files" });
    expect(inApp.markdown).not.toContain("/Users/h/Tomrade");
    expect(inApp.markdown).toContain("search_files finds text");
  });

  it("changes its digest only when the text changes", () => {
    const entries = tree("Specs/brief.md");
    expect(build(entries).digest).toBe(build([...entries]).digest);
    expect(build(entries).digest).not.toBe(build(tree("Specs/brief.md", "extra.md")).digest);
    expect(build(entries).tokens).toBe(estimateTokens(build(entries).markdown));
  });

  it("has nothing to say about an empty store", () => {
    expect(build([]).markdown).toContain("0 files");
  });
});
