/**
 * The worker profile's one-token test: run once, remembered per profile
 * content, forgotten by an edit — setup screens never re-ask on a render.
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Context } from "cordis";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Settings } from "@tomradex/settings";
import { Llm, type ModelProfile } from "@tomradex/llm";

let server: http.Server;
let base = "";
let answered = 0;
let answer: "pong" | "auth" = "pong";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!req.url!.endsWith("/chat/completions")) return void res.writeHead(404).end();
      answered += 1;
      if (answer === "auth") return void res.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"Authentication fails: your key is invalid"}}');
      res.writeHead(200, { "content-type": "text/event-stream" }).end('data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  answered = 0;
  answer = "pong";
});

const profile = (over: Partial<ModelProfile> = {}): ModelProfile => ({ id: "svc", title: "Svc", provider: "openai-compatible", baseURL: base, apiKey: "k", model: "m-1", ...over });

async function llm(profiles: ModelProfile[]) {
  const ctx = new Context();
  await ctx.plugin(Settings, { path: path.join(os.tmpdir(), `tomrade-worker-test-${Date.now()}-${Math.random()}.json`) });
  await ctx.plugin(Llm);
  ctx.settings.set({ ...ctx.settings.get(), models: { profiles, roles: { worker: "" } } });
  return ctx;
}

it("asks the endpoint once and remembers the answer", async () => {
  const ctx = await llm([profile()]);
  const first = await ctx.llm.workerTest();
  expect(first).toMatchObject({ ok: true, title: "Svc" });
  expect(await ctx.llm.workerTest()).toMatchObject({ ok: true });
  expect(answered).toBe(1);
});

it("asks again only when told to", async () => {
  const ctx = await llm([profile()]);
  await ctx.llm.workerTest();
  await ctx.llm.workerTest(true);
  expect(answered).toBe(2);
});

it("keeps the provider's words on a failure, without re-asking", async () => {
  answer = "auth";
  const ctx = await llm([profile()]);
  const test = await ctx.llm.workerTest();
  expect(test).toMatchObject({ ok: false, kind: "auth", title: "Svc" });
  expect(test?.detail).toContain("your key is invalid");
  expect(await ctx.llm.workerTest()).toMatchObject({ ok: false });
  expect(answered).toBe(1);
});

it("forgets the outcome when the profile changes", async () => {
  const ctx = await llm([profile()]);
  await ctx.llm.workerTest();
  ctx.settings.set({ ...ctx.settings.get(), models: { profiles: [profile({ model: "m-2" })], roles: { worker: "" } } });
  expect(await ctx.llm.workerTest()).toMatchObject({ ok: true });
  expect(answered).toBe(2);
});

it("runs one probe for callers asking at once", async () => {
  const ctx = await llm([profile()]);
  const [a, b] = await Promise.all([ctx.llm.workerTest(), ctx.llm.workerTest()]);
  expect(a?.ok).toBe(true);
  expect(b?.ok).toBe(true);
  expect(answered).toBe(1);
});

it("says nothing about a worker that is not a profile", async () => {
  const ctx = await llm([]);
  expect(await ctx.llm.workerTest()).toBeNull();
  expect(answered).toBe(0);
});

it("counts a profile another check already tested, without asking again", async () => {
  const ctx = await llm([profile()]);
  // quick setup and the profile form both end in llm.test, which seeds the memory
  expect(await ctx.llm.test(profile())).toEqual({ ok: true });
  expect(ctx.llm.tested(profile())).toMatchObject({ ok: true });
  // nothing was asked of another model, or of this one after its key changed
  expect(ctx.llm.tested(profile({ model: "m-2" }))).toBeNull();
  expect(ctx.llm.tested(profile({ apiKey: "other" }))).toBeNull();
  expect(await ctx.llm.workerTest()).toMatchObject({ ok: true });
  expect(answered).toBe(1);
});
