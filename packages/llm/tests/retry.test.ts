/**
 * A rate limit, an overloaded server or a dropped connection is tried again —
 * before the reply streams, so nothing is said twice — and a request the
 * server refused on its merits is not.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenAiCompatible, collect, userMessage } from "@tomradex/llm";

let server: http.Server;
let base = "";
let hits = 0;
let plan: number[] = [];
let seen: { headers: http.IncomingHttpHeaders; body: string }[] = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      hits += 1;
      seen.push({ headers: req.headers, body });
      const status = plan.shift() ?? 200;
      if (status !== 200) return res.writeHead(status, { "content-type": "application/json" }).end(`{"error":{"message":"status ${status}"}}`);
      res.writeHead(200, { "content-type": "text/event-stream" }).end('data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const ask = (signal?: AbortSignal) => collect(new OpenAiCompatible({ baseURL: base, apiKey: "k", model: "m", retryDelayMs: 5 }).chat({ system: "s", messages: [userMessage("ping")] }, signal));

describe("retries", () => {
  it("tries an overloaded server again and answers", async () => {
    hits = 0;
    plan = [503];
    expect((await ask()).text).toBe("pong");
    expect(hits).toBe(2);
  });
  it("gives up after two more tries and says why", async () => {
    hits = 0;
    plan = [429, 429, 429];
    await expect(ask()).rejects.toThrow("429");
    expect(hits).toBe(3);
  });
  it("announces each retry before trying again", async () => {
    hits = 0;
    plan = [503, 429];
    const retries: unknown[] = [];
    const out = await collect(new OpenAiCompatible({ baseURL: base, apiKey: "k", model: "m", retryDelayMs: 5 }).chat({ system: "s", messages: [userMessage("ping")] }), undefined, (r) => retries.push(r));
    expect(out.text).toBe("pong");
    expect(retries).toEqual([
      { type: "retry", attempt: 1, max: 2, reason: "HTTP 503", delayMs: 5 },
      { type: "retry", attempt: 2, max: 2, reason: "HTTP 429", delayMs: 15 }
    ]);
  });
  it("names the socket error when the connection fails", async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const retries: { reason: string }[] = [];
    await expect(collect(new OpenAiCompatible({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "m", retryDelayMs: 1 }).chat({ system: "s", messages: [userMessage("ping")] }), undefined, (r) => retries.push(r))).rejects.toBeDefined();
    expect(retries.map((r) => r.reason)).toEqual(["ECONNREFUSED", "ECONNREFUSED"]);
  });
  it("does not retry a request refused on its merits", async () => {
    hits = 0;
    plan = [400];
    await expect(ask()).rejects.toThrow("400");
    expect(hits).toBe(1);
  });
  it("asks for the headers again before each try, in place of the bearer key, with the body it sends", async () => {
    plan = [503];
    seen = [];
    const asked: { url: string; body: string }[] = [];
    const model = new OpenAiCompatible({ baseURL: base, apiKey: "k", model: "m", retryDelayMs: 5, headers: async (request) => (asked.push(request), { "api-key": `token-${asked.length}` }) });
    expect((await collect(model.chat({ system: "s", messages: [userMessage("ping")] }))).text).toBe("pong");
    expect(asked.map((a) => a.url)).toEqual([`${base}/chat/completions`, `${base}/chat/completions`]);
    expect(seen.map((s) => [s.headers["api-key"], s.headers.authorization, s.headers["content-type"]])).toEqual([
      ["token-1", undefined, "application/json"],
      ["token-2", undefined, "application/json"]
    ]);
    expect(asked.map((a) => a.body)).toEqual(seen.map((s) => s.body));
  });
  it("fails the request when the headers cannot be had, without trying", async () => {
    hits = 0;
    const model = new OpenAiCompatible({ baseURL: base, apiKey: "k", model: "m", retryDelayMs: 5, headers: () => { throw new Error("token expired"); } });
    await expect(collect(model.chat({ system: "s", messages: [userMessage("ping")] }))).rejects.toThrow("token expired");
    expect(hits).toBe(0);
  });
  it("stops waiting when the run is stopped", async () => {
    hits = 0;
    plan = [503, 503, 503];
    const abort = new AbortController();
    const asked = ask(abort.signal);
    setTimeout(() => abort.abort(), 2);
    await expect(asked).rejects.toBeDefined();
    expect(hits).toBeLessThan(3);
  });
});
