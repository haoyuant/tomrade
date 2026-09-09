import { describe, expect, it } from "vitest";
import { branchFor, keysInText, parseBranch, slugify } from "@tomrade/code-link";

describe("keys", () => {
  it("names a branch from the template", () => {
    expect(branchFor("{key}/{slug}", "TOM-42", "Push notifications!")).toBe("tom-42/push-notifications");
    expect(branchFor("feat/{KEY}-{slug}", "TOM-42", "Push")).toBe("feat/TOM-42-push");
    expect(branchFor("{num}-{slug}", "TOM-42", "Push")).toBe("42-push");
    expect(slugify("中文标题")).toBe("work");
    expect(slugify("  Über  läuft  ")).toBe("uber-lauft");
  });

  it("reads the key back wherever the template put it", () => {
    expect(parseBranch("tom-42/push", "TOM")).toBe(42);
    expect(parseBranch("origin/feat/TOM-42-push", "TOM")).toBe(42);
    expect(parseBranch("refs/remotes/origin/tom-7", "TOM")).toBe(7);
    expect(parseBranch("refs/heads/TOM-7", "TOM")).toBe(7);
    expect(parseBranch("atom-42/x", "TOM")).toBeNull();
    expect(parseBranch("tom-42abc", "TOM")).toBeNull();
    expect(parseBranch("main", "TOM")).toBeNull();
  });

  it("finds every key a commit message names, once, in order", () => {
    expect(keysInText("TOM-42: add push\n\nRefs TOM-42, tom-7. Not XTOM-9 or TOM-10a", "TOM")).toEqual([42, 7]);
    expect(keysInText("nothing here", "TOM")).toEqual([]);
  });
});
