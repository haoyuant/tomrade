export default async function(t) {
  t.im.engine({ id: "fake", title: "Fake engine", author: "ai:test", available: async () => ({ ok: true }),
    async turn(input, io) {
      const item = await io.tools.execute("create_item", { title: input.input.text, status: "backlog" });
      io.emit({ type: "text", text: `Created ${item.key}` }); return { stop: "end" };
    } });
  t.im.configure({ connections: [{ id: "test", adapterId: "fake_im" }], routes: [{ id: "route", connectionId: "test", tenantId: "team",
    conversationId: "chat", projectId: t.projectId, engine: "fake", allowedActors: ["owner"] }] });
  const until = async condition => { for (let i = 0; i < 200; i++) { if (await condition()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error("Fixture did not settle"); };
  await until(() => t.im.connections()[0].state === "connected");
  const before = t.items().length;
  await t.tool("fake_im_receive", { eventId: "ignored", text: "private", actor: "stranger" });
  t.check("outside allowlist creates no conversation", t.im.threads().length === 0);
  const receipt = await t.tool("fake_im_receive", { eventId: "ticket", text: "An explicitly requested ticket" });
  const duplicate = await t.tool("fake_im_receive", { eventId: "ticket", text: "An explicitly requested ticket" });
  t.check("duplicate event returns original receipt", receipt.receiptId === duplicate.receiptId);
  await until(() => t.items().length === before + 1);
  await until(async () => (await t.tool("fake_im_replies")).some(r => r.content.text.startsWith("Created ")));
  t.check("message is routed into the real Agent thread", t.im.threads().length === 1);
  t.check("one requested ticket created", t.items().length === before + 1);
  t.check("one execution despite duplicate", t.im.thread(t.im.threads()[0].id).runs.length === 1);
}
