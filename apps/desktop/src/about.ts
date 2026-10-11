import { app, net } from "electron";
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

export interface UpdateCheck {
  latest: string;
  /** ISO time the latest release was published. */
  date: string | null;
  newer: boolean;
}

/** Written by the mirror script once the installers it names are up; the website reads the same file. */
const LATEST = "https://download.tomrade.com/latest.json";

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

/** Electron's net, not Node's fetch, so the request goes through the system proxy like the browser's would. */
export async function checkForUpdate(): Promise<UpdateCheck> {
  const res = await net.fetch(LATEST, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`download.tomrade.com answered ${res.status}`);
  const manifest = (await res.json()) as { version?: unknown; date?: unknown };
  if (typeof manifest.version !== "string") throw new Error("download.tomrade.com sent no version");
  return {
    latest: manifest.version,
    date: typeof manifest.date === "string" ? manifest.date : null,
    newer: compareVersions(manifest.version, app.getVersion()) > 0
  };
}

/** Semver precedence: the numbers first, then a pre-release sorts before its release. Build metadata is ignored. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("+")[0].split(/-(.*)/s);
    return { core: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (!x.pre.length || !y.pre.length) return Math.sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Math.sign(Number(p) - Number(q));
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
