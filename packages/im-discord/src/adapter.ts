import { createHash } from "node:crypto";
import { ImDeliveryError, type ImAdapter, type ImAdapterSession, type ImAddress, type ImCapabilities, type ImCommand, type ImContextMessage, type ImDelivery, type ImInbound } from "@tomradex/plugin-sdk";
import { Gateway, net, type Net } from "./gateway.js";
import { actorOf, addressOf, API, INTENTS, inboundMessage, isThread, MESSAGE_CONTENT, messageOf, parseControl, REACTIONS, wantsContent, type DInteraction, type DMessage, type DOption } from "./wire.js";

export const CAPABILITIES: ImCapabilities = {
  edit: true, buttons: true, inboundFiles: true, outboundFiles: true,
  maxTextLength: 2000, maxFileBytes: 10 * 1024 * 1024,
  // A reply quotes the message that asked; opening a thread per task is left to the person.
  threads: false, reactions: true, typing: true, stream: "edit",
  select: true, multiSelect: true, textInput: true, cards: true, cardUpdate: true,
  nativeCommands: true, ephemeral: false, markdown: "discord",
  // About five messages or edits per channel every five seconds before Discord answers 429.
  rateLimit: { messages: 5, windowMs: 5_000 }
};

type IO = Parameters<ImAdapter["open"]>[1];

/** One REST call. A 429 is retryable after Discord's wait; other refusals are permanent. */
async function call(n: Net, token: string, method: string, path: string, body?: unknown, files?: { name: string; mimeType: string; bytes: Uint8Array }[]) {
  let init: RequestInit = { method, headers: { authorization: `Bot ${token}`, "user-agent": "DiscordBot (Tomrade, 0.1.0)" } };
  if (files?.length) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ ...(body as object), attachments: files.map((f, i) => ({ id: i, filename: f.name })) }));
    files.forEach((f, i) => form.append(`files[${i}]`, new Blob([new Uint8Array(f.bytes)], { type: f.mimeType }), f.name));
    init = { ...init, body: form };
  } else if (body !== undefined) init = { ...init, headers: { ...init.headers as Record<string, string>, "content-type": "application/json" }, body: JSON.stringify(body) };
  let res: Response;
  try { res = await n.fetch(`${API}${path}`, init); }
  // Messages carry a nonce Discord enforces, edits and reactions are idempotent: a lost answer is safe to retry.
  catch (e) { throw new ImDeliveryError(`Discord unreachable: ${(e as Error).message}`, "retryable"); }
  if (res.status === 429) {
    const wait = Number((await res.json().catch(() => ({})) as { retry_after?: number }).retry_after ?? res.headers.get("retry-after") ?? 1);
    throw new ImDeliveryError("Discord rate limit", "retryable", Math.ceil(wait * 1000));
  }
  if (res.status >= 500) throw new ImDeliveryError(`Discord error ${res.status}`, "retryable");
  if (!res.ok) {
    const detail = await res.json().catch(() => ({})) as { message?: string };
    throw new ImDeliveryError(`Discord refused (${res.status}${detail.message ? `: ${detail.message}` : ""})`, "permanent");
  }
  return res.status === 204 ? null : res.json() as Promise<Record<string, unknown>>;
}

/** Remembers the most recent `max` entries. */
class Recent<V> extends Map<string, V> {
  constructor(private readonly max: number) { super(); }
  override set(key: string, value: V) {
    super.delete(key);
    super.set(key, value);
    if (this.size > this.max) this.delete(this.keys().next().value!);
    return this;
  }
}

/** The `/tomrade` command: one subcommand per IM command, with free text after it. */
function commandsOf(commands: ImCommand[]) {
  return [{
    name: "tomrade", type: 1, description: "Tomrade", contexts: [0, 1], integration_types: [0],
    options: commands.slice(0, 25).map(c => ({
      type: 1, name: c.name.toLowerCase().slice(0, 32), description: c.description.slice(0, 100) || c.name,
      ...(c.args ? { options: [{ type: 3, name: "args", description: c.args.slice(0, 100), required: false }] } : {})
    }))
  }];
}

export async function openDiscord(connectionId: string, io: IO, opts: { net?: Net; backoffMs?: number } = {}): Promise<ImAdapterSession> {
  const n = opts.net ?? net();
  const token = io.credentials.botToken?.trim() ?? "";
  if (!token) throw new Error("Discord bot token is missing");
  const rest = (method: string, path: string, body?: unknown, files?: Parameters<typeof call>[5]) => call(n, token, method, path, body, files);

  /** Thread → parent channel, learned from the gateway and asked for once otherwise. */
  const parents = new Map<string, string | null>();
  const attachments = new Recent<string>(500);
  /** Who sent a recent message, so a deletion or an edit can be told to the common layer as theirs. */
  const authors = new Recent<string>(1000);
  let botId = "";
  let applicationId = "";
  // Events reach the common layer one at a time, in Discord's order.
  let queue = Promise.resolve();
  const later = (work: () => Promise<unknown>) => { queue = queue.then(work).then(() => {}, () => {}); };
  const receive = (event: ImInbound) => io.receive(event).catch(() => {});

  const learnChannel = (c: { id: string; type: number; parent_id?: string | null }) => { parents.set(c.id, isThread(c.type) ? c.parent_id ?? null : null); };
  const parentOf = (id: string) => parents.get(id) ?? null;
  /** A thread's first message, read once per thread. */
  const roots = new Recent<ImContextMessage | null>(200);
  const rootOf = async (threadId: string, parentId: string): Promise<ImContextMessage | null> => {
    if (roots.has(threadId)) return roots.get(threadId)!;
    let root: ImContextMessage | null = null;
    // A thread opened from a message shares its id, in the parent channel; a forum post's starter is inside the thread.
    for (const channel of [parentId, threadId]) {
      const m = await rest("GET", `/channels/${channel}/messages/${threadId}`).catch(() => null) as DMessage | null;
      if (m?.author && m.content?.trim()) { root = { role: "root", messageId: m.id, author: actorOf(m.author), text: m.content }; break; }
      if (m) break;
    }
    roots.set(threadId, root);
    return root;
  };
  const ensureChannel = async (guildId: string | undefined, channelId: string | undefined) => {
    if (!guildId || !channelId || parents.has(channelId)) return;
    try { learnChannel(await rest("GET", `/channels/${channelId}`) as { id: string; type: number; parent_id?: string | null }); }
    catch { parents.set(channelId, null); }
  };

  /** Within Discord's three seconds, before anything slower happens. */
  const answer = (i: DInteraction, body: unknown) => rest("POST", `/interactions/${i.id}/${i.token}/callback`, body).catch(() => null);

  const onInteraction = (i: DInteraction) => {
    const user = i.member?.user ?? i.user;
    if (!user || !i.channel_id) return;
    if (i.type === 2 && i.data?.name === "tomrade") {
      void answer(i, { type: 5 }).then(() => later(async () => {
        await ensureChannel(i.guild_id, i.channel_id);
        const sub = i.data?.options?.[0];
        const args = sub?.options?.find((o: DOption) => o.name === "args")?.value?.trim();
        const text = sub ? `/${sub.name}${args ? ` ${args}` : ""}` : "/help";
        // The deferred reply becomes the visible command, and the message replies quote and react to.
        const original = await rest("PATCH", `/webhooks/${applicationId}/${i.token}/messages/@original`, { content: `› ${text}`, allowed_mentions: { parse: [] } }).catch(() => null);
        await receive({ kind: "message", eventId: `i:${i.id}`, messageId: (original?.id as string | undefined) ?? i.id, text, activation: i.guild_id ? "mention" : "dm",
          actor: actorOf(user), address: addressOf(i.guild_id, i.channel_id!, parentOf) });
      }));
      return;
    }
    const control = parseControl(i.data?.custom_id);
    if (!control) return;
    if (i.type === 3 && control.kind === "i") {
      void answer(i, { type: 9, data: { custom_id: i.data!.custom_id, title: "Tomrade",
        components: [{ type: 1, components: [{ type: 4, custom_id: "answer", style: 2, label: "Answer", required: true, max_length: 4000 }] }] } });
      return;
    }
    const value = i.type === 5 ? i.data?.components?.[0]?.components?.[0]?.value
      : control.kind === "m" ? i.data?.values : control.kind === "s" ? i.data?.values?.[0] : undefined;
    void answer(i, { type: 6 }).then(() => later(async () => {
      await ensureChannel(i.guild_id, i.channel_id);
      await receive({ kind: "action", eventId: `i:${i.id}`, token: control.token, ...(value !== undefined ? { value } : {}), actor: actorOf(user), address: addressOf(i.guild_id, i.channel_id!, parentOf) });
    }));
  };

  const dispatch = (type: string, data: unknown) => {
    switch (type) {
      case "GUILD_CREATE": {
        const g = data as { channels?: { id: string; type: number; parent_id?: string | null }[]; threads?: { id: string; type: number; parent_id?: string | null }[] };
        for (const c of [...(g.channels ?? []), ...(g.threads ?? [])]) learnChannel(c);
        return;
      }
      case "THREAD_CREATE": case "THREAD_UPDATE": case "CHANNEL_CREATE":
        learnChannel(data as { id: string; type: number; parent_id?: string | null });
        return;
      case "THREAD_LIST_SYNC":
        for (const t of (data as { threads?: { id: string; type: number; parent_id?: string | null }[] }).threads ?? []) learnChannel(t);
        return;
      case "MESSAGE_CREATE": {
        const m = data as DMessage;
        later(async () => {
          await ensureChannel(m.guild_id, m.channel_id);
          const found = inboundMessage(m, botId, parentOf);
          if (!found) return;
          let event = found;
          const topic = event.address.topicId;
          if (topic && event.activation !== "ambient" && topic !== event.replyTo) {
            const root = await rootOf(topic, event.address.conversationId);
            if (root) event = { ...event, context: [...(event.context ?? []), root] };
          }
          authors.set(m.id, m.author.id);
          for (const a of m.attachments ?? []) attachments.set(a.id, a.url);
          await receive(event);
        });
        return;
      }
      case "MESSAGE_UPDATE": {
        const m = data as Partial<DMessage> & { id: string; channel_id: string };
        const author = authors.get(m.id);
        if (!author || !m.edited_timestamp) return;
        later(() => receive({ kind: "edit", eventId: `e:${m.id}:${m.edited_timestamp}`, messageId: m.id, actor: { id: author, isBot: false }, address: addressOf(m.guild_id, m.channel_id, parentOf) }));
        return;
      }
      case "MESSAGE_DELETE": {
        const m = data as { id: string; channel_id: string; guild_id?: string };
        const author = authors.get(m.id);
        if (!author) return;
        later(() => receive({ kind: "retract", eventId: `d:${m.id}`, messageId: m.id, actor: { id: author, isBot: false }, address: addressOf(m.guild_id, m.channel_id, parentOf) }));
        return;
      }
      case "INTERACTION_CREATE":
        onInteraction(data as DInteraction);
        return;
    }
  };

  const gateway = new Gateway(token, n, {
    dispatch,
    state: (state, detail) => io.status(state === "connected" ? "connected" : state === "connecting" ? "connecting" : "error", detail)
  }, { ...(opts.backoffMs !== undefined ? { backoffMs: opts.backoffMs } : {}), intents: wantsContent(io.credentials.messageContent) ? INTENTS | MESSAGE_CONTENT : INTENTS });
  io.signal.addEventListener("abort", () => gateway.stop(), { once: true });
  const ready = await gateway.start();
  botId = ready.user.id;
  applicationId = ready.applicationId;

  const channelOf = (address: ImAddress, threadId?: string) => threadId ?? address.topicId ?? address.conversationId;
  let reacted = new Recent<string>(500);

  return {
    identity: { id: ready.user.id, name: ready.user.username },

    async deliver(d: ImDelivery) {
      const channel = channelOf(d.address, d.threadId);
      const payload = messageOf(d.content);
      if (d.replaceMessageId) {
        const res = await rest("PATCH", `/channels/${channel}/messages/${d.replaceMessageId}`, payload);
        return { messageId: (res?.id as string | undefined) ?? d.replaceMessageId };
      }
      const files = [];
      for (const f of d.content.files ?? []) files.push({ name: f.name, mimeType: f.mimeType, bytes: await io.readOutboundFile(f.id) });
      // Discord drops a second message with the same nonce, so a retry after a lost answer never posts twice.
      const nonce = createHash("sha256").update(d.operationId).digest("base64url").slice(0, 25);
      const res = await rest("POST", `/channels/${channel}/messages`, {
        ...payload, nonce, enforce_nonce: true,
        ...(d.replyTo ? { message_reference: { message_id: d.replyTo, fail_if_not_exists: false } } : {})
      }, files);
      return { messageId: res!.id as string };
    },

    async download(ref) {
      const url = attachments.get(ref.id);
      if (!url) throw new Error("Attachment is no longer known");
      const res = await n.fetch(url);
      if (!res.ok) throw new Error(`Attachment download failed (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    },

    async indicate({ address, threadId, state }) {
      if (state !== "idle") await rest("POST", `/channels/${channelOf(address, threadId)}/typing`);
    },

    async react({ address, messageId, reaction }) {
      const channel = channelOf(address);
      const previous = reacted.get(messageId);
      if (previous && previous !== REACTIONS[reaction]) await rest("DELETE", `/channels/${channel}/messages/${messageId}/reactions/${encodeURIComponent(previous)}/@me`).catch(() => null);
      await rest("PUT", `/channels/${channel}/messages/${messageId}/reactions/${encodeURIComponent(REACTIONS[reaction])}/@me`);
      reacted.set(messageId, REACTIONS[reaction]);
    },

    async commands(list) {
      await rest("PUT", `/applications/${applicationId}/commands`, commandsOf(list));
    },

    close() {
      gateway.stop();
      reacted = new Recent(0);
    }
  };
}
