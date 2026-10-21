import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import GitHubAccount from "@tomradex/github";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import type { Check } from "@tomradex/contracts";
import { Community } from "@tomradex/community";
import { reach, unreachable } from "../src/net.js";

const tmp = fs.mkdtempSync(path.join(import.meta.dirname, ".tmp-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const failed = (code: string, message: string) => new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });
const CATALOG = "https://github.com/haoyuant/tomrade-plugins/releases/download/catalog/catalog.json";
const ASSETS = "https://release-assets.githubusercontent.com/github-production-release-asset/1/catalog.json";
/** github.com answers with a redirect; the asset host is out of reach, as on the network the ticket came from. */
const assetsUnreachable = (error: Error) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (new URL(url).host === "github.com") return new Response(null, { status: 302, headers: { location: ASSETS } });
      throw error;
    })
  );

describe("a download that does not get through", () => {
  it("names the host and why, and what to check", () => {
    const dns = unreachable("release-assets.githubusercontent.com", failed("ENOTFOUND", "getaddrinfo ENOTFOUND release-assets.githubusercontent.com"), "en", {});
    expect(dns.message).toBe("could not reach release-assets.githubusercontent.com: its name could not be resolved (ENOTFOUND). Check this machine's proxy or network.");
    expect((dns.cause as Error).message).toBe("fetch failed");
    expect(unreachable("github.com", failed("ETIMEDOUT", "connect ETIMEDOUT 20.205.243.166:443"), "en", {}).message).toMatch(/^could not reach github\.com: the connection timed out \(ETIMEDOUT\)/);
    expect(unreachable("github.com", failed("CERT_HAS_EXPIRED", "certificate has expired"), "zh", {}).message).toBe("无法连接 github.com：证书未被接受（CERT_HAS_EXPIRED）。请检查这台电脑的代理或网络。");
    expect(unreachable("github.com", new TypeError("fetch failed", { cause: new Error("something new") }), "en", {}).message).toMatch(/^could not reach github\.com: something new\./);
  });

  it("says when the system proxy is SOCKS, which it does not go through", () => {
    const error = unreachable("github.com", failed("ECONNRESET", "read ECONNRESET"), "en", { TOMRADE_SOCKS_PROXY: "socks5://127.0.0.1:7891" });
    expect(error.message).toMatch(/connection was cut off \(ECONNRESET\)\. The system proxy is SOCKS \(socks5:\/\/127\.0\.0\.1:7891\)/);
  });

  it("names the host a redirect led to, not the one first asked", async () => {
    assetsUnreachable(failed("ENOTFOUND", "getaddrinfo ENOTFOUND release-assets.githubusercontent.com"));
    await expect(reach(CATALOG, { signal: AbortSignal.timeout(5_000) })).rejects.toThrow(/^could not reach release-assets\.githubusercontent\.com: its name could not be resolved \(ENOTFOUND\)/);

    vi.stubGlobal("fetch", vi.fn(async (url: string) => (new URL(url).host === "github.com" ? new Response(null, { status: 302, headers: { location: ASSETS } }) : new Response("{}"))));
    const { response, hosts } = await reach(CATALOG, { signal: AbortSignal.timeout(5_000) });
    expect(await response.text()).toBe("{}");
    expect(hosts).toEqual(["github.com", "release-assets.githubusercontent.com"]);
  });

  it("is a row of the troubleshooter's, reaching the catalog as a download does", async () => {
    const checks = new Map<string, Check>();
    const w = await fresh({ plugins: [[Settings, { path: path.join(tmp, "settings.json") }], GitHubAccount] });
    w.ctx.provide("doctor", { check: (check: Check) => (checks.set(check.id, check), () => checks.delete(check.id)), locale: () => "en" } as never);
    await w.ctx.plugin(Community, { officialCatalog: { url: CATALOG } });
    await settle();
    const run = () => checks.get("pluginDownloads")!.run({}, new AbortController().signal);

    vi.stubGlobal("fetch", vi.fn(async (url: string) => (new URL(url).host === "github.com" ? new Response(null, { status: 302, headers: { location: ASSETS } }) : new Response("{}"))));
    expect(await run()).toEqual({ state: "ok", line: "github.com → release-assets.githubusercontent.com reached" });

    vi.stubEnv("TOMRADE_SOCKS_PROXY", "socks5://127.0.0.1:7891");
    expect(await run()).toMatchObject({ state: "ok", line: expect.stringMatching(/reached directly\. The system proxy is SOCKS \(socks5:\/\/127\.0\.0\.1:7891\)/), facts: { systemProxy: "socks5://127.0.0.1:7891" } });
    assetsUnreachable(failed("ETIMEDOUT", "connect ETIMEDOUT 185.199.108.133:443"));
    expect(await run()).toMatchObject({
      state: "fail",
      line: expect.stringMatching(/^could not reach release-assets\.githubusercontent\.com: the connection timed out \(ETIMEDOUT\)\. The system proxy is SOCKS/),
      evidence: expect.stringContaining("connect ETIMEDOUT 185.199.108.133:443 (ETIMEDOUT)"),
      facts: { systemProxy: "socks5://127.0.0.1:7891" }
    });
  });
});
