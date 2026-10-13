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
beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      hits += 1;
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
