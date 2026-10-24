import { describe, expect, it } from "vitest";
import { isMachinePath, normalizeRepoPath, repoPathLabel, repoSubfolder } from "@tomradex/domain";

describe("a workstream's folder in its repository", () => {
  it("is stored with forward slashes and no doubled or trailing separators; an absolute spelling keeps its lead", () => {
    expect(normalizeRepoPath("  packages//ui/ ")).toBe("packages/ui");
    expect(normalizeRepoPath("packages\\ui\\")).toBe("packages/ui");
    expect(normalizeRepoPath("/packages/ui/")).toBe("/packages/ui");
    expect(normalizeRepoPath("D:\\codexApp\\goods-list")).toBe("D:/codexApp/goods-list");
    expect(normalizeRepoPath("\\\\nas\\code\\app")).toBe("//nas/code/app");
    expect(normalizeRepoPath("")).toBe("");
    expect(normalizeRepoPath("/")).toBe("");
  });

  it("tells a place on a machine from a folder in the repository", () => {
    expect(isMachinePath("D:\\codexApp\\goods-list")).toBe(true);
    expect(isMachinePath("c:/work/app")).toBe(true);
    expect(isMachinePath("\\\\server\\share\\app")).toBe(true);
    expect(isMachinePath("/packages/ui")).toBe(false);
    expect(isMachinePath("packages/ui")).toBe(false);
  });

  it("reads an absolute path inside the checkout as the folder it names, on either separator and drive-letter case", () => {
    expect(repoSubfolder("D:\\codexApp\\goods-list", "D:\\codexApp\\goods-list")).toBe("");
    expect(repoSubfolder("d:/codexapp/goods-list/apps/web", "D:\\codexApp\\goods-list")).toBe("apps/web");
    expect(repoSubfolder("/Users/me/app/packages/ui", "/Users/me/app")).toBe("packages/ui");
    expect(repoSubfolder("/Users/me/app/", "/Users/me/app")).toBe("");
    expect(repoSubfolder("/Users/me/application", "/Users/me/app")).toBe("Users/me/application");
  });

  it("keeps a relative path, strips a leading slash, and refuses a drive or UNC path elsewhere", () => {
    expect(repoSubfolder("packages\\ui", "D:\\codexApp\\goods-list")).toBe("packages/ui");
    expect(repoSubfolder("/packages/ui", "/Users/me/app")).toBe("packages/ui");
    expect(repoSubfolder("", "/Users/me/app")).toBe("");
    expect(repoSubfolder("D:\\elsewhere\\app", "D:\\codexApp\\goods-list")).toBeNull();
    expect(repoSubfolder("\\\\nas\\code\\app", "D:\\codexApp\\goods-list")).toBeNull();
  });

  it("labels a path as the folder it means when the checkout is known", () => {
    expect(repoPathLabel("D:\\codexApp\\goods-list", "D:\\codexApp\\goods-list")).toBe("");
    expect(repoPathLabel("D:\\codexApp\\goods-list\\apps\\web", "D:\\codexApp\\goods-list")).toBe("apps/web");
    expect(repoPathLabel("D:\\elsewhere", "D:\\codexApp\\goods-list")).toBe("D:/elsewhere");
    expect(repoPathLabel("/packages/ui/", null)).toBe("packages/ui");
    expect(repoPathLabel("/Users/me/app/packages/ui", "/Users/me/app")).toBe("packages/ui");
  });
});
