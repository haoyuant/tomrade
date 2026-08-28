// cordis first: @tomrade/storage augments it, and a `declare module "cordis"`
// reached before cordis itself declares a new module instead of augmenting one.
import type {} from "cordis";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { ARTIFACT_DIR, type StorageHandle, type StorageProvider, type StorageStatus } from "@tomrade/storage";
import { GitError, gitRunner, type Git } from "./run.js";

/** Where a provider's config says the artifact lives, in git terms. */
export interface GitTarget {
  remote: string;
  branch: string;
  /** Subdirectory of the repository holding `.tomrade`; "" is the repository root. */
  path: string;
}

export interface GitRuntime {
  /** Root for clones. Always inside userData — never a synced folder. */
  root: string;
  binary: string;
}

export interface GitProviderOptions<C> {
  id: string;
  title: string;
  description?: string;
  configSchema: z.ZodType<C>;
  defaults: C;
  settingsSection?: string;
  /** Passed through: a hosting provider supplies the account and the shortcuts. */
  connection?: StorageProvider<C>["connection"];
  draft?: StorageProvider<C>["draft"];
  toTarget(config: C): Promise<GitTarget> | GitTarget;
  /** Bring the destination into existence — create the repository, say. */
  ensureRemote?(config: C, target: GitTarget): Promise<void>;
  browse?(): Promise<{ label: string; config: C }[]>;
}

const clean = (remote: string): string => remote.replace(/\/\/[^@/]*@/, "//");

/** A clone with no identity cannot commit; set one locally rather than failing at flush. */
async function ensureIdentity(git: Git, dir: string): Promise<void> {
  const email = await git(["config", "--get", "user.email"], { cwd: dir, ok: true });
  if (email.code === 0 && email.stdout.trim()) return;
  await git(["config", "--local", "user.email", "tomrade@localhost"], { cwd: dir, ok: true });
  await git(["config", "--local", "user.name", "Tomrade"], { cwd: dir, ok: true });
}

async function ensureClone(git: Git, dir: string, target: GitTarget): Promise<void> {
  if (fs.existsSync(path.join(dir, ".git"))) {
    await git(["remote", "set-url", "origin", target.remote], { cwd: dir });
    await ensureIdentity(git, dir);
    return;
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const cloned = await git(["clone", "--branch", target.branch, "--single-branch", target.remote, dir], { ok: true });
  if (cloned.code === 0) return ensureIdentity(git, dir);
  // An empty repository, or a branch that does not exist yet: start it here.
  fs.mkdirSync(dir, { recursive: true });
  await git(["init", "-b", target.branch], { cwd: dir });
  await git(["remote", "add", "origin", target.remote], { cwd: dir });
  const fetched = await git(["fetch", "origin", target.branch], { cwd: dir, ok: true });
  if (fetched.code === 0) await git(["reset", "--hard", `origin/${target.branch}`], { cwd: dir, ok: true });
  await ensureIdentity(git, dir);
}

async function aheadBehind(git: Git, dir: string, branch: string): Promise<{ ahead: number; behind: number } | null> {
  const counted = await git(["rev-list", "--left-right", "--count", `HEAD...origin/${branch}`], { cwd: dir, ok: true });
  if (counted.code !== 0) return null;
  const [ahead, behind] = counted.stdout.trim().split(/\s+/).map(Number);
  return { ahead: ahead || 0, behind: behind || 0 };
}

/**
 * The git mechanism, shared by every hosting provider: the clone lives under
 * userData (SQLite is never here, only the text artifact), the working copy is
 * brought forward fast-forward only, and a push that is not fast-forward is
 * reported rather than forced.
 */
export function createGitProvider<C>(opts: GitProviderOptions<C>, runtime: GitRuntime): StorageProvider<C> {
  return {
    id: opts.id,
    title: opts.title,
    description: opts.description,
    configSchema: opts.configSchema,
    defaults: opts.defaults,
    settingsSection: opts.settingsSection,
    browse: opts.browse,
    draft: opts.draft,
    connection: opts.connection,

    async open(config, { create }): Promise<StorageHandle> {
      const target = await opts.toTarget(config);
      const git = gitRunner(runtime.binary);
      if (create) await opts.ensureRemote?.(config, target);
      // Keyed by the destination, not by the project: an attach has to open the
      // clone before it can learn which project is inside it.
      const dir = path.join(runtime.root, createHash("sha256").update(`${clean(target.remote)}#${target.branch}#${target.path}`).digest("hex").slice(0, 16));
      await ensureClone(git, dir, target);
      const work = target.path ? path.join(dir, target.path) : dir;
      if (create) fs.mkdirSync(path.join(work, ARTIFACT_DIR), { recursive: true });
      const label = `${clean(target.remote).replace(/^https?:\/\//, "").replace(/\.git$/, "")} · ${target.branch}${target.path ? ` · ${target.path}` : ""}`;

      return {
        location: label,
        dir: work,

        async pull() {
          await git(["fetch", "origin", target.branch], { cwd: dir });
          const counts = await aheadBehind(git, dir, target.branch);
          if (!counts || counts.behind === 0) return { changed: false };
          if (counts.ahead > 0) {
            throw new Error(`${label} has moved on and this machine has unpublished commits — resolve the divergence before syncing`);
          }
          await git(["merge", "--ff-only", `origin/${target.branch}`], { cwd: dir });
          return { changed: true };
        },

        async push(message) {
          const rel = target.path ? path.join(target.path, ARTIFACT_DIR) : ARTIFACT_DIR;
          // Only ever our own subtree: this may be the user's own checkout, and
          // `git add -A` there would sweep up their unrelated work.
          await git(["add", "--", rel], { cwd: dir });
          const staged = await git(["diff", "--cached", "--quiet"], { cwd: dir, ok: true });
          if (staged.code !== 0) await git(["commit", "-m", message], { cwd: dir });
          const pushed = await git(["push", "origin", `HEAD:refs/heads/${target.branch}`], { cwd: dir, ok: true });
          if (pushed.code !== 0) {
            // The rejection is the first news of their commits, so refresh the
            // remote ref before deciding what to tell the user.
            await git(["fetch", "origin", target.branch], { cwd: dir, ok: true });
            const counts = await aheadBehind(git, dir, target.branch);
            if (counts && counts.behind > 0) throw new Error(`${label} has commits this machine has not seen — sync before publishing`);
            throw new GitError(["push"], `could not publish to ${label}`);
          }
        },

        async status(): Promise<Omit<StorageStatus, "lastSyncAt">> {
          const fetched = await git(["fetch", "origin", target.branch], { cwd: dir, ok: true });
          if (fetched.code !== 0) return { state: "offline", location: label, detail: `Cannot reach ${label}` };
          const counts = await aheadBehind(git, dir, target.branch);
          if (!counts) return { state: "synced", location: label, detail: "Nothing published yet" };
          if (counts.ahead > 0 && counts.behind > 0) return { state: "diverged", location: label, detail: `${counts.ahead} local, ${counts.behind} remote` };
          if (counts.behind > 0) return { state: "behind", location: label, detail: `${counts.behind} behind` };
          return { state: "synced", location: label };
        },

        async dispose() {}
      };
    }
  };
}
