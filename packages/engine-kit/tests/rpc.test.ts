import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { JsonLinePeer, jsonRpc, RpcError } from "../src/rpc.js";

// The other side: answers `echo`, refuses `fail`, never answers `hang`, asks Tomrade `ask` back on `ping`, exits on `quit`.
const OTHER = `
const rl = require("readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "echo") send({ jsonrpc: "2.0", id: m.id, result: m.params });
  else if (m.method === "empty") send({ jsonrpc: "2.0", id: m.id });
  else if (m.method === "fail") send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "sign in first", data: { why: "auth" } } });
  else if (m.method === "ping") { send({ jsonrpc: "2.0", method: "said", params: { n: 1 } }); send({ jsonrpc: "2.0", id: 900, method: "ask", params: {} }); send({ jsonrpc: "2.0", id: 901, method: "nope", params: {} }); }
  else if (m.id === 900 || m.id === 901) send({ jsonrpc: "2.0", method: "answered", params: m });
  else if (m.method === "quit") { process.stderr.write("going away\\n"); process.exit(3); }
});
`;

const children: ChildProcessWithoutNullStreams[] = [];
const start = () => {
  const child = spawn(process.execPath, ["-e", OTHER], { stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  return child;
};
afterEach(() => { for (const child of children.splice(0)) child.kill(); });

describe("a JSON-RPC peer over a process's stdio", () => {
  it("answers requests, refuses with a typed error, and answers the other side's requests both ways", async () => {
    const said: unknown[] = [];
    const peer = new JsonLinePeer(start(), { name: "Fake", dialect: jsonRpc({ version: true }) })
      .onNotification((method, params) => said.push([method, params]))
      .onRequest((method) => (method === "ask" ? { yes: true } : Promise.reject(new RpcError("not offered", -32601))));
    expect(await peer.request("echo", { a: 1 })).toEqual({ a: 1 });
    expect(await peer.request("empty")).toBeNull();
    const refused = await peer.request("fail").catch((error) => error);
    expect(refused).toBeInstanceOf(RpcError);
    expect(refused).toMatchObject({ message: "sign in first", code: -32000, data: { why: "auth" } });
    await peer.request("ping", {}, 50).catch(() => {});
    await expect.poll(() => said.length).toBe(3);
    expect(said[0]).toEqual(["said", { n: 1 }]);
    const answers = said.slice(1).map((s) => (s as [string, { id: number; result?: unknown; error?: unknown }])[1]);
    expect(answers.find((a) => a.id === 900)).toMatchObject({ jsonrpc: "2.0", result: { yes: true } });
    expect(answers.find((a) => a.id === 901)).toMatchObject({ error: { code: -32601, message: "not offered" } });
  });

  it("gives each request its own deadline, reads an empty result as the protocol says, and rejects everything open on close", async () => {
    const peer = new JsonLinePeer(start(), { name: "Fake", dialect: jsonRpc({ empty: () => ({}) }), timeoutMs: 100 });
    // Up first, on its own time: the deadline is a request's, and a node starting on a loaded Windows can take longer.
    expect(await peer.request("echo", { up: true }, 10_000)).toEqual({ up: true });
    expect(await peer.request("empty")).toEqual({});
    await expect(peer.request("hang")).rejects.toThrow("Fake did not answer hang within 0.1s");
    const open = peer.request("hang", {}, 0);
    let reason: Error | undefined;
    peer.onClose((error) => { reason = error; });
    peer.close(new Error("done here"));
    await expect(open).rejects.toThrow("done here");
    expect(reason?.message).toBe("done here");
    await expect(peer.request("echo")).rejects.toThrow("Fake is not running");
  });

  it("says the process exited, with the end of its stderr", async () => {
    const peer = new JsonLinePeer(start(), { name: "Fake", dialect: jsonRpc({ version: true }) });
    const closed = new Promise<Error>((resolve) => peer.onClose(resolve));
    await expect(peer.request("quit", {}, 0)).rejects.toThrow(/Fake exited with 3: going away/);
    expect((await closed).message).toMatch(/exited with 3/);
    expect(peer.alive).toBe(false);
    expect(peer.stderrTail).toContain("going away");
  });

  it("speaks a protocol of its own dialect, and ends the connection when a handler fails where it cannot refuse", async () => {
    const child = spawn(process.execPath, ["-e", `
      const rl = require("readline").createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const m = JSON.parse(line);
        if (m.type === "go") process.stdout.write(JSON.stringify({ type: "dialog", id: "d1" }) + "\\n");
      });`], { stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    const peer = new JsonLinePeer(child, { name: "Pi", dialect: {
      id: (seq) => `t-${seq}`,
      request: (id, method, params) => ({ id, type: method, ...params }),
      notify: (method, params) => ({ type: method, ...params }),
      read: (msg) => (msg.type === "dialog" ? { kind: "request", id: msg.id, method: "dialog", params: msg } : null),
      reply: (id, result) => ({ type: "answer", id, result })
    } }).onRequest(() => { throw new Error("cannot ask"); });
    const closed = new Promise<Error>((resolve) => peer.onClose(resolve));
    peer.notify("go");
    expect((await closed).message).toBe("cannot ask");
  });
});
