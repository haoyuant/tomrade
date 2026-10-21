import { describe, expect, it } from "vitest";
import { classifyError, classifyErrors, formatFailures, loopbackProxyPorts, type Failure } from "../src/failure-kinds.js";

const noProxy = new Set<string>();
const kind = (error: unknown, proxies = noProxy) => classifyError(error, proxies).kind;

// Shaped as vitest serializes them: plain objects carrying the error's own fields.
const timeout = { name: "Error", message: 'Test timed out in 5000ms.\nIf this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".' };
const assertion = { name: "AssertionError", message: "expected 1 to be 2 // Object.is equality", expected: "2", actual: "1", diff: "- 2\n+ 1" };

describe("timeouts", () => {
  it("counts vitest's own test and hook timeouts as load", () => {
    expect(kind(timeout)).toBe("timeout-under-load");
    expect(kind({ message: "Hook timed out in 10000ms." })).toBe("timeout-under-load");
  });

  it("counts a test's own wait running out as load: vi.waitFor, vi.waitUntil, a polling helper's bare \"timed out\"", () => {
    expect(kind({ name: "Error", message: "Timed out in waitFor!" })).toBe("timeout-under-load");
    expect(kind({ name: "Error", message: "Timed out in waitUntil!" })).toBe("timeout-under-load");
    expect(kind({ name: "Error", message: "timed out" })).toBe("timeout-under-load");
    expect(classifyError({ message: "timed out" }, noProxy).reason).toBe("timed out");
  });

  it("leaves other timeouts real: a poll that never matched, a wait with a cause, a child that outlived its limit", () => {
    expect(kind({ message: "Matcher did not succeed in time.", cause: assertion })).toBe("real");
    expect(kind({ message: "timed out", cause: assertion })).toBe("real");
    expect(kind({ message: "Timed out in waitFor!", cause: { name: "TypeError", message: "Cannot read properties of undefined (reading 'id')" } })).toBe("real");
    expect(kind({ message: "model timed out after 30 s" })).toBe("real");
    expect(kind({ message: "spawnSync git ETIMEDOUT", code: "ETIMEDOUT", syscall: "spawnSync git" })).toBe("real");
  });
});

describe("network", () => {
  it("reads Node's DNS, refusal, reset and unreachable errors, through fetch's cause", () => {
    expect(kind({ message: "getaddrinfo ENOTFOUND api.github.com", code: "ENOTFOUND", syscall: "getaddrinfo", hostname: "api.github.com" })).toBe("network");
    expect(kind({ message: "getaddrinfo EAI_AGAIN registry.npmjs.org", code: "EAI_AGAIN" })).toBe("network");
    expect(kind({ name: "TypeError", message: "fetch failed", cause: { message: "connect ECONNREFUSED 140.82.112.6:443", code: "ECONNREFUSED", address: "140.82.112.6", port: 443 } })).toBe("network");
    expect(kind({ message: "read ECONNRESET", code: "ECONNRESET", syscall: "read" })).toBe("network");
    expect(kind({ message: "connect ETIMEDOUT 20.205.243.166:443", code: "ETIMEDOUT", syscall: "connect" })).toBe("network");
    expect(kind({ message: "connect ENETUNREACH 2606:50c0::1:443" })).toBe("network");
    expect(kind({ name: "TypeError", message: "fetch failed", cause: { name: "ConnectTimeoutError", message: "Connect Timeout Error", code: "UND_ERR_CONNECT_TIMEOUT" } })).toBe("network");
  });

  it("reads git, curl and gh output wrapped in an ordinary error", () => {
    expect(kind({ message: "git fetch failed\nfatal: unable to access 'https://github.com/a/b/': Could not resolve host: github.com" })).toBe("network");
    expect(kind({ message: "Command failed: gh api user\nerror connecting to api.github.com\ncheck your internet connection or https://githubstatus.com" })).toBe("network");
    expect(kind({ message: 'Post "https://api.github.com/graphql": proxyconnect tcp: dial tcp 127.0.0.1:19: connect: connection refused' }, new Set(["19"]))).toBe("network");
    expect(kind({ message: "dial tcp: lookup api.github.com: no such host" })).toBe("network");
  });

  it("reads TLS and certificate failures", () => {
    expect(kind({ message: "fatal: unable to access 'https://github.com/a/b/': SSL certificate problem: unable to get local issuer certificate" })).toBe("network");
    expect(kind({ message: "self-signed certificate in certificate chain", code: "SELF_SIGNED_CERT_IN_CHAIN" })).toBe("network");
    expect(kind({ message: "Client network socket disconnected before secure TLS connection was established", code: "ECONNRESET" })).toBe("network");
  });

  it("looks inside an AggregateError's members", () => {
    expect(kind({ name: "AggregateError", message: "", errors: [{ message: "connect ECONNREFUSED 140.82.112.6:443", code: "ECONNREFUSED" }] })).toBe("network");
  });

  it("takes a refusal on loopback as the network only on a proxy's port", () => {
    const proxies = loopbackProxyPorts({ HTTPS_PROXY: "http://127.0.0.1:19", ALL_PROXY: "socks5://localhost" });
    expect([...proxies].sort()).toEqual(["1080", "19"]);
    const viaProxy = { message: "fatal: unable to access 'https://github.com/a/b/': Failed to connect to 127.0.0.1 port 19 after 0 ms: Couldn't connect to server" };
    expect(kind(viaProxy, proxies)).toBe("network");
    expect(kind({ message: "fetch failed", cause: { message: "connect ECONNREFUSED 127.0.0.1:19", code: "ECONNREFUSED", address: "127.0.0.1", port: 19 } }, proxies)).toBe("network");
    // The test's own server not answering is a regression, not the network.
    expect(kind({ message: "fetch failed", cause: { message: "connect ECONNREFUSED 127.0.0.1:53111", code: "ECONNREFUSED", address: "127.0.0.1", port: 53111 } }, proxies)).toBe("real");
    expect(kind({ message: "fetch failed", cause: { name: "AggregateError", code: "ECONNREFUSED", errors: [{ code: "ECONNREFUSED", address: "::1", port: 4000 }, { code: "ECONNREFUSED", address: "127.0.0.1", port: 4000 }] } }, proxies)).toBe("real");
    expect(kind({ message: "Failed to connect to localhost port 8080: Connection refused" }, proxies)).toBe("real");
  });

  it("never takes a socket file for the network", () => {
    expect(kind({ message: "connect ECONNREFUSED /tmp/herdr.sock", code: "ECONNREFUSED", syscall: "connect", address: "/tmp/herdr.sock" })).toBe("real");
    expect(kind({ message: "rpc failed", cause: { message: "read ECONNRESET \\\\.\\pipe\\tomrade" } })).toBe("real");
  });

  it("ignores proxy settings that name no loopback port", () => {
    expect([...loopbackProxyPorts({ HTTPS_PROXY: "http://proxy.corp:3128", http_proxy: "not a url ::", NO_PROXY: "127.0.0.1:19" })]).toEqual([]);
  });
});

describe("real", () => {
  it("is every assertion, whatever its message mentions", () => {
    expect(kind(assertion)).toBe("real");
    expect(kind({ name: "AssertionError", message: "expected 'getaddrinfo ENOTFOUND github.com' to be 'ok'", expected: "'ok'", actual: "'getaddrinfo ENOTFOUND github.com'" })).toBe("real");
    expect(kind({ message: "Test timed out in 5000ms.", cause: assertion })).toBe("real");
  });

  it("is anything unrecognised, including a bare fetch failure with no cause", () => {
    expect(kind({ name: "TypeError", message: "Cannot read properties of undefined (reading 'id')" })).toBe("real");
    expect(kind({ name: "TypeError", message: "fetch failed" })).toBe("real");
    expect(kind({ message: "socket hang up" })).toBe("real");
    expect(kind("a thrown string")).toBe("real");
    expect(kind(undefined)).toBe("real");
  });
});

describe("one failure with several errors", () => {
  it("is real if any error is, then network over a timeout it may have caused", () => {
    const network = { message: "getaddrinfo ENOTFOUND github.com", code: "ENOTFOUND" };
    expect(classifyErrors([timeout, assertion], noProxy).kind).toBe("real");
    expect(classifyErrors([timeout, network], noProxy)).toEqual({ kind: "network", reason: "getaddrinfo ENOTFOUND github.com" });
    expect(classifyErrors([timeout, timeout], noProxy).kind).toBe("timeout-under-load");
    expect(classifyErrors([], noProxy).kind).toBe("real");
    expect(classifyErrors(undefined, noProxy).kind).toBe("real");
  });

  it("names the error that decided, by its first line", () => {
    expect(classifyError({ name: "TypeError", message: "fetch failed", cause: { message: "getaddrinfo ENOTFOUND api.tavily.com\n    at x", code: "ENOTFOUND" } }, noProxy).reason).toBe("getaddrinfo ENOTFOUND api.tavily.com");
    expect(classifyError(timeout, noProxy).reason).toBe("Test timed out in 5000ms.");
    const git = { message: "Command failed: git ls-remote https://github.com/git/git\nfatal: unable to access 'https://github.com/git/git/': Could not resolve host: github.com\n" };
    expect(classifyError(git, noProxy).reason).toBe("fatal: unable to access 'https://github.com/git/git/': Could not resolve host: github.com");
  });
});

describe("the summary", () => {
  it("prints all three counts, real first, then one line per failure", () => {
    const failures: Failure[] = [
      { where: "packages/a/tests/a.test.ts > waits", kind: "timeout-under-load", reason: "Test timed out in 5000ms." },
      { where: "packages/b/tests/b.test.ts > fetches", kind: "network", reason: "getaddrinfo ENOTFOUND github.com" },
      { where: "packages/c/tests/c.test.ts > adds", kind: "real", reason: "expected 1 to be 2" }
    ];
    expect(formatFailures(failures).split("\n")).toEqual([
      "Failures by kind: real 1 · network 1 · timeout-under-load 1  (merge rule: docs/testing.md)",
      "  real                packages/c/tests/c.test.ts > adds — expected 1 to be 2",
      "  network             packages/b/tests/b.test.ts > fetches — getaddrinfo ENOTFOUND github.com",
      "  timeout-under-load  packages/a/tests/a.test.ts > waits — Test timed out in 5000ms."
    ]);
    expect(formatFailures([])).toBe("Failures by kind: real 0 · network 0 · timeout-under-load 0  (merge rule: docs/testing.md)");
  });
});
