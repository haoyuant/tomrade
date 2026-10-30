import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { followSystemProxy, parseRegQuery, proxyUrlOf, windowsProxyRules } from "../src/system-proxy.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the system proxy", () => {
  it("reads Chromium's answer as a proxy URL, or none to go direct", () => {
    const url = (rules: string) => proxyUrlOf(rules).url;
    expect(url("PROXY 127.0.0.1:7900")).toBe("http://127.0.0.1:7900");
    expect(url("PROXY 127.0.0.1:7900; DIRECT")).toBe("http://127.0.0.1:7900");
    expect(url("HTTPS proxy.corp:443")).toBe("https://proxy.corp:443");
    expect(proxyUrlOf("SOCKS5 127.0.0.1:7891; PROXY 127.0.0.1:7890")).toEqual({ url: "http://127.0.0.1:7890", socks: null });
    expect(url("DIRECT")).toBeNull();
    expect(url("")).toBeNull();
  });

  it("names a SOCKS proxy it cannot follow, so a failed download can say so", async () => {
    expect(proxyUrlOf("SOCKS5 127.0.0.1:7891")).toEqual({ url: null, socks: "socks5://127.0.0.1:7891" });
    expect(proxyUrlOf("SOCKS 127.0.0.1:1080; DIRECT")).toEqual({ url: null, socks: "socks://127.0.0.1:1080" });

    vi.useFakeTimers();
    vi.spyOn(http, "setGlobalProxyFromEnv").mockReturnValue(() => {});
    let answer = "SOCKS5 127.0.0.1:7891";
    const env: NodeJS.ProcessEnv = {};
    const { stop } = await followSystemProxy(async () => answer, { env });
    expect(env).toEqual({ TOMRADE_SOCKS_PROXY: "socks5://127.0.0.1:7891" });
    answer = "PROXY 127.0.0.1:7890";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(env.TOMRADE_SOCKS_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    stop();
  });

  it("is followed, changes are picked up, and the local network never goes through it", async () => {
    vi.useFakeTimers();
    const global = vi.spyOn(http, "setGlobalProxyFromEnv").mockReturnValue(() => {});
    let answer = "PROXY 127.0.0.1:7900";
    const env: NodeJS.ProcessEnv = { NO_PROXY: "intranet.corp" };
    const { stop } = await followSystemProxy(async () => answer, { env });
    expect(env).toMatchObject({ HTTPS_PROXY: "http://127.0.0.1:7900", HTTP_PROXY: "http://127.0.0.1:7900" });
    expect(env.NO_PROXY?.split(",")).toEqual(expect.arrayContaining(["intranet.corp", "localhost", "127.0.0.1"]));
    expect(global).toHaveBeenLastCalledWith(env);

    // The proxy is switched off: direct again, and the person's own exceptions are as they were.
    answer = "DIRECT";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(env).toEqual({ NO_PROXY: "intranet.corp" });
    expect(global).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(global).toHaveBeenCalledTimes(2);
    stop();
  });

  it("leaves a proxy the person set in their own environment alone", async () => {
    const global = vi.spyOn(http, "setGlobalProxyFromEnv");
    const env: NodeJS.ProcessEnv = { https_proxy: "http://mine:8080" };
    const resolve = vi.fn(async () => "PROXY 127.0.0.1:7900");
    const proxy = await followSystemProxy(resolve, { env });
    expect(env).toEqual({ https_proxy: "http://mine:8080" });
    expect(resolve).not.toHaveBeenCalled();
    expect(global).not.toHaveBeenCalled();
    const said: string[] = [];
    proxy.tell((line) => said.push(line));
    expect(said).toEqual(["not following the system proxy: https_proxy=http://mine:8080 is set in the environment"]);
  });

  it("reads the manual proxy from Windows' Internet Settings", () => {
    const values = parseRegQuery(
      [
        "",
        "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
        "    ProxyEnable    REG_DWORD    0x1",
        "    ProxyServer    REG_SZ    127.0.0.1:7897",
        "    ProxyOverride    REG_SZ    localhost;127.*;192.168.*;<local>",
        ""
      ].join("\r\n")
    );
    expect(values).toMatchObject({ ProxyEnable: "0x1", ProxyServer: "127.0.0.1:7897" });
    expect(windowsProxyRules(values, "github.com")).toBe("PROXY 127.0.0.1:7897");
    expect(windowsProxyRules({ ...values, ProxyEnable: "0x0" }, "github.com")).toBeNull();
    expect(windowsProxyRules({ ...values, AutoConfigURL: "http://127.0.0.1:7897/pac" }, "github.com")).toBeNull();
    expect(windowsProxyRules({ ...values, ProxyOverride: "*.github.com;github.com" }, "github.com")).toBeNull();
    expect(windowsProxyRules({ ...values, ProxyServer: "http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892" }, "github.com")).toBe("PROXY 127.0.0.1:7891");
    expect(windowsProxyRules({ ...values, ProxyServer: "socks=127.0.0.1:7892" }, "github.com")).toBe("SOCKS 127.0.0.1:7892");
  });

  it("takes Windows' manual proxy when Chromium answers DIRECT or fails, and says which it used", async () => {
    vi.useFakeTimers();
    vi.spyOn(http, "setGlobalProxyFromEnv").mockReturnValue(() => {});
    const settings = { ProxyEnable: "0x1", ProxyServer: "127.0.0.1:7897" };
    const env: NodeJS.ProcessEnv = {};
    let resolve = async () => "DIRECT";
    const proxy = await followSystemProxy(() => resolve(), { env, windowsSettings: async () => settings });
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
    const said: string[] = [];
    proxy.tell((line) => said.push(line));
    expect(said).toEqual(['system proxy: http://127.0.0.1:7897 (Chromium answered "DIRECT"; Windows Internet Settings name "127.0.0.1:7897")']);

    resolve = async () => {
      throw new Error("network service gone");
    };
    settings.ProxyEnable = "0x0";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(said.at(-1)).toBe("system proxy: none, connecting directly (Chromium could not answer: network service gone)");
    // Nothing changed: nothing more is said.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(said).toHaveLength(2);
    proxy.stop();
  });
});
