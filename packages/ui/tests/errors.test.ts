import { expect, it } from "vitest";
import { ConflictError, DependencyCycleError, HumanLockedError, InUseError, NotFoundError } from "@tomradex/domain";
import { UnpublishedEditsError } from "@tomradex/storage";
import { messageOf } from "../src/lib/api";
import { domainErrorWords } from "../src/lib/errors";
import { en, zh } from "../src/lib/i18n-messages";

/** What the renderer holds after a handler threw `error`: Electron's wrapper around its toString. */
const overIpc = (error: Error) => new Error(`Error invoking remote method 'tomrade:items.update': ${String(error)}`);
const wordsOf = (error: Error) => domainErrorWords(messageOf(overIpc(error)));
const said = (dict: typeof en, key: string) => (dict.errors as Record<string, string>)[key.replace("errors.", "")];
/** The words as a locale shows them, filled the way `t` fills them. */
const shown = (dict: typeof en, error: Error) => {
  const words = wordsOf(error)!;
  return said(dict, words.key).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => words.vars?.[name] ?? "");
};

it("says each typed domain refusal in words, with no id in them", () => {
  const id = "0f8e1c7a-2b9d-4c55-9e1a-6f4d3b2a1c00";
  expect(wordsOf(new ConflictError(id, 4, 5))).toEqual({ key: "errors.conflict" });
  expect(wordsOf(new HumanLockedError(id, ["title"]))).toEqual({ key: "errors.humanLocked" });
  expect(wordsOf(new NotFoundError(id))).toEqual({ key: "errors.notFound" });
  for (const error of [new ConflictError(id, 4, 5), new HumanLockedError(id, ["title"]), new NotFoundError(id)]) {
    for (const dict of [en, zh]) expect(shown(dict, error)).not.toContain(id);
    expect(shown(zh, error)).not.toMatch(/[A-Za-z]{3,}/);
    expect(shown(zh, error)).not.toBe(shown(en, error));
  }
});

// Worded as the boards, views, oplog and repos services word them.
const reasons = [
  ["Workstream Core still holds 3 issues — move them first", "工作流「Core」里还有 3 个工作项——请先把它们移走。"],
  ["Workstream Core is the project's last; new issues need somewhere to land", "「Core」是这个项目的最后一个工作流，新的工作项需要有地方放。"],
  ["Board is the project's last view", "「Board」是这个项目的最后一个视图。"],
  ["That workstream now holds 1 issue — move them before undoing it", "这个工作流现在有 1 个工作项——请先把它们移走，再撤销。"],
  ["tomrade is still the repository of 2 workstreams", "「tomrade」仍是 2 个工作流的代码仓库。"]
];

it("keeps why something is still in use: the reason itself in English, its own words in Chinese", () => {
  for (const [reason, chinese] of reasons) {
    const error = new InUseError("id", reason);
    expect(shown(en, error)).toBe(reason);
    expect(shown(zh, error)).toBe(chinese);
  }
});

it("an in-use reason it does not know still reaches the person, after a Chinese lead", () => {
  const error = new InUseError("id", "Something new depends on it");
  expect(shown(en, error)).toBe("Something new depends on it");
  expect(shown(zh, error)).toBe("它仍在被使用：Something new depends on it");
});

it("keeps a cycle's ticket keys, which read the same in any language", () => {
  const words = wordsOf(new DependencyCycleError("id", ["TOM-1", "TOM-2", "TOM-1"]));
  expect(words).toEqual({ key: "errors.cycle", vars: { path: "TOM-1 → TOM-2 → TOM-1" } });
  expect(shown(zh, new DependencyCycleError("id", ["TOM-1", "TOM-2", "TOM-1"]))).toContain("TOM-1 → TOM-2 → TOM-1");
});

it("says why a rebuild was refused, keeping the folder's own reason", () => {
  const error = new UnpublishedEditsError("id", "/tmp/p/.tomrade/project.json holds unresolved git conflict markers");
  expect(wordsOf(error)).toEqual({ key: "errors.unpublishedEdits", vars: { reason: "/tmp/p/.tomrade/project.json holds unresolved git conflict markers" } });
  expect(shown(zh, error)).toMatch(/^本机还有文件夹里没有的编辑（\/tmp\/p\/\.tomrade\/project\.json holds/);
});

it("leaves every other error to its own words", () => {
  expect(domainErrorWords(messageOf(overIpc(new Error("disk I/O error"))))).toBeNull();
  expect(domainErrorWords(messageOf(overIpc(new TypeError("x is undefined"))))).toBeNull();
  expect(domainErrorWords("version conflict somewhere in prose")).toBeNull();
});
