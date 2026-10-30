import { execFile } from "node:child_process";
import http from "node:http";

const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
/** Never through a proxy: Tomrade's own MCP server, and the machine and its network. */
const LOCAL = "localhost,127.0.0.1,::1,.local,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";
const CHECK_MS = 60_000;
const TARGET = "https://github.com";
const INTERNET_SETTINGS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

/**
 * Chromium's answer — "PROXY host:port; DIRECT" — as a proxy URL Node and git understand, or null to go direct;
 * and the SOCKS proxy passed over on the way, so a failure can name it.
 */
export function proxyUrlOf(rules: string): { url: string | null; socks: string | null } {
  let socks: string | null = null;
  for (const rule of rules.split(";").map((r) => r.trim()).filter(Boolean)) {
    const [kind, hostPort] = rule.split(/\s+/);
    if (kind === "DIRECT") return { url: null, socks };
    if (kind === "PROXY" && hostPort) return { url: `http://${hostPort}`, socks: null };
    if (kind === "HTTPS" && hostPort) return { url: `https://${hostPort}`, socks: null };
    // SOCKS: neither Node's built-in proxy nor every git reads it; try the next rule.
    if (kind?.startsWith("SOCKS") && hostPort) socks ??= `${kind.toLowerCase()}://${hostPort}`;
  }
  return { url: null, socks };
}

/** The values of `reg query` on the Internet Settings key, by name. */
export function parseRegQuery(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_\w+\s*(.*)$/.exec(line);
    if (m) values[m[1]!] = m[2]!.trim();
  }
  return values;
}

/**
 * The manual proxy Windows' Internet Settings name for `host`, in Chromium's
 * words ("PROXY 127.0.0.1:7897"), or null where they name none: switched off,
 * a PAC file (Chromium's to read), or `host` among the exceptions.
 */
export function windowsProxyRules(values: Record<string, string>, host: string): string | null {
  if (!/^(0x)?0*1$/i.test(values.ProxyEnable ?? "") || values.AutoConfigURL) return null;
  const server = (values.ProxyServer ?? "").trim();
  if (!server) return null;
  const bypassed = (values.ProxyOverride ?? "").split(";").map((p) => p.trim().toLowerCase()).filter(Boolean).some((pattern) => {
    if (pattern === "<local>") return !host.includes(".");
    return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(host.toLowerCase());
  });
  if (bypassed) return null;
  const strip = (hostPort: string) => hostPort.replace(/^[a-z0-9]+:\/\//i, "");
  // "127.0.0.1:7897" for every scheme, or "http=…;https=…;socks=…" one by one.
  if (!server.includes("=")) return `PROXY ${strip(server)}`;
  const byScheme = new Map(server.split(";").map((part) => part.split("=").map((s) => s.trim()) as [string, string]).filter(([, v]) => v).map(([k, v]) => [k.toLowerCase(), strip(v)]));
  const proxy = byScheme.get("https") ?? byScheme.get("http");
  if (proxy) return `PROXY ${proxy}`;
  const socks = byScheme.get("socks");
  return socks ? `SOCKS ${socks}` : null;
}

/** Windows' own Internet Settings, read with reg.exe; null where they cannot be read. */
export function readWindowsInternetSettings(): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    execFile("reg", ["query", INTERNET_SETTINGS], { timeout: 5000, windowsHide: true }, (error, stdout) => resolve(error ? null : parseRegQuery(String(stdout))));
  });
}

/** A proxy URL without its user and password, fit for a log. */
const shown = (url: string): string => url.replace(/\/\/[^@/\s]*@/, "//");

export interface SystemProxy {
  stop(): void;
  /** Hands over what has been decided so far, then each later change, as one line each. */
  tell(log: (line: string) => void): void;
}

export interface FollowOptions {
  env?: NodeJS.ProcessEnv;
  /** Windows' Internet Settings, asked when Chromium answers DIRECT or cannot answer. */
  windowsSettings?: () => Promise<Record<string, string> | null>;
}

/**
 * Follow the system proxy (Clash, a PAC file, a company proxy) the way a
 * browser does: the main process's fetch and the git and agent processes it
 * starts use it, and a change is picked up within a minute. A proxy the person
 * set in their own environment stands, and nothing is done.
 *
 * On Windows, the manual proxy in Internet Settings is read as well: Chromium's
 * answer can be DIRECT while it is still loading the settings at start, and a
 * Files sync started then would go direct for its whole exchange.
 */
export async function followSystemProxy(resolve: (url: string) => Promise<string>, options: FollowOptions = {}): Promise<SystemProxy> {
  const env = options.env ?? process.env;
  const lines: string[] = [];
  let log: ((line: string) => void) | null = null;
  let last: string | null = null;
  const say = (line: string) => {
    if (line === last) return;
    last = line;
    if (log) log(line);
    else lines.push(line);
  };
  const tell = (to: (line: string) => void) => {
    log = to;
    for (const line of lines.splice(0)) to(line);
  };

  const theirs = PROXY_VARS.find((name) => env[name]);
  if (theirs) {
    say(`not following the system proxy: ${theirs}=${shown(env[theirs]!)} is set in the environment`);
    return { stop: () => {}, tell };
  }
  const theirNoProxy = env.NO_PROXY ?? env.no_proxy;
  let current: string | null = null;
  const apply = async () => {
    let rules: string;
    let source: string;
    try {
      rules = await resolve(TARGET);
      source = `Chromium answered "${rules}"`;
    } catch (error) {
      rules = "";
      source = `Chromium could not answer: ${error instanceof Error ? error.message : String(error)}`;
    }
    let chosen = proxyUrlOf(rules);
    if (!chosen.url && options.windowsSettings) {
      const settings = await options.windowsSettings().catch(() => null);
      const fromWindows = settings ? windowsProxyRules(settings, new URL(TARGET).hostname) : null;
      if (fromWindows) {
        chosen = proxyUrlOf(fromWindows);
        source += `; Windows Internet Settings name "${settings!.ProxyServer}"`;
      }
    }
    const { url, socks } = chosen;
    // Read by the plugin downloads, which say the proxy they could not go through.
    if (socks) env.TOMRADE_SOCKS_PROXY = socks;
    else delete env.TOMRADE_SOCKS_PROXY;
    say(url ? `system proxy: ${shown(url)} (${source})` : `system proxy: none, connecting directly${socks ? ` — the SOCKS proxy ${socks} cannot be followed` : ""} (${source})`);
    if (url === current) return;
    current = url;
    for (const name of PROXY_VARS) delete env[name];
    if (url) {
      env.HTTPS_PROXY = url;
      env.HTTP_PROXY = url;
      env.NO_PROXY = theirNoProxy ? `${theirNoProxy},${LOCAL}` : LOCAL;
    } else if (theirNoProxy === undefined) delete env.NO_PROXY;
    else env.NO_PROXY = theirNoProxy;
    http.setGlobalProxyFromEnv(env);
  };
  const attempt = () => apply().catch((error) => say(`could not apply the system proxy: ${error instanceof Error ? error.message : String(error)}`));
  await attempt();
  const timer = setInterval(() => void attempt(), CHECK_MS);
  timer.unref();
  return { stop: () => clearInterval(timer), tell };
}
