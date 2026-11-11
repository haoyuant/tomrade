import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { ChangedFile, ChangeHunk, ChangesView } from "@tomradex/code-link";
import { DiffView } from "../src/components/diff/DiffView";
import { markViewed } from "../src/components/diff/viewed";

vi.mock("~/components/icons", () => ({ Icon: () => null }));
vi.mock("~/components/ui/atoms", () => ({ FoldChevron: () => null }));
vi.mock("~/lib/i18n", () => ({ useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(" ")}` : key) }) }));

const hunk: ChangeHunk = {
  oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, header: "function total()",
  lines: [
    { kind: "context", old: 10, new: 10, text: "function total() {" },
    { kind: "del", old: 11, new: null, text: "  return price * count;" },
    { kind: "add", old: null, new: 11, text: "  return price * quantity;" },
    { kind: "context", old: 12, new: 12, text: "}" }
  ]
};
const file = (over: Partial<ChangedFile> = {}): ChangedFile => ({ path: "src/total.ts", oldPath: null, status: "modified", additions: 1, deletions: 1, binary: false, generated: false, truncated: false, hunks: [hunk], ...over });
const changes = (files: ChangedFile[]): ChangesView => ({ linkId: "l", links: [], scopes: ["branch"], commits: [], scope: { kind: "branch" }, base: "aaa", head: "bbb", root: null, files });
const stored = (values: Record<string, string>) => vi.stubGlobal("localStorage", { getItem: (key: string) => values[key] ?? null, setItem() {}, removeItem() {} });
const render = (view: ChangesView | null, props: { viewedKey?: string; loading?: boolean; ignoreWhitespace?: boolean } = {}) =>
  renderToStaticMarkup(createElement(DiffView, { changes: view, ignoreWhitespace: false, onIgnoreWhitespace() {}, ...props }));

afterEach(() => vi.unstubAllGlobals());

it("draws a file's lines one under the other, with both line numbers, the changed word marked and the code coloured", () => {
  const html = render(changes([file()]));
  expect(html).toContain('data-layout="unified"');
  expect(html).not.toContain("diff__row--split");
  expect(html).toContain('<span class="diff__num diff__num--del">11</span><span class="diff__num diff__num--del"></span>');
  expect(html).toContain('<span class="diff__num diff__num--add"></span><span class="diff__num diff__num--add">11</span>');
  expect(html).toContain('<span class="diff__word">count</span>');
  expect(html).toContain('<span class="diff__word">quantity</span>');
  expect(html).toContain('<span class="diff__tok diff__tok--keyword">return</span>');
  expect(html).toContain('diff.unchangedLines count=9');
  expect(html).toContain("function total()</span>");
  expect(html).toContain('diff.summary count=1 additions=1 deletions=1');
});

it("draws the deleted line beside the added one when side by side was chosen", () => {
  stored({ "tomrade.diff.layout": "split" });
  const html = render(changes([file()]));
  expect(html).toContain('data-layout="split"');
  const row = html.split('class="diff__row diff__row--split"').find((part) => part.includes("diff__code--del"))!;
  expect(row).toContain('<span class="diff__num diff__num--del">11</span>');
  expect(row).toContain('<span class="diff__num diff__num--add">11</span>');
  expect(row.indexOf("count")).toBeLessThan(row.indexOf("quantity"));
});

it("starts generated and binary files folded with a line saying why, and says when a file's diff was left out", () => {
  const html = render(changes([
    file({ path: "pnpm-lock.yaml", generated: true }),
    file({ path: "logo.png", binary: true, additions: null, deletions: null, hunks: null }),
    file({ path: "src/big.ts", hunks: null, truncated: true })
  ]));
  expect(html).toContain("diff.generatedFolded");
  expect(html).toContain("diff.binaryFile");
  expect(html).toContain("diff.notLoaded");
  expect(html).not.toContain("diff__row");
});

it("keeps a viewed file folded and checked until its diff changes", () => {
  stored({ "tomrade.diff.viewed.TOM-1": JSON.stringify(markViewed({}, file(), true)) });
  const viewed = render(changes([file()]), { viewedKey: "TOM-1" });
  expect(viewed).toContain('checked=""');
  expect(viewed).not.toContain("diff__row");
  expect(viewed).toContain('diff.viewedCount viewed=1 count=1');

  const moved = render(changes([file({ hunks: [{ ...hunk, lines: [...hunk.lines.slice(0, 2), { kind: "add", old: null, new: 11, text: "  return 0;" }, hunk.lines[3]] }] })]), { viewedKey: "TOM-1" });
  expect(moved).not.toContain('checked=""');
  expect(moved).toContain("diff__row");
});

it("says so when there is nothing to show", () => {
  expect(render(null, { loading: true })).toContain("diff.loading");
  expect(render(null)).toContain("diff.empty");
  expect(render(changes([]), { ignoreWhitespace: true })).toContain("diff.emptyWhitespace");
});
