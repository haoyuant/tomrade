// Uploads a release build's installers and update files straight to the R2 bucket behind
// download.tomrade.com, under <version>/, from the runner that built them. Nothing points at that
// folder until the release is published and the site's mirror writes the update manifests, so an
// unpublished or failed build there reaches no one.
//   node apps/desktop/scripts/upload-r2.mjs 0.11.0 release/Tomrade-0.11.0-*
// Needs CLOUDFLARE_API_TOKEN (CI) or `npx wrangler login`.
// The headers match haoyuant/tomrade-site's scripts/mirror-release.mjs, which uploads the same way
// for a release whose files aren't in the bucket yet.
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const BUCKET = "tomrade-downloads";
const WRANGLER = "wrangler@4.149.0";
const CONCURRENCY = 3;
const ATTEMPTS = 6;
// The self-hosted Mac's line drops for a minute or two at a time: wait longer after each failure.
const BACKOFF_MS = 20_000;
const TIMEOUT_MS = 10 * 60_000;

const TYPES = {
  ".dmg": "application/x-apple-diskimage",
  ".zip": "application/zip",
  ".exe": "application/x-msdownload"
};

const [version, ...files] = process.argv.slice(2);
if (!version || files.length === 0) {
  console.error("usage: node upload-r2.mjs <version> <file>...");
  process.exit(1);
}

const run = promisify(execFile);
const wrangler = (args, timeout) => run("npx", ["--yes", WRANGLER, ...args], { timeout, maxBuffer: 16 << 20 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Once up front, so the parallel uploads don't each install it into the same npx cache.
for (let attempt = 1; ; attempt++) {
  try {
    await wrangler(["--version"], 5 * 60_000);
    break;
  } catch (error) {
    if (attempt === ATTEMPTS) throw error;
    console.log(`wrangler: attempt ${attempt} failed; retrying`);
    await sleep(BACKOFF_MS * attempt);
  }
}

async function upload(file) {
  const name = basename(file);
  const type = TYPES[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream";
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      // A version's files never change, so browsers and the edge may keep them for good.
      await wrangler(
        ["r2", "object", "put", `${BUCKET}/${version}/${name}`, "--file", file, "--remote",
          "--content-type", type,
          "--content-disposition", `attachment; filename="${name}"`,
          "--cache-control", "public, max-age=31536000, immutable"],
        TIMEOUT_MS
      );
      console.log(`↑ ${version}/${name} (${Math.round((Date.now() - started) / 1000)} s)`);
      return;
    } catch (error) {
      const why = error.killed ? `timed out after ${TIMEOUT_MS / 60_000} min` : String(error.stderr || error.message).trim();
      if (attempt === ATTEMPTS) throw new Error(`${name}: ${why}`);
      console.log(`${name}: attempt ${attempt} failed (${why}); retrying in ${(BACKOFF_MS * attempt) / 1000} s`);
      await sleep(BACKOFF_MS * attempt);
    }
  }
}

const queue = [...files];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) await upload(queue.shift());
  })
);
