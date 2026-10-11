import { app } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface AboutInfo {
  version: string;
  /** False for a checkout, which updates from git rather than from releases. */
  packaged: boolean;
  commit: string | null;
  /** ISO time the installer was built. Null for a checkout. */
  builtAt: string | null;
  electron: string;
  chrome: string;
  node: string;
  v8: string;
  os: string;
  arch: string;
  userData: string;
}

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/** An installer carries its build in package.json (scripts/package.mjs); a checkout asks git. */
async function build(repoRoot: string): Promise<{ commit: string | null; builtAt: string | null }> {
  if (app.isPackaged) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"));
      return { commit: pkg.commit ?? null, builtAt: pkg.builtAt ?? null };
    } catch {
      return { commit: null, builtAt: null };
    }
  }
  const commit = await new Promise<string | null>((resolve) =>
    execFile("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, timeout: 3_000 }, (error, stdout) => resolve(error ? null : stdout.trim() || null))
  );
  return { commit, builtAt: null };
}

let cached: Promise<AboutInfo> | undefined;

export function aboutInfo(repoRoot: string): Promise<AboutInfo> {
  cached ??= build(repoRoot).then(({ commit, builtAt }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    commit,
    builtAt,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    os: `${OS_NAMES[process.platform] ?? process.platform} ${process.getSystemVersion()}`,
    arch: process.arch,
    userData: app.getPath("userData")
  }));
  return cached;
}
