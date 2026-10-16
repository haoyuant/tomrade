import type { ImAddress, ImContent, ImElement, ImInbound } from "@tomradex/plugin-sdk";

/** Discord's payloads, only as far as this adapter reads them. */
export interface DUser { id: string; username: string; global_name?: string | null; bot?: boolean }
export interface DAttachment { id: string; filename: string; content_type?: string; size: number; url: string }
export interface DMessage {
  id: string; channel_id: string; guild_id?: string; type: number; content: string; author: DUser; webhook_id?: string;
  mentions?: DUser[]; attachments?: DAttachment[]; edited_timestamp?: string | null;
  message_reference?: { message_id?: string }; referenced_message?: { id?: string; content?: string; author?: DUser } | null;
}
export interface DInteraction {
  id: string; application_id: string; type: number; token: string; channel_id?: string; guild_id?: string;
  member?: { user: DUser }; user?: DUser;
  data?: { name?: string; options?: DOption[]; custom_id?: string; component_type?: number; values?: string[];
    components?: { components: { custom_id: string; value: string }[] }[] };
}
export interface DOption { name: string; type: number; value?: string; options?: DOption[] }

export const API = "https://discord.com/api/v10";
export const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
/** GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES. Message Content stays off: a mention or a direct message carries its text anyway. */
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 12);
/** The privileged intent that lets other people's channel messages arrive with their text; only when the person turned it on in the portal. */
export const MESSAGE_CONTENT = 1 << 15;
export const wantsContent = (value: string | undefined) => /^(on|yes|true|1)$/i.test(value?.trim() ?? "");
export const LIMIT = { text: 2000, embeds: 10, title: 256, description: 4096, fields: 25, fieldName: 256, fieldValue: 1024, rows: 5, perRow: 5, label: 80, options: 25, optionText: 100 };

/** Message types a person sends: a plain message and a reply. */
const SPOKEN = new Set([0, 19]);
const THREAD_TYPES = new Set([10, 11, 12]);
export const isThread = (type: number) => THREAD_TYPES.has(type);

const clip = (text: string, n: number) => ([...text].length > n ? `${[...text].slice(0, n - 1).join("")}…` : text);
const nameOf = (u: DUser) => u.global_name || u.username;
export const actorOf = (u: DUser) => ({ id: u.id, name: nameOf(u), isBot: !!u.bot });

/** Where a channel's messages belong: a thread is a topic of its parent channel, so the parent's route covers it. */
export function addressOf(guildId: string | undefined, channelId: string, parentOf: (id: string) => string | null): ImAddress {
  const parent = guildId ? parentOf(channelId) : null;
  return { tenantId: guildId ?? "@me", conversationId: parent ?? channelId, ...(parent ? { topicId: channelId } : {}) };
}

/** A person's message as the common layer takes it, or null when it is not one the bot answers. */
export function inboundMessage(m: DMessage, botId: string, parentOf: (id: string) => string | null): (ImInbound & { kind: "message" }) | null {
  if (!SPOKEN.has(m.type) || m.webhook_id || m.author.bot || m.author.id === botId) return null;
  const mention = new RegExp(`<@!?${botId}>`, "g");
  const dm = !m.guild_id;
  const mentioned = !!m.mentions?.some(u => u.id === botId) || mention.test(m.content);
  const replied = m.referenced_message?.author?.id === botId;
  const activation = dm ? "dm" : mentioned ? "mention" : replied ? "reply" : "ambient";
  const text = m.content.replace(mention, "").trim();
  // Without the Message Content intent other people's channel chatter arrives empty; there is nothing to act on.
  if (activation === "ambient" && !text) return null;
  const ref = m.referenced_message;
  // Without Message Content a quoted message by someone else may arrive empty; then there is nothing to show.
  const quoted = ref?.id && ref.author && ref.content?.trim() ? { role: "quoted" as const, messageId: ref.id, author: actorOf(ref.author), text: ref.content } : null;
  const attachments = (m.attachments ?? []).slice(0, 8).filter(a => a.size > 0).map(a => ({ id: a.id, name: clip(a.filename, 255), mimeType: a.content_type || "application/octet-stream", size: a.size }));
  return {
    kind: "message", eventId: `m:${m.id}`, messageId: m.id, text, activation,
    actor: actorOf(m.author), address: addressOf(m.guild_id, m.channel_id, parentOf),
    ...(attachments.length ? { attachments } : {}),
    permalink: `https://discord.com/channels/${m.guild_id ?? "@me"}/${m.channel_id}/${m.id}`,
    ...(m.message_reference?.message_id ? { replyTo: m.message_reference.message_id } : {}),
    ...(quoted ? { context: [quoted] } : {})
  };
}

/** A control's custom_id: its kind, then the common layer's token. */
export type ControlKind = "b" | "s" | "m" | "i";
export const controlId = (kind: ControlKind, token: string) => `${kind}:${token}`;
export function parseControl(customId: string | undefined): { kind: ControlKind; token: string } | null {
  const m = /^([bsmi]):(.+)$/.exec(customId ?? "");
  return m ? { kind: m[1] as ControlKind, token: m[2]! } : null;
}

const http = (url: string) => /^https?:\/\//i.test(url);
const STYLE = { default: 2, primary: 1, danger: 4 } as const;

/**
 * IM content as a Discord message: the text, sections as embeds, buttons and
 * selects as components (up to five rows), links as link buttons where Discord
 * allows the scheme and as text where it doesn't. Components are always set,
 * so an edit that drops them takes the old buttons away.
 */
export function messageOf(content: ImContent): { content: string; embeds: unknown[]; components: unknown[]; allowed_mentions: { parse: never[] } } {
  const embeds: { title?: string; description?: string; fields?: { name: string; value: string; inline: boolean }[] }[] = [];
  const rows: unknown[][] = [];
  const buttons: unknown[] = [];
  const linkLines: string[] = [];
  const row = (items: unknown[]) => { if (rows.length < LIMIT.rows) rows.push(items); };
  for (const el of content.elements ?? []) addElement(el);
  function addElement(el: ImElement) {
    switch (el.type) {
      case "section": {
        if (embeds.length >= LIMIT.embeds) return;
        const fields = (el.fields ?? []).slice(0, LIMIT.fields).map(f => ({ name: clip(f.label, LIMIT.fieldName) || "​", value: clip(f.value, LIMIT.fieldValue) || "​", inline: true }));
        embeds.push({ ...(el.title ? { title: clip(el.title, LIMIT.title) } : {}), ...(el.text ? { description: clip(el.text, LIMIT.description) } : {}), ...(fields.length ? { fields } : {}) });
        return;
      }
      case "links":
        for (const l of el.links) {
          if (http(l.url)) buttons.push({ type: 2, style: 5, label: clip(l.label, LIMIT.label), url: l.url });
          else linkLines.push(`${l.label}: ${l.url}`);
        }
        return;
      case "select":
        row([{ type: 3, custom_id: controlId(el.multiple ? "m" : "s", el.token), ...(el.placeholder ? { placeholder: clip(el.placeholder, 150) } : {}),
          min_values: 1, max_values: el.multiple ? Math.min(LIMIT.options, el.options.length) : 1,
          options: el.options.slice(0, LIMIT.options).map(o => ({ label: clip(o.label, LIMIT.optionText), value: clip(o.value, LIMIT.optionText) })) }]);
        return;
      case "input":
        buttons.push({ type: 2, style: 1, label: clip(el.label, LIMIT.label), custom_id: controlId("i", el.token) });
        return;
    }
  }
  for (const a of content.actions ?? []) buttons.push({ type: 2, style: STYLE[a.style ?? "default"], label: clip(a.label, LIMIT.label), custom_id: controlId("b", a.token) });
  // Buttons come first so a question's answers sit right under it; a select gets a row of its own.
  const selects = rows.splice(0);
  for (let i = 0; i < buttons.length; i += LIMIT.perRow) row(buttons.slice(i, i + LIMIT.perRow));
  for (const s of selects) row(s);
  if (linkLines.length) {
    // tomrade:// and other app links are not allowed as Discord link buttons; they are shown to copy.
    const last = embeds.at(-1);
    if (last && embeds.length) last.description = clip([last.description, ...linkLines].filter(Boolean).join("\n"), LIMIT.description);
    else if (embeds.length < LIMIT.embeds) embeds.push({ description: clip(linkLines.join("\n"), LIMIT.description) });
  }
  const text = content.text || (embeds.length || rows.length ? "" : "​");
  return { content: text, embeds, components: rows.map(components => ({ type: 1, components })), allowed_mentions: { parse: [] } };
}

/** Reactions by meaning; the adapter swaps "received" for the outcome. */
export const REACTIONS = { received: "👀", done: "✅", failed: "❌" } as const;
