import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Context } from "cordis";
import { Herdr, HerdrError, herdrCall, herdrSocketPath } from "@tomradex/herdr";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-herdr-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

type Reply = { result?: unknown; error?: { code: string; message: string } } | string;

/** A server that speaks herdr's wire format: one JSON request per line, one JSON reply per line. */
function fakeHerdr(answer: (method: string, params: Record<string, unknown>) => Reply): { socket: string; seen: string[]; close(): void } {
  const socket = path.join(root, `herdr-${Math.random().toString(36).slice(2)}.sock`);
  const seen: string[] = [];
  const server = net.createServer((connection) => {
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
        seen.push(request.method);
        const reply = answer(request.method, request.params);
        connection.write(typeof reply === "string" ? reply : `${JSON.stringify({ id: request.id, ...reply })}\n`);
      }
    });
  });
  server.listen(socket);
  return { socket, seen, close: () => server.close() };
}

describe("herdr socket client", () => {
  it("finds the socket from the pane's variables, a named session, or the default", () => {
    expect(herdrSocketPath({ HERDR_SOCKET_PATH: "/tmp/own.sock", HERDR_SESSION: "x" }, "/home/me")).toBe("/tmp/own.sock");
    expect(herdrSocketPath({ HERDR_SESSION: "work" }, "/home/me")).toBe(path.join("/home/me", ".config", "herdr", "sessions", "work", "herdr.sock"));
    expect(herdrSocketPath({}, "/home/me")).toBe(path.join("/home/me", ".config", "herdr", "herdr.sock"));
  });

  it("sends one request per connection and reads herdr's result, extra fields and all", async () => {
    const fake = fakeHerdr((method, params) => (method === "ping" ? { result: { type: "pong", version: "0.9.5", protocol: 22, capabilities: { later: true } } } : { result: { type: "ok", echoed: params } }));
    expect(await herdrCall(fake.socket, "ping")).toEqual({ type: "pong", version: "0.9.5", protocol: 22, capabilities: { later: true } });
    expect(await herdrCall(fake.socket, "pane.focus", { pane_id: "w1:p1" })).toEqual({ type: "ok", echoed: { pane_id: "w1:p1" } });
    expect(fake.seen).toEqual(["ping", "pane.focus"]);
    fake.close();
  });

  it("turns herdr's error line into an error with its code, and an unknown method into an ordinary one", async () => {
    const fake = fakeHerdr((method) => (method === "pane.get" ? { error: { code: "pane_not_found", message: "pane w9:p9 not found" } } : { error: { code: "invalid_request", message: `unknown method ${method}` } }));
    await expect(herdrCall(fake.socket, "pane.get", { pane_id: "w9:p9" })).rejects.toMatchObject({ name: "HerdrError", code: "pane_not_found", message: "pane w9:p9 not found" });
    await expect(herdrCall(fake.socket, "pane.graphics.show")).rejects.toMatchObject({ code: "invalid_request" });
    fake.close();
  });

  it("reports a server that is not there, or answers with something else, as a HerdrError and nothing else", async () => {
    await expect(herdrCall(path.join(root, "nobody.sock"), "ping")).rejects.toMatchObject({ code: "unreachable" });
    const odd = fakeHerdr(() => "not json at all\n");
    const error = await herdrCall(odd.socket, "ping").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(HerdrError);
    expect((error as HerdrError).code).toBe("bad_reply");
    odd.close();
    const quiet = fakeHerdr(() => "");
    await expect(herdrCall(quiet.socket, "ping", {}, 200)).rejects.toMatchObject({ code: "timeout" });
    quiet.close();
  });
});

describe("herdr service", () => {
  async function service(socket: string): Promise<Herdr> {
    const ctx = new Context();
    await ctx.plugin(Herdr);
    const herdr = ctx.herdr;
    herdr.socketPath = () => socket;
    return herdr;
  }

  it("focuses a pane through its workspace, and says so when the pane or the server is gone", async () => {
    const fake = fakeHerdr((method, params) => {
      if (method === "pane.get") return params.pane_id === "w2:p1" ? { result: { type: "pane_info", pane: { pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1" } } } : { error: { code: "pane_not_found", message: "no" } };
      return { result: { type: "ok" } };
    });
    const herdr = await service(fake.socket);
    expect(await herdr.focus("w2:p1")).toBe(true);
    expect(fake.seen).toEqual(["pane.get", "workspace.focus", "pane.focus"]);
    expect(await herdr.focus("w9:p9")).toBe(false);
    expect(await herdr.server()).toMatchObject({ socket: fake.socket });
    fake.close();
    const gone = await service(path.join(root, "gone.sock"));
    expect(await gone.focus("w2:p1")).toBe(false);
    expect(await gone.server()).toBeNull();
  });
});
