// Uploads a release build's installers and update files straight to the R2 bucket behind
// download.tomrade.com, under <version>/, from the runner that built them. Nothing points at that
// folder until the release is published and the site's mirror writes the update manifests, so an
// unpublished or failed build there reaches no one.
//   node apps/desktop/scripts/upload-r2.mjs 0.11.0 release/Tomrade-0.11.0-*
// Needs CLOUDFLARE_API_TOKEN (CI) or `npx wrangler login`; CLOUDFLARE_ACCOUNT_ID when the token sees
// more than the one account.
// The headers match haoyuant/tomrade-site's scripts/mirror-release.mjs, which uploads the same way
// for a release whose files aren't in the bucket yet.
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { basename } from "node:path";

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

const wrangler = (args, timeout) =>
  new Promise((resolve, reject) => {
    const child = execFile("npx", ["--yes", WRANGLER, ...args], { timeout, maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
      // Killed at the timeout, npx passes the signal on and wrangler can still exit 0, which execFile
      // reports as success: v0.27.0's arm64 DMG "uploaded" in exactly 600 s and wasn't in the bucket.
      if (!error && child.killed) error = Object.assign(new Error("timed out"), { killed: true });
      if (error) reject(error);
      else resolve(stdout);
    });
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What every upload needs, fetched once and retried like an upload. */
async function upFront(what, work) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt === ATTEMPTS) throw error;
      console.log(`${what}: attempt ${attempt} failed; retrying`);
      await sleep(BACKOFF_MS * attempt);
    }
  }
}

// Once up front, so the parallel uploads don't each install it into the same npx cache.
await upFront("wrangler", () => wrangler(["--version"], 5 * 60_000));

// Each put is checked against the bucket itself through Cloudflare's API, as the site's mirror
// checks what's up: wrangler's exit code alone has passed a file that never arrived.
// Locally, the token of `wrangler login`; its output has a banner above the token.
const token = process.env.CLOUDFLARE_API_TOKEN ||
  (await upFront("wrangler auth token", () => wrangler(["auth", "token"], 5 * 60_000))).split(/\s+/).findLast((word) => /^[\w.-]{20,}$/.test(word));
if (!token) throw new Error("No Cloudflare token: set CLOUDFLARE_API_TOKEN or run `npx wrangler login`");

async function api(path) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000)
  });
  const body = await res.json().catch(() => null);
  if (!body?.success) throw new Error(`Cloudflare API ${path}: HTTP ${res.status} ${JSON.stringify(body?.errors ?? [])}`);
  return body.result;
}

const account = process.env.CLOUDFLARE_ACCOUNT_ID || (await upFront("Cloudflare account", () => api("/accounts")))[0]?.id;
if (!account) throw new Error("The Cloudflare token sees no account: set CLOUDFLARE_ACCOUNT_ID");

/** The size of `key` in the bucket, or undefined when it isn't there. */
async function sizeInBucket(key) {
  const objects = await api(`/accounts/${account}/r2/buckets/${BUCKET}/objects?prefix=${encodeURIComponent(key)}&per_page=10`);
  return objects.find((o) => o.key === key)?.size;
}

async function upload(file) {
  const name = basename(file);
  const key = `${version}/${name}`;
  const size = statSync(file).size;
  const type = TYPES[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream";
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      // A version's files never change, so browsers and the edge may keep them for good.
      await wrangler(
        ["r2", "object", "put", `${BUCKET}/${key}`, "--file", file, "--remote",
          "--content-type", type,
          "--content-disposition", `attachment; filename="${name}"`,
          "--cache-control", "public, max-age=31536000, immutable"],
        TIMEOUT_MS
      );
      const up = await sizeInBucket(key).catch((error) => {
        throw Object.assign(error, { check: true });
      });
      if (up !== size) {
        throw Object.assign(new Error(), { mismatch: up === undefined ? "not in the bucket" : `${up} bytes in the bucket, not ${size}` });
      }
      console.log(`↑ ${key} (${Math.round((Date.now() - started) / 1000)} s)`);
      return;
    } catch (error) {
      const why = error.mismatch
        ? `wrangler said uploaded, but it is ${error.mismatch}`
        : error.check ? `uploaded, but checking the bucket failed: ${error.message}`
        : error.killed ? `upload timed out after ${TIMEOUT_MS / 60_000} min` : `upload failed: ${String(error.stderr || error.message).trim()}`;
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
