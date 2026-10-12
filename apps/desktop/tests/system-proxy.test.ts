import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { followSystemProxy, proxyUrlOf } from "../src/system-proxy.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the system proxy", () => {
  it("reads Chromium's answer as a proxy URL, or none to go direct", () => {
    expect(proxyUrlOf("PROXY 127.0.0.1:7900")).toBe("http://127.0.0.1:7900");
    expect(proxyUrlOf("PROXY 127.0.0.1:7900; DIRECT")).toBe("http://127.0.0.1:7900");
    expect(proxyUrlOf("HTTPS proxy.corp:443")).toBe("https://proxy.corp:443");
    expect(proxyUrlOf("SOCKS5 127.0.0.1:7891; PROXY 127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
    expect(proxyUrlOf("SOCKS5 127.0.0.1:7891")).toBeNull();
    expect(proxyUrlOf("DIRECT")).toBeNull();
    expect(proxyUrlOf("")).toBeNull();
  });

  it("is followed, changes are picked up, and the local network never goes through it", async () => {
    vi.useFakeTimers();
    const global = vi.spyOn(http, "setGlobalProxyFromEnv").mockReturnValue(() => {});
    let answer = "PROXY 127.0.0.1:7900";
    const env: NodeJS.ProcessEnv = { NO_PROXY: "intranet.corp" };
    const stop = await followSystemProxy(async () => answer, env);
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
    await followSystemProxy(resolve, env);
    expect(env).toEqual({ https_proxy: "http://mine:8080" });
    expect(resolve).not.toHaveBeenCalled();
    expect(global).not.toHaveBeenCalled();
  });
});
