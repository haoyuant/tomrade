// `pnpm test`: runs vitest on a node whose launches are fast (docs/testing.md).
// `pnpm test:related` (`--related`): only the tests that reach the files changed against origin/main.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

// Full runs from every session on this machine share one syspolicyd and the CPUs: one at a time beats all timing out together.
const LOCK = path.join(os.tmpdir(), "tomrade-full-test-run");
const OWNER = path.join(LOCK, "owner.json");

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};

// A path or a file name narrows the run to part of the suite, which needs no lock.
const related = process.argv[2] === "--related";
const args = process.argv.slice(related ? 3 : 2);
const narrowed = related || args.some((arg) => !arg.startsWith("-") && (arg.includes("/") || arg.includes(".") || fs.existsSync(path.resolve(root, arg))));

async function takeLock() {
  let said = false;
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      fs.writeFileSync(OWNER, JSON.stringify({ pid: process.pid, dir: root }));
      const release = () => {
        try {
          if (JSON.parse(fs.readFileSync(OWNER, "utf8")).pid === process.pid) fs.rmSync(LOCK, { recursive: true, force: true });
        } catch {
          // Already gone.
        }
      };
      process.on("exit", release);
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    let owner = null;
    try {
      owner = JSON.parse(fs.readFileSync(OWNER, "utf8"));
    } catch {
      // Taken a moment ago and not written yet, or left half-made by a run that died between the two steps.
      const age = Date.now() - (fs.statSync(LOCK, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > 10_000) fs.rmSync(LOCK, { recursive: true, force: true });
    }
    if (owner && !alive(owner.pid)) {
      console.log(`[test] taking over the lock of a run that ended (pid ${owner.pid})`);
      fs.rmSync(LOCK, { recursive: true, force: true });
      continue;
    }
    if (owner && !said) {
      console.log(`[test] waiting for the test run in ${owner.dir} (pid ${owner.pid})`);
      said = true;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

if (!narrowed) await takeLock();

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

/** Runs vitest with these arguments; with `look`, `found` says whether it had a test file to run (its output is piped to tell). */
function vitest(argv, look = false) {
  return new Promise((resolve) => {
    const child = spawn(node.bin, [path.join(root, "node_modules/vitest/vitest.mjs"), ...argv], { cwd: root, env, stdio: ["inherit", look ? "pipe" : "inherit", "inherit"] });
    let found = true;
    child.stdout?.on("data", (chunk) => {
      if (/No test files found/.test(String(chunk))) found = false;
      process.stdout.write(chunk);
    });
    const stop = (sig) => child.kill(sig);
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, stop);
    child.on("exit", (code, signal) => resolve({ code: signal ? 1 : (code ?? 1), found }));
    child.on("error", (err) => {
      console.error(`[test] could not start ${node.bin}: ${err.message}`);
      resolve({ code: 1, found });
    });
  });
}

const lines = (cmd) => {
  const r = spawnSync("git", cmd, { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : [];
};

/** Files this branch changed against origin/main, committed or not, that still exist. */
function changedFiles() {
  const base = lines(["merge-base", "origin/main", "HEAD"])[0];
  if (!base) {
    console.error("[test] no merge base with origin/main; fetch it first");
    process.exit(1);
  }
  const all = [...lines(["diff", "--name-only", base]), ...lines(["ls-files", "--others", "--exclude-standard"])];
  return [...new Set(all)].filter((f) => fs.lstatSync(path.join(root, f), { throwIfNoEntry: false })?.isFile());
}

let code;
if (!related) code = (await vitest(["run", ...args])).code;
else {
  const files = changedFiles();
  if (!files.length) {
    console.log("[test] nothing changed against origin/main");
    code = 0;
  } else {
    console.log(`[test] related to ${files.length} changed file(s)`);
    const first = await vitest(["related", "--run", "--passWithNoTests", ...args, ...files], true);
    code = first.code;
    if (!first.found) {
      // Nothing imports the change statically (a script, a fixture, a config): run the tests of the packages it is in.
      const dirs = [...new Set(files.map((f) => f.split("/").slice(0, 2).join("/")))].map((d) => `${d}/tests`).filter((d) => fs.existsSync(path.join(root, d)));
      if (dirs.length) {
        console.log(`[test] no test imports those files; running ${dirs.join(", ")}`);
        code = (await vitest(["run", ...args, ...dirs])).code;
      } else console.log("[test] no test imports those files, and no package tests to fall back on");
    }
  }
}
clearTimeout(slow);
process.exit(code);
