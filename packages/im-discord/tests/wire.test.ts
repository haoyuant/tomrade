import { describe, expect, it } from "vitest";
import { INTENTS, MESSAGE_CONTENT, inboundMessage, messageOf, parseControl, wantsContent, type DMessage } from "../src/wire.js";

const BOT = "900";
const msg = (o: Partial<DMessage>): DMessage => ({ id: "1", channel_id: "10", type: 0, content: "hi", author: { id: "5", username: "ana" }, ...o });
const noThreads = () => null;

describe("Discord messages in", () => {
  it("answers direct messages, mentions and replies to the bot, and nothing else", () => {
    expect(inboundMessage(msg({}), BOT, noThreads)).toMatchObject({ activation: "dm", text: "hi", address: { tenantId: "@me", conversationId: "10" }, eventId: "m:1" });
    expect(inboundMessage(msg({ guild_id: "77", content: `<@${BOT}> plan it`, mentions: [{ id: BOT, username: "bot" }] }), BOT, noThreads))
      .toMatchObject({ activation: "mention", text: "plan it", address: { tenantId: "77", conversationId: "10" }, permalink: "https://discord.com/channels/77/10/1" });
    expect(inboundMessage(msg({ guild_id: "77", type: 19, content: "and this", message_reference: { message_id: "2" }, referenced_message: { author: { id: BOT, username: "bot" } } }), BOT, noThreads))
      .toMatchObject({ activation: "reply", replyTo: "2" });
    // Without Message Content, other channel messages arrive empty and are not for the bot.
    expect(inboundMessage(msg({ guild_id: "77", content: "" }), BOT, noThreads)).toBeNull();
    expect(inboundMessage(msg({ author: { id: "6", username: "other-bot", bot: true } }), BOT, noThreads)).toBeNull();
    expect(inboundMessage(msg({ author: { id: BOT, username: "me" } }), BOT, noThreads)).toBeNull();
    expect(inboundMessage(msg({ type: 7 }), BOT, noThreads)).toBeNull();
  });

  it("puts a thread under its channel, so the channel's route covers it", () => {
    const event = inboundMessage(msg({ guild_id: "77", channel_id: "11", content: `<@!${BOT}> go` }), BOT, id => (id === "11" ? "10" : null));
    expect(event?.address).toEqual({ tenantId: "77", conversationId: "10", topicId: "11" });
    expect(event?.text).toBe("go");
  });

  it("carries the replied-to message's text and author, when Discord sent it", () => {
    const quoting = (content: string) => inboundMessage(msg({ guild_id: "77", type: 19, content: `<@${BOT}> realistic?`, mentions: [{ id: BOT, username: "bot" }],
      message_reference: { message_id: "2" }, referenced_message: { id: "2", content, author: { id: "6", username: "carol", global_name: "Carol" } } }), BOT, noThreads);
    expect(quoting("ship on Friday")?.context).toEqual([{ role: "quoted", messageId: "2", author: { id: "6", name: "Carol", isBot: false }, text: "ship on Friday" }]);
    // Without Message Content someone else's message may come empty; the reply still goes through.
    expect(quoting("")).toMatchObject({ activation: "mention", replyTo: "2" });
    expect(quoting("")?.context).toBeUndefined();
  });

  it("asks for Message Content only when the person opted in", () => {
    expect(wantsContent(undefined)).toBe(false);
    expect(wantsContent("")).toBe(false);
    expect(wantsContent(" ON ")).toBe(true);
    expect(INTENTS & MESSAGE_CONTENT).toBe(0);
  });

  it("keeps attachments by reference", () => {
    const event = inboundMessage(msg({ attachments: [{ id: "a1", filename: "shot.png", content_type: "image/png", size: 42, url: "https://cdn.discordapp.com/x" }] }), BOT, noThreads);
    expect(event?.attachments).toEqual([{ id: "a1", name: "shot.png", mimeType: "image/png", size: 42 }]);
  });
});

describe("Discord messages out", () => {
  it("turns sections into embeds, buttons and selects into rows, and keeps app links as text", () => {
    const out = messageOf({
      text: "Which targets?",
      actions: [{ label: "Apply", token: "t1", style: "primary" }, { label: "Cancel", token: "t2", style: "danger" }],
      elements: [
        { type: "section", title: "TOM-12 Fix login", fields: [{ label: "Status", value: "Todo" }] },
        { type: "links", links: [{ label: "Open in Tomrade", url: "tomrade://item/p/TOM-12" }, { label: "Docs", url: "https://example.com" }] },
        { type: "select", token: "t3", multiple: true, options: [{ label: "web", value: "web" }, { label: "cli", value: "cli" }] },
        { type: "input", token: "t4", label: "Your answer" }
      ]
    });
    expect(out.content).toBe("Which targets?");
    expect(out.embeds).toEqual([{ title: "TOM-12 Fix login", fields: [{ name: "Status", value: "Todo", inline: true }], description: "Open in Tomrade: tomrade://item/p/TOM-12" }]);
    expect(out.components).toEqual([
      { type: 1, components: [
        { type: 2, style: 5, label: "Docs", url: "https://example.com" },
        { type: 2, style: 1, label: "Your answer", custom_id: "i:t4" },
        { type: 2, style: 1, label: "Apply", custom_id: "b:t1" },
        { type: 2, style: 4, label: "Cancel", custom_id: "b:t2" }
      ] },
      { type: 1, components: [{ type: 3, custom_id: "m:t3", min_values: 1, max_values: 2, options: [{ label: "web", value: "web" }, { label: "cli", value: "cli" }] }] }
    ]);
    expect(out.allowed_mentions).toEqual({ parse: [] });
  });

  it("never sends an empty message, and clears old controls on an edit", () => {
    expect(messageOf({ text: "" })).toMatchObject({ content: "​", components: [] });
    expect(messageOf({ text: "Question handled" }).components).toEqual([]);
  });

  it("fits Discord's limits", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ label: `option ${i}`, token: `t${i}` }));
    const out = messageOf({ text: "x", actions: many, elements: [{ type: "select", token: "s", options: Array.from({ length: 30 }, (_, i) => ({ label: `o${i}`, value: `${i}` })) }] });
    expect(out.components.length).toBeLessThanOrEqual(5);
    expect((out.components[0] as { components: unknown[] }).components).toHaveLength(5);
    const select = (out.components.at(-1) as { components: { options: unknown[] }[] }).components[0]!;
    expect(select.options).toHaveLength(25);
    expect(parseControl("s:abc")).toEqual({ kind: "s", token: "abc" });
    expect(parseControl("other")).toBeNull();
  });
});
