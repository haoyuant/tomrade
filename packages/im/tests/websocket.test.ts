import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fresh, sdk, settle } from "@tomradex/testkit";
import { Agent } from "@tomradex/agent";
import { Im, ImSettings } from "@tomradex/im";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { definePlugin, type ImAdapter, type ImInbound } from "@tomradex/plugin-sdk";

it("keeps a real SDK WebSocket alive, reconnects after disconnection and closes it on unload", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tomrade-im-ws-"));
  const sockets = new Set<Socket>();
  const server = createServer();
  let opens = 0;
  server.on("upgrade", (req, raw) => {
    const socket = raw as Socket;
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    opens++;
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    // This server only emits small test events and acknowledges the close handshake.
    socket.on("data", bytes => { if ((bytes[0] & 15) === 8) socket.end(Buffer.from([0x88, 0])); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  const url = `ws://127.0.0.1:${address.port}`;
  const received: string[] = [];
  const failures: unknown[] = [];
  const adapter: ImAdapter = {
    id: "test_ws", title: "Loopback WebSocket",
    capabilities: { edit: false, buttons: false, inboundFiles: false, outboundFiles: false, maxTextLength: 2000, maxFileBytes: 0 },
    async open(_id, io) {
      const ws = new WebSocket(url);
      io.signal.addEventListener("abort", () => ws.close(), { once: true });
      ws.addEventListener("message", event => void io.receive(JSON.parse(String(event.data))).catch(e => failures.push(e)));
      ws.addEventListener("close", () => io.status("offline"));
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("test socket failed")), { once: true });
      });
      return { deliver: async command => { received.push(command.content.text); return { messageId: `m-${received.length}` }; }, close: () => ws.close() };
    }
  };
  const w = await fresh({ plugins: [Tools, [Settings, { path: path.join(dir, "settings.json") }], Agent, [Im, { pollMs: 10, retryMs: 10 }]] });
  try {
    w.ctx.agent.engine({ id: "test", title: "Test", author: "ai:test", available: async () => ({ ok: true }),
      async turn(input, io) { io.emit({ type: "text", text: input.input.kind === "text" ? input.input.text : "answer" }); return { stop: "end" }; } });
    const plugin = definePlugin({ inject: ["im"], async apply(ctx) { await ctx.im.register(adapter); } });
    const fiber = w.ctx.plugin(sdk(plugin, { id: "test/ws", namespace: "test", origin: "extension" }));
    await settle();
    w.ctx.settings.set({ ...w.ctx.settings.get(), im: ImSettings.parse({ connections: [{ id: "ws", adapterId: "test_ws" }],
      routes: [{ id: "route", connectionId: "ws", tenantId: "team", conversationId: "chat", projectId: w.project.id, engine: "test", allowedActors: ["owner"] }] }) });
    await expect.poll(() => w.ctx.im.views()[0].state).toBe("connected");
    const send = (id: string) => {
      const event: ImInbound = { kind: "message", eventId: id, messageId: id, text: id, activation: "dm", actor: { id: "owner", isBot: false }, address: { tenantId: "team", conversationId: "chat" } };
      const bytes = Buffer.from(JSON.stringify(event));
      const frame = Buffer.alloc(4 + bytes.length);
      frame[0] = 0x81; frame[1] = 126; frame.writeUInt16BE(bytes.length, 2); bytes.copy(frame, 4);
      [...sockets][0].write(frame);
    };
    send("before-reconnect");
    await expect.poll(() => received.includes("before-reconnect")).toBe(true);
    [...sockets][0].destroy();
    await expect.poll(() => opens).toBe(2);
    await expect.poll(() => w.ctx.im.views()[0].state).toBe("connected");
    send("after-reconnect");
    await expect.poll(() => received.includes("after-reconnect")).toBe(true);
    expect(w.ctx.agent.store.threads(w.project.id)).toHaveLength(1);
    await fiber.dispose();
    await expect.poll(() => sockets.size).toBe(0);
    expect(w.ctx.im.views()[0].state).toBe("unconfigured");
    expect(failures).toEqual([]);
  } finally {
    await w.ctx.fiber.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
