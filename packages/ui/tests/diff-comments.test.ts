import { createElement, createRef, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { ChangedFile, ChangeHunk, ChangesView } from "@tomradex/code-link";
import { DiffFile } from "../src/components/diff/DiffFile";
import { DiffView, type DiffComment, type DiffViewProps } from "../src/components/diff/DiffView";
import type { NoteActions } from "../src/components/diff/DiffComments";

vi.mock("~/components/icons", () => ({ Icon: () => null }));
vi.mock("~/components/ui/atoms", () => ({ FoldChevron: ({ open, label }: { open: boolean; label?: string }) => createElement("i", { "data-fold": String(open), title: label }) }));
vi.mock("~/lib/i18n", () => ({ useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(" ")}` : key) }) }));

const hunk: ChangeHunk = {
  oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, header: "",
  lines: [
    { kind: "context", old: 10, new: 10, text: "function total() {" },
    { kind: "del", old: 11, new: null, text: "  return price * count;" },
    { kind: "add", old: null, new: 11, text: "  const sum = price * quantity;" },
    { kind: "add", old: null, new: 12, text: "  return sum;" },
    { kind: "context", old: 12, new: 13, text: "}" }
  ]
};
const file = (over: Partial<ChangedFile> = {}): ChangedFile => ({ path: "src/total.ts", oldPath: null, status: "modified", additions: 2, deletions: 1, binary: false, generated: false, truncated: false, hunks: [hunk], ...over });
const changes = (files: ChangedFile[]): ChangesView => ({ linkId: "l", links: [], scopes: ["branch"], commits: [], scope: { kind: "branch" }, base: "aaa", head: "bbb", root: null, runs: [], report: null, files });
const note = (over: Partial<DiffComment> = {}): DiffComment => ({ id: "c1", path: "src/total.ts", side: "new", line: 11, endLine: 11, quote: "  const sum = price * quantity;", body: "Name it subtotal.\nIt is not the sum yet.", state: "open", sent: false, createdAt: Date.now() - 120_000, ...over });
const stored = (values: Record<string, string>) => vi.stubGlobal("localStorage", { getItem: (key: string) => values[key] ?? null, setItem() {}, removeItem() {} });
const render = (files: ChangedFile[], props: Partial<DiffViewProps> = {}) => renderToStaticMarkup(createElement(DiffView, { changes: changes(files), ignoreWhitespace: false, onIgnoreWhitespace() {}, ...props }));
const all = { onAddComment() {}, onEditComment() {}, onRemoveComment() {} };
/** The rows and threads of the markup, in order, each cut at its opening tag. */
const order = (html: string, ...marks: string[]) => marks.map((mark) => html.indexOf(mark));

afterEach(() => vi.unstubAllGlobals());

it("draws nothing about comments until the surface gives some or a way to make one", () => {
  const html = render([file()]);
  expect(html).not.toContain("diff__add");
  expect(html).not.toContain("diff.commentsCount");
  expect(render([file()], { commentsAction: createElement("b", null, "send") })).not.toContain("<b>send</b>");
});

it("offers a comment on each line: the old side for a deleted line, the new side for the rest", () => {
  const html = render([file()], { onAddComment() {} });
  expect(html.match(/class="diff__add"/g)).toHaveLength(5);
  expect(html).toContain('<span class="diff__num diff__num--del"><button type="button" class="diff__add" aria-label="diff.addComment line=11"');
  expect(html).toContain('<span class="diff__num diff__num--add">12<button type="button" class="diff__add" aria-label="diff.addComment line=12"');
  expect(html).toContain("diff.commentsCount count=0");

  stored({ "tomrade.diff.layout": "split" });
  const split = render([file()], { onAddComment() {} });
  // Side by side an unchanged line is drawn twice and commented on once, as it reads now.
  expect(split.match(/class="diff__add"/g)).toHaveLength(5);
  expect(split).toContain('<span class="diff__num diff__num--context">10</span><span class="diff__code diff__code--context">');
  expect(split).toContain('<span class="diff__num diff__num--del">11<button type="button" class="diff__add" aria-label="diff.addComment line=11"');
});

it("shows a comment under the last line of its range, with what can be done to it", () => {
  const html = render([file()], { comments: [note({ endLine: 12, quote: "  const sum = price * quantity;\n  return sum;", sent: true })], ...all });
  const [last, thread, next] = order(html, 'diff__num--add">12', 'class="diff__thread"', 'diff__num--context">12</span>');
  expect(last).toBeGreaterThan(0);
  expect(thread).toBeGreaterThan(last);
  expect(next).toBeGreaterThan(thread);
  expect(html).toContain('data-comment-id="c1"');
  expect(html).toContain("diff.commentLines from=11 to=12");
  expect(html).toContain('<div class="diff__comment-body">Name it subtotal.\nIt is not the sum yet.</div>');
  for (const word of ["diff.commentSent", "diff.commentEdit", "diff.commentResolve", "diff.commentDelete"]) expect(html).toContain(word);
  expect(html).toContain("diff.commentsCount count=1");
  expect(html).toContain("diff.commentsOnFile count=1");

  const readOnly = render([file()], { comments: [note()] });
  expect(readOnly).toContain("diff__comment-body");
  for (const word of ["diff__add", "diff.commentEdit", "diff.commentResolve", "diff.commentDelete", "diff.commentSent"]) expect(readOnly).not.toContain(word);
});

it("puts a comment on the side it is about when the diff is side by side", () => {
  stored({ "tomrade.diff.layout": "split" });
  const html = render([file()], { comments: [note(), note({ id: "c2", side: "old", quote: "  return price * count;", body: "Why did this go?" })] });
  expect(html.match(/class="diff__thread diff__thread--old"/g)).toHaveLength(1);
  expect(html.match(/class="diff__thread diff__thread--new"/g)).toHaveLength(1);
  expect(html.indexOf("Why did this go?")).toBeLessThan(html.indexOf("Name it subtotal."));
  expect(html).toContain("diff.commentOldSide lines=diff.commentLine line=11");
});

it("keeps a comment on its lines when the diff shifts, and says so when they are gone", () => {
  const shifted: ChangeHunk = { ...hunk, lines: [{ kind: "add", old: null, new: 10, text: "// totals" }, ...hunk.lines.map((line) => ({ ...line, new: line.new === null ? null : line.new + 1 }))] };
  const moved = render([file({ hunks: [shifted] })], { comments: [note()], ...all });
  expect(moved).toContain("diff.commentLine line=12");
  expect(moved).not.toContain("diff.commentOutdated");

  const rewritten: ChangeHunk = { ...hunk, lines: hunk.lines.map((line) => (line.new === 11 ? { ...line, text: "  const subtotal = price * quantity;" } : line)) };
  const gone = render([file({ hunks: [rewritten] })], { comments: [note()], ...all });
  const [outdated, firstHunk] = order(gone, 'data-testid="diff-outdated"', 'class="diff__hunk"');
  expect(outdated).toBeGreaterThan(0);
  expect(outdated).toBeLessThan(firstHunk);
  expect(gone).toContain('<pre class="diff__quote">  const sum = price * quantity;</pre>');
  expect(gone).toContain("diff.commentOutdatedNote");
  expect(gone).not.toContain('class="diff__thread"');
});

it("folds a resolved comment to one line that can be reopened, and leaves it out of the counts", () => {
  const html = render([file()], { comments: [note({ state: "resolved" })], ...all });
  expect(html).toContain('class="diff__note is-resolved"');
  expect(html).toContain('data-fold="false"');
  expect(html).toContain("diff.commentReopen");
  expect(html).toContain('<span class="diff__comment-brief">Name it subtotal.');
  for (const word of ["diff__comment-body", "diff.commentEdit", "diff.commentDelete"]) expect(html).not.toContain(word);
  expect(html).toContain("diff.commentsCount count=0");
  expect(html).not.toContain("diff.commentsOnFile");
});

it("opens the fold a commented line would be hidden in", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ kind: "context" as const, old: 20 + i, new: 20 + i, text: `line ${20 + i}` }));
  const long: ChangeHunk = { ...hunk, lines: [...hunk.lines, ...many, { kind: "add", old: null, new: 33, text: "tail" }] };
  expect(render([file({ hunks: [long] })], { comments: [] })).toContain("diff__fold");
  const html = render([file({ hunks: [long] })], { comments: [note({ line: 26, endLine: 26, quote: "line 26" })] });
  expect(html).not.toContain("diff__fold");
  expect(html).toContain("diff.commentLine line=26");
});

it("leaves a comment whose file is not drawn to the list alone", () => {
  const html = render([file({ hunks: null, truncated: true })], { comments: [note(), note({ id: "c2", path: "src/gone.ts" })], commentsAction: createElement("b", null, "send") });
  expect(html).not.toContain("data-comment-id");
  expect(html).toContain("diff.commentsCount count=2");
  expect(html).toContain("<b>send</b>");
});

it("draws the comment being written under its lines, which are marked", () => {
  const actions: NoteActions = { canAdd: true, canEdit: true, canRemove: true, pick() {}, typed: () => "half a thought", type() {}, async saveDraft() {}, cancelDraft() {}, startEdit() {}, async saveEdit() {}, cancelEdit() {}, setState() {}, remove() {} };
  const body = (notes: ReactNode | object) =>
    renderToStaticMarkup(
      createElement(DiffFile, {
        index: 0, file: file(), layout: "unified", open: true, viewed: false, quiet: null, load: "idle", canLoad: false, opened: [], scroller: createRef<HTMLElement>(),
        onToggle() {}, onViewed() {}, onLoad() {}, onUnfold() {}, noteActions: actions, notes: notes as never
      })
    );
  const anchor = { side: "new" as const, line: 11, endLine: 12, quote: "  const sum = price * quantity;\n  return sum;" };
  const html = body({ placed: [], outdated: [], editing: null, draft: { anchor, place: { hunk: 0, first: 2, last: 3, line: 11, endLine: 12 } } });
  expect(html.match(/class="diff__row is-picked"/g)).toHaveLength(2);
  const [last, composer, next] = order(html, 'diff__num--add">12', 'data-testid="diff-composer"', 'diff__num--context">12</span>');
  expect(last).toBeGreaterThan(0);
  expect(composer).toBeGreaterThan(last);
  expect(next).toBeGreaterThan(composer);
  expect(html).toContain(">half a thought</textarea>");
  expect(html).toContain("diff.commentRangeHint");

  const adrift = body({ placed: [], outdated: [], editing: null, draft: { anchor, place: null } });
  expect(adrift).not.toContain("is-picked");
  expect(adrift.indexOf('data-testid="diff-composer"')).toBeLessThan(adrift.indexOf('class="diff__hunk"'));

  const editing = body({ placed: [{ comment: note(), place: { hunk: 0, first: 2, last: 2, line: 11, endLine: 11 } }], outdated: [], editing: "c1", draft: null });
  expect(editing).toContain("diff.commentSaveEdit");
  expect(editing).not.toContain("diff__comment-body");
});

it("names an agent's finding as one, with how much it matters and who found it", () => {
  const finding = note({ finding: { reviewer: "ai:reviewer", severity: "warning" } });
  const html = render([file()], { comments: [finding, note({ id: "c2", line: 12, endLine: 12, quote: "  return sum;" })], ...all });
  expect(html.match(/data-testid="diff-finding"/g)).toHaveLength(1);
  expect(html).toContain("diff.finding");
  expect(html).toContain("diff.findingWarning");
  expect(html).toContain('title="ai:reviewer"');
});

it("draws a picture's two versions side by side, and offers to read one only where the name says picture", () => {
  const body = (over: Partial<ChangedFile>) =>
    renderToStaticMarkup(createElement(DiffFile, { index: 0, file: file({ binary: true, hunks: null, ...over }), layout: "unified", open: true, viewed: false, quiet: null, load: "idle", canLoad: true, opened: [], scroller: createRef<HTMLElement>(), onToggle() {}, onViewed() {}, onLoad() {}, onUnfold() {} }));
  const both = body({ path: "logo.png", image: { before: "data:image/png;base64,before", after: "data:image/png;base64,after" } });
  expect(both).toContain('src="data:image/png;base64,before"');
  expect(both).toContain('src="data:image/png;base64,after"');
  const added = body({ path: "logo.png", status: "added", image: { before: null, after: "data:image/png;base64,after" } });
  expect(added.match(/<img /g)).toHaveLength(1);
  expect(added).toContain("diff.imageAbsent");
  expect(body({ path: "logo.png" })).toContain("diff.loadImage");
  // Read and found to be no picture, or never one by its name: the binary file it always was.
  for (const plain of [body({ path: "logo.png", image: null }), body({ path: "font.woff2" })]) {
    expect(plain).toContain("diff.binaryFile");
    expect(plain).not.toContain("diff.loadImage");
    expect(plain).not.toContain("diff__images");
  }
});
