import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * On macOS /usr/bin/git is a shim that runs git again through xcrun: two or
 * three execs per command, and each exec can wait on the system's policy
 * check. Tests (and the code they drive) find the real binary first; it sits
 * just before /usr/bin, so nothing else on PATH changes.
 */
function directGit(): void {
  if (process.platform !== "darwin") return;
  try {
    const real = execFileSync("xcrun", ["--find", "git"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
    const dir = path.dirname(real);
    const parts = (process.env.PATH ?? "").split(":");
    const at = parts.indexOf("/usr/bin");
    if (!real || dir === "/usr/bin" || at === -1 || parts.includes(dir)) return;
    process.env.PATH = [...parts.slice(0, at), dir, ...parts.slice(at)].join(":");
  } catch {
    // No developer tools: git is whatever PATH finds.
  }
}
directGit();

export default defineConfig({
  resolve: {
    // Tests run against sources, so no package needs building first.
    alias: [
      { find: /^@tomradex\/([^/]+)$/, replacement: `${root}packages/$1/src/index.ts` }
    ]
  },
  test: {
    include: ["packages/*/tests/**/*.test.ts", "apps/*/tests/**/*.test.ts"],
    // The usual output, then every failure sorted into timeout-under-load, network or real (docs/testing.md).
    reporters: ["default", "./packages/testkit/src/failure-kinds.ts"],
    // A poll waits on work the test started; 1 s is too tight on a loaded machine, and the test's own timeout stays the ceiling.
    expect: { poll: { timeout: 30_000 } }
  }
});
