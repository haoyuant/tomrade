import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CheckResult } from "@tomradex/contracts";
import type { CodeWords } from "./words.js";

/** The GitHub CLI on this machine, which opens, merges and reads pull requests: signed in, there but signed out, or not there. */
export interface GhStatus {
  state: "ready" | "signed-out" | "missing";
  path?: string;
  version?: string;
}

export const GH_INSTALL_URL = "https://cli.github.com";

const answer = (args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; stdout: string }> =>
  new Promise((resolve) => {
    execFile("gh", args, { timeout: 15_000, env }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout) }));
  });

/** Where gh runs from, the way a spawn by name finds it. */
function located(env: NodeJS.ProcessEnv): string | undefined {
  const names = process.platform === "win32" ? ["gh.exe", "gh.cmd"] : ["gh"];
  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

/** Runs gh by name, as the pull request code does, so what it finds is what that code gets. */
export async function probeGh(env: NodeJS.ProcessEnv = process.env): Promise<GhStatus> {
  const version = await answer(["--version"], env);
  if (!version.ok) return { state: "missing" };
  const file = located(env);
  const number = /gh version (\S+)/.exec(version.stdout)?.[1];
  const auth = await answer(["auth", "status"], env);
  return { state: auth.ok ? "ready" : "signed-out", ...(file ? { path: file } : {}), ...(number ? { version: number } : {}) };
}

/** The troubleshooter's row: gh is a recommendation, so missing or signed out is never a warning or a failure. */
export function ghRow(status: GhStatus, w: CodeWords): CheckResult {
  const where = status.path ?? "gh";
  const facts = { "gh.path": status.path ?? (status.state === "missing" ? "none" : "gh"), "gh.version": status.version ?? "", "gh.auth": status.state === "ready" ? "ok" : status.state };
  if (status.state === "ready") return { state: "ok", line: w("ghReady", { path: where, version: status.version ?? "" }), facts };
  if (status.state === "signed-out") return { state: "skip", line: w("ghSignedOut", { path: where, version: status.version ?? "" }), facts };
  return { state: "skip", line: w("ghMissing", { url: GH_INSTALL_URL }), facts };
}
