import http from "node:http";

const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
/** Never through a proxy: Tomrade's own MCP server, and the machine and its network. */
const LOCAL = "localhost,127.0.0.1,::1,.local,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";
const CHECK_MS = 60_000;

/** Chromium's answer — "PROXY host:port; DIRECT" — as a proxy URL Node and git understand, or null to go direct. */
export function proxyUrlOf(rules: string): string | null {
  for (const rule of rules.split(";").map((r) => r.trim()).filter(Boolean)) {
    const [kind, hostPort] = rule.split(/\s+/);
    if (kind === "DIRECT") return null;
    if (kind === "PROXY" && hostPort) return `http://${hostPort}`;
    if (kind === "HTTPS" && hostPort) return `https://${hostPort}`;
    // SOCKS: neither Node's built-in proxy nor every git reads it; try the next rule.
  }
  return null;
}

/**
 * Follow the system proxy (Clash, a PAC file, a company proxy) the way a
 * browser does: the main process's fetch and the git and agent processes it
 * starts use it, and a change is picked up within a minute. A proxy the person
 * set in their own environment stands, and nothing is done.
 */
export async function followSystemProxy(resolve: (url: string) => Promise<string>, env: NodeJS.ProcessEnv = process.env): Promise<() => void> {
  if (PROXY_VARS.some((name) => env[name])) return () => {};
  const theirs = env.NO_PROXY ?? env.no_proxy;
  let current: string | null = null;
  const apply = async () => {
    const url = proxyUrlOf(await resolve("https://github.com"));
    if (url === current) return;
    current = url;
    for (const name of PROXY_VARS) delete env[name];
    if (url) {
      env.HTTPS_PROXY = url;
      env.HTTP_PROXY = url;
      env.NO_PROXY = theirs ? `${theirs},${LOCAL}` : LOCAL;
    } else if (theirs === undefined) delete env.NO_PROXY;
    else env.NO_PROXY = theirs;
    http.setGlobalProxyFromEnv(env);
  };
  await apply().catch(() => {});
  const timer = setInterval(() => void apply().catch(() => {}), CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
