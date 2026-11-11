import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { endpoints, filters, loadDashboard, loadView, type Filters, type View } from "./analytics-data.js";
import { claudeAnalyst, insightsService, type InsightsService } from "./analytics-insights.js";
import { renderDashboard, type SendOutcome } from "./analytics-page.js";
import { ticketBody, ticketTitle, tomradeSender, TomradeUnavailable, type Sender } from "./analytics-ticket.js";

/** The page's only scripts, served from this package so the page needs no network beyond loopback. */
const assets: Record<string, () => string> = {
  "/assets/echarts.min.js": () => createRequire(import.meta.url).resolve("echarts/dist/echarts.min.js"),
  "/assets/dashboard.js": () => fileURLToPath(new URL("./analytics-client.js", import.meta.url))
};

export function dashboardServer(load: (f: Filters) => Promise<View>, insights?: InsightsService, send: Sender = tomradeSender()): Server {
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Reject DNS rebinding and cross-origin requests to the local admin service.
    const host = `127.0.0.1:${(res.socket?.address() as { port: number }).port}`;
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers["sec-fetch-site"] === "cross-site") {
      res.writeHead(403); res.end(); return;
    }
    const url = new URL(req.url ?? "/", `http://${host}`);
    const asset = req.method === "GET" ? assets[url.pathname] : undefined;
    if (asset) {
      try {
        const body = await readFile(asset());
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.end(body);
      } catch { res.writeHead(404); res.end(); }
      return;
    }
    // Generating an analysis spends money: only a form posted from this page starts one.
    if (req.method === "POST" && url.pathname === "/insights" && insights) {
      if (req.headers.origin !== `http://${host}`) { res.writeHead(403); res.end(); return; }
      req.resume();
      let f: Filters;
      try { f = filters(url.searchParams); } catch { res.writeHead(400); res.end(); return; }
      await insights.generate(f);
      res.writeHead(303, { Location: `/${url.search}#card-insights` }); res.end();
      return;
    }
    // Filing a ticket is a write too, and starts a process: same guard as generating.
    if (req.method === "POST" && url.pathname === "/insights/send" && insights) {
      if (req.headers.origin !== `http://${host}`) { res.writeHead(403); res.end(); return; }
      req.resume();
      let f: Filters;
      try { f = filters(url.searchParams); } catch { res.writeHead(400); res.end(); return; }
      const back = new URLSearchParams(url.searchParams);
      back.delete("sent"); back.delete("senderror");
      const { entry } = await insights.read(f);
      try {
        if (!entry) throw new Error("no analysis");
        back.set("sent", (await send(ticketTitle(entry, f.lang), ticketBody(entry, f.lang))).key);
      } catch (error) { back.set("senderror", error instanceof TomradeUnavailable ? "unavailable" : "failed"); }
      res.writeHead(303, { Location: `/?${back.toString()}#card-insights` }); res.end();
      return;
    }
    if (req.method !== "GET" || url.pathname !== "/") { res.writeHead(404); res.end(); return; }
    let f: Filters;
    try { f = filters(url.searchParams); }
    catch { res.writeHead(400); res.end(renderDashboard(filters(new URLSearchParams()), undefined, "invalid")); return; }
    let view: View;
    try { view = await load(f); }
    catch { res.writeHead(502); res.end(renderDashboard(f, undefined, "failed")); return; }
    const key = url.searchParams.get("sent") ?? "";
    const error = url.searchParams.get("senderror");
    const sent: SendOutcome | undefined = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(key) ? { key } : error === "unavailable" || error === "failed" ? { error } : undefined;
    res.end(renderDashboard(f, view, undefined, await insights?.read(f), sent));
  });
}
export async function serveAnalytics(port = 19100): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid analytics port");
  const sources = endpoints(process.env);
  const analysis = insightsService({ load: (f, parts) => loadDashboard(sources, f, fetch, parts), analyst: claudeAnalyst() });
  const server = dashboardServer((f) => loadView(sources, f), analysis);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  console.log(`http://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => server.once("close", resolve));
}
