import http from "node:http";

const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
/** Never through a proxy: Tomrade's own MCP server, and the machine and its network. */
const LOCAL = "localhost,127.0.0.1,::1,.local,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";
const CHECK_MS = 60_000;

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
    const { url, socks } = proxyUrlOf(await resolve("https://github.com"));
    // Read by the plugin downloads, which say the proxy they could not go through.
    if (socks) env.TOMRADE_SOCKS_PROXY = socks;
    else delete env.TOMRADE_SOCKS_PROXY;
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
