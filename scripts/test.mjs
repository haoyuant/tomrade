// `pnpm test`: runs vitest on a node whose launches are fast (docs/testing.md).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// On macOS syspolicyd checks a notarized binary online at every launch; adhoc-signed or unsigned ones skip that.
function skipsOnlineCheck(bin) {
  // codesign -dv reports on stderr, and exits non-zero for an unsigned binary.
  const r = spawnSync("codesign", ["-dv", bin], { encoding: "utf8", timeout: 5_000 });
  return /Signature=adhoc|not signed at all/.test(r.stderr ?? "");
}

function pickNode() {
  const explicit = process.env.TOMRADE_TEST_NODE;
  if (explicit) return { bin: explicit, why: "TOMRADE_TEST_NODE" };
  if (process.platform !== "darwin") return { bin: process.execPath, why: "current node" };
  const onPath = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, "node"));
  const seen = new Set();
  for (const bin of [process.execPath, ...onPath, "/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    let real;
    try {
      real = fs.realpathSync(bin);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    if (skipsOnlineCheck(real)) return { bin, why: real === fs.realpathSync(process.execPath) ? "current node, adhoc-signed" : "adhoc-signed" };
  }
  return { bin: process.execPath, why: "current node; no adhoc-signed node found" };
}

const node = pickNode();
console.log(`[test] node: ${node.bin} (${node.why})`);

// Advisory: warns while the run is already going, never delays it.
const probe = spawn(node.bin, ["-e", "0"], { stdio: "ignore" });
const slow = setTimeout(() => {
  console.warn(
    `[test] warning: starting ${node.bin} took over 1 s. On macOS a notarized node waits on an online check at every spawn, ` +
      "so tests time out in bulk. Install Homebrew's node or set TOMRADE_TEST_NODE to an adhoc-signed node (docs/testing.md)."
  );
  probe.kill();
}, 1_000);
probe.on("exit", () => clearTimeout(slow));
probe.on("error", () => clearTimeout(slow));
probe.unref();

// The node's own directory goes first on PATH, so fakes spawned as plain `node` use it too.
const env = { ...process.env, PATH: [path.dirname(node.bin), process.env.PATH].filter(Boolean).join(path.delimiter) };
const child = spawn(node.bin, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", ...process.argv.slice(2)], { cwd: root, env, stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => {
  clearTimeout(slow);
  process.exit(signal ? 1 : (code ?? 1));
});
child.on("error", (err) => {
  console.error(`[test] could not start ${node.bin}: ${err.message}`);
  process.exit(1);
});
