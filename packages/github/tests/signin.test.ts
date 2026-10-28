/**
 * Signing in to the Tomrade GitHub App, against a stand-in for github.com: the
 * device code, the wait, the short-lived token renewed before it runs out (and
 * the renewal token turned over each time), the token kept encrypted across a
 * restart, and the personal access token taking over when the sign-in stops
 * working.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { fresh, settle } from "@tomradex/testkit";
import { Settings } from "@tomradex/settings";
import { credentialArgs } from "@tomradex/git";
import GitHubAccount, { type Cipher } from "@tomradex/github";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-signin-"));
const servers: http.Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** github.com and api.github.com in one: what the App's sign-in and the REST calls it makes need. */
async function fakeGitHub(opts: { accessSeconds?: number; installations?: number; decline?: boolean } = {}) {
  const state = { pendingPolls: 1, refreshes: 0, refresh: "", access: new Set<string>(), installations: opts.installations ?? 0, n: 0 };
  const grant = () => {
    state.n++;
    const access = `ghu_${state.n}`;
    state.refresh = `ghr_${state.n}`;
    state.access.add(access);
    return { access_token: access, expires_in: opts.accessSeconds ?? 28_800, refresh_token: state.refresh, refresh_token_expires_in: 15_897_600, token_type: "bearer", scope: "" };
  };
  const s = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const json = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      const input = body ? (JSON.parse(body) as Record<string, string>) : {};
      if (req.url === "/login/device/code") {
        if (input.client_id !== "Iv-test") return json(200, { error: "unauthorized_client" });
        return json(200, { device_code: "dc", user_code: "WDJB-MJHT", verification_uri: `${origin}/login/device`, expires_in: 900, interval: 1 });
      }
      if (req.url === "/login/oauth/access_token") {
        if (input.grant_type === "refresh_token") {
          if (input.refresh_token !== state.refresh) return json(200, { error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." });
          state.refreshes++;
          return json(200, grant());
        }
        if (opts.decline) return json(200, { error: "access_denied" });
        if (state.pendingPolls-- > 0) return json(200, { error: "authorization_pending" });
        return json(200, grant());
      }
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!state.access.has(token) && token !== "ghp_pat") return json(401, { message: "Bad credentials" });
      if (req.url === "/user") return json(200, { login: "me" });
      if (req.url?.startsWith("/user/installations/1/repositories")) return json(200, { total_count: 1, repositories: [{ full_name: "me/chosen", name: "chosen", owner: { login: "me" }, default_branch: "main", private: true, pushed_at: null }] });
      if (req.url?.startsWith("/user/installations")) return json(200, { total_count: state.installations, installations: state.installations ? [{ id: 1 }] : [] });
      if (req.url?.startsWith("/user/repos")) return json(200, [{ full_name: "me/chosen", name: "chosen", owner: { login: "me" } }, { full_name: "me/other", name: "other", owner: { login: "me" } }]);
      json(404, { message: "Not Found" });
    });
  });
  servers.push(s);
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  return { origin, state };
}

/** Stands in for safeStorage: reversible, but nothing readable on disk. */
const cipher: Cipher = {
  available: () => true,
  encrypt: (value) => Buffer.from(Buffer.from(value).toString("base64").split("").reverse().join("")),
  decrypt: (value) => Buffer.from(value.toString().split("").reverse().join(""), "base64").toString()
};

let n = 0;
async function machine(github: { origin: string }, opts: { userData?: string; clientId?: string } = {}) {
  const userData = opts.userData ?? path.join(root, `user ${n++}`);
  fs.mkdirSync(userData, { recursive: true });
  const config = { clientId: opts.clientId ?? "Iv-test", appSlug: "tomrade", webUrl: github.origin, apiUrl: github.origin, pollUnitMs: 5, ghToken: async () => "", sessionFile: path.join(userData, "github-session.enc"), cipher };
  const bag = await fresh({ plugins: [[Settings, { path: path.join(userData, "settings.json") }], [GitHubAccount, config]] });
  return { ...bag, github: bag.ctx.github, userData };
}

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
};

/** The password git gets for github.com from Tomrade's helper. */
function gitPassword(args: string[]): string {
  const out = execFileSync("git", [...args, "credential", "fill"], {
    input: "protocol=https\nhost=github.com\npath=me/app.git\n\n",
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" }
  });
  return /password=(.*)/.exec(out)?.[1] ?? "";
}

it("signs in with a device code, asks for repository access, and hands the session's token to git", async () => {
  const gh = await fakeGitHub();
  const { github, userData } = await machine(gh);
  expect(github.connection.prompt.signIn).toEqual({ name: "GitHub" });

  const started = await github.connection.signIn!();
  expect(started).toEqual({ connected: false, pending: { code: "WDJB-MJHT", url: `${gh.origin}/login/device`, expiresAt: expect.any(Number) } });
  await until(async () => (await github.status()).connected);

  const signedIn = await github.status();
  expect(signedIn).toMatchObject({ connected: true, label: "@me", action: { needed: true, url: `${gh.origin}/apps/tomrade/installations/new` } });
  expect(await github.token()).toBe("ghu_1");
  expect(gitPassword(credentialArgs([github.credential()!]))).toBe("ghu_1");
  // Kept encrypted; only the short-lived token sits where the helper can read it.
  const kept = fs.readFileSync(path.join(userData, "github-session.enc"), "utf8");
  expect(kept).not.toMatch(/ghu_1|ghr_1/);
  expect(fs.statSync(path.join(userData, "github-token.json")).mode & 0o777).toBe(0o600);
  const settings = path.join(userData, "settings.json");
  expect(fs.existsSync(settings) ? fs.readFileSync(settings, "utf8") : "").not.toContain("ghu_1");

  gh.state.installations = 1;
  await new Promise((r) => setTimeout(r, 5));
  // The access check is cached for a minute; a fresh machine sees the installation at once.
  const restarted = await machine(gh, { userData });
  expect(await restarted.github.token()).toBe("ghu_1");
  expect((await restarted.github.status()).action).toEqual({ label: "Choose repositories", url: `${gh.origin}/apps/tomrade/installations/new`, needed: false });
  // Only what the App was given is offered, not everything the account can see.
  expect((await restarted.github.repositories()).map((r) => r.full_name)).toEqual(["me/chosen"]);
});

it("renews a token about to run out once, however many ask, and turns the renewal token over", async () => {
  const gh = await fakeGitHub({ accessSeconds: 60 });
  const { github } = await machine(gh);
  await github.connection.signIn!();
  await until(async () => gh.state.n === 1);
  await settle();
  const tokens = await Promise.all([github.token(), github.token(), github.token()]);
  expect(new Set(tokens).size).toBe(1);
  expect(tokens[0]).not.toBe("ghu_1");
  expect(gh.state.refreshes).toBe(1);
  expect(gh.state.refresh).toBe(`ghr_${gh.state.n}`);
});

it("falls back to the personal access token when the sign-in can no longer be renewed", async () => {
  const gh = await fakeGitHub({ accessSeconds: 60 });
  const { github, ctx, userData } = await machine(gh);
  ctx.settings.set({ ...ctx.settings.get(), github: { token: "ghp_pat" } });
  await github.connection.signIn!();
  await until(async () => gh.state.n === 1);
  await settle();
  gh.state.refresh = "revoked elsewhere";

  expect(await github.token()).toBe("ghp_pat");
  expect(await github.status()).toEqual({ connected: true, label: "@me" });
  // git reads the personal token from the helper's file: settings.json may hold it sealed.
  expect(JSON.parse(fs.readFileSync(path.join(userData, "github-token.json"), "utf8"))).toEqual({ token: "ghp_pat", expiresAt: null });
  expect(gitPassword(credentialArgs([github.credential()!]))).toBe("ghp_pat");

  // Without the token there is nothing left, and the panel says why.
  ctx.settings.set({ ...ctx.settings.get(), github: { token: "" } });
  expect(fs.existsSync(path.join(userData, "github-token.json"))).toBe(false);
  expect(await github.status()).toEqual({ connected: false, detail: "GitHub would not renew the sign-in — sign in again" });
  expect(github.credential()).toBeNull();
});

it("reports a declined sign-in, and a cancelled one leaves nothing behind", async () => {
  const declined = await machine(await fakeGitHub({ decline: true }));
  await declined.github.connection.signIn!();
  await until(async () => !(await declined.github.status()).pending);
  expect(await declined.github.status()).toEqual({ connected: false, detail: "The sign-in was declined on GitHub" });

  const gh = await fakeGitHub();
  gh.state.pendingPolls = 1_000;
  const { github, userData } = await machine(gh);
  await github.connection.signIn!();
  await github.connection.disconnect();
  expect(await github.status()).toEqual({ connected: false });
  gh.state.pendingPolls = 0;
  await new Promise((r) => setTimeout(r, 50));
  expect(await github.status()).toEqual({ connected: false });
  expect(fs.existsSync(path.join(userData, "github-session.enc"))).toBe(false);
});

it("offers no sign-in without the App's client ID, and a token still works", async () => {
  const gh = await fakeGitHub();
  const { github, ctx } = await machine(gh, { clientId: "" });
  expect(github.connection.prompt.signIn).toBeUndefined();
  expect(github.connection.signIn).toBeUndefined();
  ctx.settings.set({ ...ctx.settings.get(), github: { token: "ghp_pat" } });
  expect(await github.status()).toEqual({ connected: true, label: "@me" });
  expect((await github.repositories()).map((r) => r.full_name)).toEqual(["me/chosen", "me/other"]);
});

it("a renewal under way when the person signs out does not bring the session back", async () => {
  const gh = await fakeGitHub({ accessSeconds: 60 });
  const { github, userData } = await machine(gh);
  await github.connection.signIn!();
  await until(async () => gh.state.n === 1);
  await settle();
  const renewing = github.token();
  await github.connection.disconnect();
  expect(await renewing).toBe("");
  expect(await github.status()).toEqual({ connected: false });
  expect(fs.existsSync(path.join(userData, "github-session.enc"))).toBe(false);
  expect(fs.existsSync(path.join(userData, "github-token.json"))).toBe(false);
});
