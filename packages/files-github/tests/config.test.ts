import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import GitHubAccount from "@tomradex/github";
import { Settings } from "@tomradex/settings";
import { Storage } from "@tomradex/storage";
import { Files } from "@tomradex/files";
import { filesGithub } from "@tomradex/files-github";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-files-github-config-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;

async function machine() {
  const hubDir = path.join(root, `hub-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  const bag = await fresh({
    hubDir,
    plugins: [
      [Settings, { path: path.join(hubDir, "settings.json") }], GitHubAccount,
      [Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0 }],
      [Files, { watch: false, autoSyncMs: 0 }],
      filesGithub
    ]
  });
  await settle();
  await bag.ctx.storage.ready;
  return bag;
}

describe("GitHub Files config", () => {
  it("keeps legacy configs at repository root while new drafts use project-files", async () => {
    const { ctx } = await machine();
    try {
      const backend = ctx.files.get("github");
      expect(backend.defaults).toEqual({ owner: "", repo: "", branch: "main", directory: "" });
      expect(backend.configSchema.parse({ owner: "acme", repo: "repo" })).toEqual({ owner: "acme", repo: "repo", branch: "main", directory: "" });
      expect(backend.configSchema.parse({ owner: "acme", repo: "repo", branch: "legacy", directory: "" })).toEqual({ owner: "acme", repo: "repo", branch: "legacy", directory: "" });
      const draft = await ctx.files.draft("github", "acme/repo");
      expect(draft).toEqual({ owner: "acme", repo: "repo", branch: "main", directory: "project-files" });
      expect(backend.configSchema.parse(draft)).toEqual(draft);
      const view = ctx.files.describe().find((b) => b.id === "github");
      expect(view?.schema).toMatchObject({ properties: { directory: { type: "string", default: "" } } });
      expect(view?.defaults).toEqual(backend.defaults);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("accepts scoped directories and rejects traversal or hidden repository paths", async () => {
    const { ctx } = await machine();
    try {
      const schema = ctx.files.get("github").configSchema;
      const config = { owner: "acme", repo: "repo" };
      for (const directory of ["", "project-files", "docs/project-files"]) {
        expect(schema.safeParse({ ...config, directory }).success, directory).toBe(true);
      }
      for (const directory of ["..", "../docs", "docs/../src", "/docs", "docs\\..\\src", ".git", "docs/.hidden", "./docs", "docs//nested", "docs/"]) {
        expect(schema.safeParse({ ...config, directory }).success, directory).toBe(false);
      }
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
