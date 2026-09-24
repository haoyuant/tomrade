import http from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";

const PAGE = `<!doctype html><meta charset="utf-8"><title>Tomrade</title>
<body style="font:15px system-ui;margin:3em;color:#222">
<p id="m">Finishing…</p>
<script>
const h = new URLSearchParams(location.hash.slice(1));
fetch("/done", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ access_token: h.get("access_token"), refresh_token: h.get("refresh_token"), error: h.get("error_description") }) })
  .then((r) => r.text()).then((t) => { document.getElementById("m").textContent = t; });
</script>`;

/**
 * Links the signed-in account to a GitHub identity through the system
 * browser. Supabase redirects to a server on this machine only for as long as
 * the link takes; both the PKCE code and the implicit tokens are handled.
 * Supabase Auth must list http://127.0.0.1 redirects as allowed.
 */
export async function linkGitHub(client: SupabaseClient, opts: { timeoutMs?: number } = {}): Promise<{ url: string; done: Promise<void> }> {
  let finish!: () => void;
  let fail!: (e: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const reply = (res: http.ServerResponse, status: number, text: string) => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    res.end(text);
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error_description");
      if (error) {
        reply(res, 400, `GitHub was not linked: ${error}`);
        return fail(new Error(error));
      }
      if (code) {
        void client.auth.exchangeCodeForSession(code).then(({ error: e }) => {
          if (e) {
            reply(res, 400, `GitHub was not linked: ${e.message}`);
            fail(new Error(e.message));
          } else {
            reply(res, 200, "GitHub is linked. You can close this tab and go back to Tomrade.");
            finish();
          }
        });
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(PAGE);
    }
    if (req.method === "POST" && url.pathname === "/done") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const { access_token, refresh_token, error } = JSON.parse(body || "{}") as Record<string, string | null>;
        if (error || !access_token || !refresh_token) {
          reply(res, 400, `GitHub was not linked: ${error ?? "no session came back"}`);
          return fail(new Error(error ?? "no session came back"));
        }
        void client.auth.setSession({ access_token, refresh_token }).then(({ error: e }) => {
          if (e) {
            reply(res, 400, `GitHub was not linked: ${e.message}`);
            fail(new Error(e.message));
          } else {
            reply(res, 200, "GitHub is linked. You can close this tab and go back to Tomrade.");
            finish();
          }
        });
      });
      return;
    }
    reply(res, 404, "Not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const timer = setTimeout(() => fail(new Error("the GitHub link was not finished in time")), opts.timeoutMs ?? 10 * 60_000);
  void done.finally(() => {
    clearTimeout(timer);
    server.close();
  }).catch(() => {});
  const { data, error } = await client.auth.linkIdentity({ provider: "github", options: { redirectTo: `http://127.0.0.1:${port}/callback`, skipBrowserRedirect: true } });
  if (error || !data?.url) {
    server.close();
    clearTimeout(timer);
    throw new Error(error?.message ?? "Supabase did not return a GitHub URL");
  }
  return { url: data.url, done };
}
