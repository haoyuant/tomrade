import { expect, it } from "vitest";
import { ConflictError, DependencyCycleError, HumanLockedError, InUseError, NotFoundError } from "@tomradex/domain";
import { messageOf } from "../src/lib/api";
import { domainErrorWords } from "../src/lib/errors";
import { en, zh } from "../src/lib/i18n-messages";

/** What the renderer holds after a handler threw `error`: Electron's wrapper around its toString. */
const overIpc = (error: Error) => new Error(`Error invoking remote method 'tomrade:items.update': ${String(error)}`);
const wordsOf = (error: Error) => domainErrorWords(messageOf(overIpc(error)));
const said = (dict: typeof en, key: string) => (dict.errors as Record<string, string>)[key.replace("errors.", "")];

it("says each typed domain refusal in words, with no id in them", () => {
  const id = "0f8e1c7a-2b9d-4c55-9e1a-6f4d3b2a1c00";
  expect(wordsOf(new ConflictError(id, 4, 5))).toEqual({ key: "errors.conflict" });
  expect(wordsOf(new HumanLockedError(id, ["title"]))).toEqual({ key: "errors.humanLocked" });
  expect(wordsOf(new NotFoundError(id))).toEqual({ key: "errors.notFound" });
  expect(wordsOf(new InUseError(id, "Workstream Core still holds 3 issues — move them first"))).toEqual({ key: "errors.inUse" });
  for (const error of [new ConflictError(id, 4, 5), new HumanLockedError(id, ["title"]), new NotFoundError(id), new InUseError(id, "x")]) {
    const key = wordsOf(error)!.key;
    expect(said(en, key)).toBeTruthy();
    expect(said(zh, key)).toBeTruthy();
    expect(said(zh, key)).not.toBe(said(en, key));
    expect(said(zh, key)).not.toMatch(/[A-Za-z]{3,}/);
  }
});

it("keeps a cycle's ticket keys, which read the same in any language", () => {
  const words = wordsOf(new DependencyCycleError("id", ["TOM-1", "TOM-2", "TOM-1"]));
  expect(words).toEqual({ key: "errors.cycle", vars: { path: "TOM-1 → TOM-2 → TOM-1" } });
  expect(said(en, "errors.cycle")).toContain("{{path}}");
  expect(said(zh, "errors.cycle")).toContain("{{path}}");
});

it("leaves every other error to its own words", () => {
  expect(domainErrorWords(messageOf(overIpc(new Error("disk I/O error"))))).toBeNull();
  expect(domainErrorWords(messageOf(overIpc(new TypeError("x is undefined"))))).toBeNull();
  expect(domainErrorWords("version conflict somewhere in prose")).toBeNull();
});
