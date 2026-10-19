/**
 * Against a git server that wants a password, because the point is that the
 * password never sits in the remote URL: a provider names a credential helper,
 * Tomrade's own git commands use it and nothing else, and a remote left with a
 * token in its URL by an earlier version is cleaned the first time it is used.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { fresh, settle } from "@tomradex/testkit";
import { Storage } from "@tomradex/storage";
import storageGit, { createRemoteProvider } from "@tomradex/storage-git";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-credential-"));
const servers: http.Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
let n = 0;

/** Smart HTTP through `git http-backend`, for whoever presents `x-access-token:<token>`. */
async function server(token: string) {
  const dir = path.join(root, `served-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-q", "--bare", "-b", "main", "repo.git"], dir);
  const seen: string[] = [];
  const expected = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const s = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    if (auth) seen.push(Buffer.from(auth.replace(/^Basic /, ""), "base64").toString());
    if (auth !== expected) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' }).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const cgi = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: dir,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: String(req.headers["content-type"] ?? ""),
        HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""),
        HTTP_GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
        REMOTE_USER: "x-access-token",
        REMOTE_ADDR: "127.0.0.1"
      }
    });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let started = false;
    cgi.stdout.on("data", (chunk: Buffer) => {
      if (started) return void res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.subarray(0, end).toString().split("\r\n")) {
        const at = line.indexOf(":");
        const [name, value] = [line.slice(0, at).trim(), line.slice(at + 1).trim()];
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
        else headers[name] = value;
      }
      res.writeHead(status, headers);
      started = true;
      res.write(head.subarray(end + 4));
    });
    cgi.stdout.on("end", () => res.end());
  });
  servers.push(s);
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  return { origin, url: `${origin}/repo.git`, bare: path.join(dir, "repo.git"), seen };
}

const Config = z.object({ branch: z.string().default("main") });

async function machine(target: { origin: string; url: string }, password: string) {
  const hubDir = path.join(root, `hub-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  const bag = await fresh({ hubDir, plugins: [[Storage, { snapshotIdleMs: 3_600_000, snapshotMaxMs: 3_600_000, watch: false, reconcileMs: 0, remoteFreshMs: 0, remoteRetryMs: 0 }], storageGit] });
  await settle();
  let connected = true;
  bag.ctx.storage.register(
    createRemoteProvider({
      id: "served",
      title: "A served repository",
      configSchema: Config,
      defaults: { branch: "main" },
      toRemote: (c) => ({ url: target.url, branch: c.branch }),
      credential: () => (connected ? { url: target.origin, helper: `!f() { test "$1" = get && echo username=x-access-token && echo password=${password}; }; f` } : null)
    })
  );
  await bag.ctx.storage.ready;
  return { ...bag, storage: bag.ctx.storage, dir: bag.hub.catalog.project(bag.project.id)!.dir!, disconnect: () => (connected = false) };
}

describe("a remote that wants a password", () => {
  it("pushes through the provider's helper with a clean URL, and the user's own helpers are never asked", async () => {
    const remote = await server("right-token");
    // The person's own git config names another account, which must not be tried.
    const global = path.join(root, `global-${n++}.config`);
    fs.writeFileSync(global, '[credential]\n\thelper = "!f() { echo username=x-access-token; echo password=wrong-token; }; f"\n');
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = global;
    try {
      const a = await machine(remote, "right-token");
      a.items.create({ title: "Pushed with a helper", projectId: a.project.id, boardId: a.board.id, by: "human" });
      expect((await a.storage.bind(a.project.id, "served", { branch: "main" })).state).toBe("synced");
      expect(git(["log", "-1", "--format=%s", "main"], remote.bare)).toMatch(/^tomrade:/);
      expect(git(["remote", "get-url", "origin"], a.dir)).toBe(remote.url);
      expect(fs.readFileSync(path.join(a.dir, ".git", "config"), "utf8")).not.toMatch(/right-token|helper/);
      expect(remote.seen.every((s) => s === "x-access-token:right-token")).toBe(true);

      // Disconnected: the user's own credentials are in charge again — here, the wrong account.
      a.disconnect();
      expect((await a.storage.statusFor(a.project.id)).state).toBe("offline");
      expect(remote.seen).toContain("x-access-token:wrong-token");
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  });

  it("takes the token out of a remote URL an earlier version wrote, and leaves another repository's alone", async () => {
    const remote = await server("right-token");
    const a = await machine(remote, "right-token");
    await a.storage.bind(a.project.id, "served", { branch: "main" });
    // What an earlier version left behind.
    git(["remote", "set-url", "origin", remote.url.replace("http://", "http://x-access-token:old-token@")], a.dir);

    a.items.create({ title: "After the upgrade", projectId: a.project.id, boardId: a.board.id, by: "human" });
    await a.storage.publish(a.project.id);
    expect(git(["remote", "get-url", "origin"], a.dir)).toBe(remote.url);
    expect(fs.readFileSync(path.join(a.dir, ".git", "config"), "utf8")).not.toContain("old-token");
    expect(remote.seen).not.toContain("x-access-token:old-token");
    expect(git(["show", "main:.tomrade/state/items.jsonl"], remote.bare)).toContain("After the upgrade");

    const elsewhere = "http://someone:kept@127.0.0.1:9/elsewhere.git";
    git(["remote", "set-url", "origin", elsewhere], a.dir);
    await a.storage.statusFor(a.project.id);
    expect(git(["remote", "get-url", "origin"], a.dir)).toBe(elsewhere);
  });
});
