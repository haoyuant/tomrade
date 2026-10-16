import { describe, expect, it } from "vitest";
import { githubPull, readPull } from "@tomradex/code-link";

describe("a link's GitHub pull request", () => {
  it("is read from its URL, else from a GitHub remote with its number", async () => {
    expect(await githubPull("https://github.com/acme/app/pull/12", null, "/somewhere/local")).toEqual({ repo: "acme/app", number: 12 });
    expect(await githubPull(null, 7, "https://github.com/Acme/App.git")).toEqual({ repo: "acme/app", number: 7 });
    expect(await githubPull(null, 7, "git@github.com:acme/app.git")).toEqual({ repo: "acme/app", number: 7 });
    expect(await githubPull(null, 7, "https://gitlab.com/acme/app.git")).toBeNull();
    expect(await githubPull(null, null, "https://github.com/acme/app.git")).toBeNull();
    expect(await githubPull(null, 7, "/Users/me/projects/app")).toBeNull();
  });

  it("takes GitHub's merge commit only once it merged", () => {
    expect(readPull({ state: "closed", merged: true, merge_commit_sha: "abc", base: { ref: "main" } })).toEqual({ merged: true, state: "closed", mergeSha: "abc", base: "main" });
    expect(readPull({ state: "open", merged: false, merge_commit_sha: "trial", base: { ref: "main" } })).toEqual({ merged: false, state: "open", mergeSha: null, base: "main" });
    expect(readPull({ message: "Not Found" })).toBeNull();
  });
});
