import path from "node:path";
import type { Reporter, SerializedError, TestModule, Vitest } from "vitest/node";

/**
 * Sorts a run's failures into the three kinds the merge rule in docs/testing.md
 * reads. Conservative: anything not clearly a vitest timeout or a network error
 * is `real`, and so is every assertion, whatever its message mentions.
 */
export type FailureKind = "timeout-under-load" | "network" | "real";
export const FAILURE_KINDS: readonly FailureKind[] = ["real", "network", "timeout-under-load"];

export interface Classified {
  kind: FailureKind;
  /** First line of the error that decided the kind. */
  reason: string;
}

export interface Failure extends Classified {
  /** File, then suites and test name, as vitest prints them. */
  where: string;
}

type Node = Record<string, unknown>;

const TIMEOUT = /^(Test|Hook) timed out in \d+ms/;
// A test's own wait running out: vi.waitFor / vi.waitUntil, or a polling helper's bare "timed out".
const WAIT_TIMEOUT = /^(Timed out in (waitFor|waitUntil)!|timed out\.?)$/i;

const NETWORK_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NODATA", "EAI_NONAME",
  "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "EHOSTDOWN",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
  "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID"
]);

// What Node, curl/git, Go (gh) and TLS stacks print when the network is not there.
const NETWORK_TEXT = [
  /\bgetaddrinfo\b/,
  /\b(ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EHOSTDOWN)\b/,
  /\b(connect|read|write) (ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b/,
  /Could not resolve (host|proxy)/i,
  /Failed to connect to \S+ port \d+/,
  /Connection (refused|reset by peer|timed out)/i,
  /\bproxyconnect\b|Proxy CONNECT aborted|Received HTTP code \d+ from proxy|tunneling socket could not be established/i,
  /\bno such host\b|\bdial tcp\b.*\b(i\/o timeout|connection refused|connection reset)/,
  /error connecting to \S+|check your internet connection/i,
  /network is (unreachable|down)/i,
  /SSL certificate problem|\bx509: |certificate has expired|unable to (get local issuer certificate|verify the first certificate)|self[- ]signed certificate/i,
  /SSL_ERROR_SYSCALL|OpenSSL SSL_(connect|read)|gnutls_handshake\(\) failed|TLS handshake timeout|Client network socket disconnected before secure TLS connection was established/
];

const LOOPBACK_HOST = /^(127(\.\d{1,3}){3}|localhost|::1|\[::1\]|::ffff:127(\.\d{1,3}){3})$/i;
const LOOPBACK_TEXT = /(?<![\d.])(127(?:\.\d{1,3}){3}|localhost|\[::1\])(?::| port )(\d+)/gi;
// A Unix socket or Windows pipe: as local as it gets.
const SOCKET_PATH = /^(\/|\\\\)/;
const SOCKET_TEXT = /\b(connect|read|write) E[A-Z]+ (\/|\\\\)/;

/** Ports of proxies on this machine named by the environment: refusals there are the network, not a local test server. */
export function loopbackProxyPorts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const ports = new Set<string>();
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"]) {
    const value = env[key];
    if (!value) continue;
    try {
      const url = new URL(value.includes("://") ? value : `http://${value}`);
      if (!LOOPBACK_HOST.test(url.hostname)) continue;
      ports.add(url.port || (url.protocol === "https:" ? "443" : url.protocol.startsWith("socks") ? "1080" : "80"));
    } catch {
      // Unparseable: it names no port to trust.
    }
  }
  return ports;
}

const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null;
const text = (n: Node) => (typeof n.message === "string" ? n.message : "");
const firstLine = (s: string) => {
  const line = (s.split("\n").find((l) => l.trim()) ?? "").trim();
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
};

/** The error, its causes and an AggregateError's members. */
function walk(root: Node): Node[] {
  const seen: Node[] = [];
  const queue: unknown[] = [root];
  while (queue.length && seen.length < 32) {
    const n = queue.shift();
    if (!isNode(n) || seen.includes(n)) continue;
    seen.push(n);
    queue.push(n.cause);
    if (Array.isArray(n.errors)) queue.push(...n.errors);
  }
  return seen;
}

const isAssertion = (n: Node) =>
  n.name === "AssertionError" || "expected" in n || "actual" in n || typeof n.diff === "string";

/** The line that shows the network failed, or null. */
function networkLine(n: Node): string | null {
  const code = typeof n.code === "string" ? n.code : "";
  // ETIMEDOUT is also what spawnSync says when a child outlives its limit.
  if (NETWORK_CODES.has(code) || (code === "ETIMEDOUT" && n.syscall === "connect")) return firstLine(text(n)) || code;
  const line = text(n).split("\n").find((l) => NETWORK_TEXT.some((re) => re.test(l)));
  return line === undefined ? null : firstLine(line);
}

/** A socket file, or a loopback port no proxy uses: a server the test itself runs, so not the network. */
function isLocalServer(n: Node, proxies: Set<string>): boolean {
  if (typeof n.address === "string" && SOCKET_PATH.test(n.address)) return true;
  if (typeof n.address === "string" && LOOPBACK_HOST.test(n.address) && n.port !== undefined && !proxies.has(String(n.port))) return true;
  if (SOCKET_TEXT.test(text(n))) return true;
  for (const [, , port] of text(n).matchAll(LOOPBACK_TEXT)) if (!proxies.has(port!)) return true;
  return false;
}

export function classifyError(error: unknown, proxies: Set<string> = loopbackProxyPorts()): Classified {
  if (!isNode(error)) return { kind: "real", reason: firstLine(String(error)) };
  const reason = firstLine(text(error) || String(error.name ?? "error"));
  const nodes = walk(error);
  if (nodes.some(isAssertion)) return { kind: "real", reason };
  if (TIMEOUT.test(text(error))) return { kind: "timeout-under-load", reason };
  // Only alone: a wait that carries a cause says why it failed, and that decides.
  if (nodes.length === 1 && WAIT_TIMEOUT.test(reason)) return { kind: "timeout-under-load", reason };
  if (nodes.some((n) => isLocalServer(n, proxies))) return { kind: "real", reason };
  for (const n of nodes) {
    const line = networkLine(n);
    if (line !== null) return { kind: "network", reason: line };
  }
  return { kind: "real", reason };
}

/** One entity's errors together: any real one makes it real, then network outranks a timeout it may have caused. */
export function classifyErrors(errors: readonly unknown[] | undefined, proxies: Set<string> = loopbackProxyPorts()): Classified {
  if (!errors?.length) return { kind: "real", reason: "failed without an error" };
  const each = errors.map((e) => classifyError(e, proxies));
  for (const kind of FAILURE_KINDS) {
    const hit = each.find((c) => c.kind === kind);
    if (hit) return hit;
  }
  return each[0]!;
}

export function collectFailures(modules: ReadonlyArray<TestModule>, unhandled: ReadonlyArray<SerializedError>, root: string, proxies: Set<string> = loopbackProxyPorts()): Failure[] {
  const rel = (file: string) => path.relative(root, file) || file;
  const out: Failure[] = [];
  for (const mod of modules) {
    const file = rel(mod.moduleId);
    if (mod.errors().length) out.push({ where: file, ...classifyErrors(mod.errors(), proxies) });
    for (const suite of mod.children.allSuites()) {
      if (suite.errors().length) out.push({ where: `${file} > ${suite.fullName}`, ...classifyErrors(suite.errors(), proxies) });
    }
    for (const test of mod.children.allTests("failed")) {
      out.push({ where: `${file} > ${test.fullName}`, ...classifyErrors(test.result().errors, proxies) });
    }
  }
  for (const error of unhandled) {
    const file = typeof error.VITEST_TEST_PATH === "string" ? rel(error.VITEST_TEST_PATH) : "(unhandled)";
    const name = typeof error.VITEST_TEST_NAME === "string" ? ` > ${error.VITEST_TEST_NAME}` : "";
    out.push({ where: `${file}${name} (unhandled)`, ...classifyError(error, proxies) });
  }
  return out;
}

export function formatFailures(failures: readonly Failure[]): string {
  const count = (kind: FailureKind) => failures.filter((f) => f.kind === kind).length;
  const lines = [`Failures by kind: ${FAILURE_KINDS.map((k) => `${k} ${count(k)}`).join(" · ")}  (merge rule: docs/testing.md)`];
  const width = Math.max(...FAILURE_KINDS.map((k) => k.length));
  for (const kind of FAILURE_KINDS) {
    for (const f of failures.filter((x) => x.kind === kind)) lines.push(`  ${kind.padEnd(width)}  ${f.where} — ${f.reason}`);
  }
  return lines.join("\n");
}

/** Listed after "default" in vitest.config.ts: the default output stays, and this summary follows it. */
export default class FailureKindsReporter implements Reporter {
  private vitest!: Vitest;

  onInit(vitest: Vitest): void {
    this.vitest = vitest;
  }

  async onTestRunEnd(modules: ReadonlyArray<TestModule>, unhandled: ReadonlyArray<SerializedError>): Promise<void> {
    const summary = formatFailures(collectFailures(modules, unhandled, this.vitest.config.root));
    // The default reporter prints its totals in the same tick; land after them.
    await new Promise((resolve) => setImmediate(resolve));
    this.vitest.logger.log(`${summary}\n`);
  }
}
