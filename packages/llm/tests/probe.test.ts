/**
 * Saving a model profile asks its endpoint for one token, so a wrong key, a
 * wrong model or a wrong address shows when the profile is saved — each told
 * apart, because each has a different fix.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenAiCompatible, probe } from "@tomradex/llm";

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const model = (JSON.parse(body || "{}") as { model?: string }).model;
      if (req.headers.authorization !== "Bearer good") {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"Authentication Fails, Your api key: ****-bad is invalid","type":"authentication_error"}}');
      } else if (model === "nope") {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":{"message":"Model Not Exist"}}');
      } else if (model === "busy") {
        res.writeHead(429, { "content-type": "application/json" }).end('{"error":{"message":"Rate limit reached"}}');
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" }).end('data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const model = (apiKey: string, name = "deepseek-chat", baseURL = base) => new OpenAiCompatible({ baseURL, apiKey, model: name, retryDelayMs: 5 });

describe("probe", () => {
  it("passes a profile whose endpoint answers", async () => {
    expect(await probe(model("good"))).toEqual({ ok: true });
  });
  it("calls a refused key a key problem", async () => {
    expect(await probe(model("bad"))).toMatchObject({ ok: false, kind: "auth", detail: expect.stringContaining("401") });
  });
  it("calls an unknown model a model problem", async () => {
    expect(await probe(model("good", "nope"))).toMatchObject({ ok: false, kind: "model" });
  });
  it("calls a rate limit a wait, not a broken profile", async () => {
    expect(await probe(model("good", "busy"))).toMatchObject({ ok: false, kind: "rate" });
  });
  it("calls an address nobody answers a network problem", async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    expect(await probe(model("good", "deepseek-chat", `http://127.0.0.1:${port}/v1`))).toMatchObject({ ok: false, kind: "network" });
  });
});
