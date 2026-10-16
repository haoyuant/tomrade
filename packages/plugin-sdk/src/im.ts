import { z } from "zod";
import type { Localized } from "./contract.js";

/** Provider-neutral transport contract. Adapters never receive Agent or project access. */
export interface ImAddress {
  tenantId: string;
  conversationId: string;
  topicId?: string;
}

export interface ImAttachmentRef {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

/**
 * A native slash command or menu entry arrives as a message whose text is the
 * plain command (`/stop`), so plain-text commands keep working everywhere.
 */
export type ImInbound = {
  eventId: string;
  address: ImAddress;
  actor: { id: string; name?: string; isBot: boolean };
} & (
  /** `ambient` (SDK 0.2.5): a group message that neither mentions nor replies to the bot, sent only by adapters that receive every group message. */
  | { kind: "message"; messageId: string; text: string; activation: "dm" | "mention" | "reply" | "ambient"; attachments?: ImAttachmentRef[]; permalink?: string }
  /** An adapter acknowledges the platform within its callback deadline before awaiting `receive`; the outcome updates the card later. */
  | { kind: "action"; token: string; value?: string | string[] }
);

/** How an adapter writes formatted text. `markdown` passes the common layer's Markdown through unchanged. */
export type ImMarkdownDialect = "plain" | "markdown" | "slack" | "telegram-html" | "discord" | "lark" | "dingtalk" | "wecom";

export interface ImButton {
  label: string;
  token: string;
  /** SDK 0.2.5. A hint; adapters without styled buttons ignore it. */
  style?: "default" | "primary" | "danger";
}

/** SDK 0.2.5. Structured parts beside the text; the common layer folds what an adapter cannot show into `text`. */
export type ImElement =
  | { type: "section"; title?: string; text?: string; fields?: { label: string; value: string }[] }
  | { type: "links"; links: { label: string; url: string }[] }
  /** Answered with an action carrying the chosen value, or the list of values when `multiple`. */
  | { type: "select"; token: string; placeholder?: string; multiple?: boolean; options: { label: string; value: string }[] }
  /** A free-text answer entry, answered with an action whose value is the text. */
  | { type: "input"; token: string; label: string; placeholder?: string };

export interface ImContent {
  /** Already written in the adapter's declared Markdown dialect, and within its length limit. */
  text: string;
  actions?: ImButton[];
  elements?: ImElement[];
  files?: { id: string; name: string; mimeType: string; size: number }[];
}

export interface ImDelivery {
  /** Stable across retries. A provider should use its native deduplication where available. */
  operationId: string;
  address: ImAddress;
  replaceMessageId?: string;
  /** SDK 0.2.5. Post inside this thread: the address's topic, or the triggering message on platforms with `threads`. */
  threadId?: string;
  /** SDK 0.2.5. Quote-reply to this message, on platforms without threads. */
  replyTo?: string;
  /** SDK 0.2.5. Show only to this actor; set only for adapters declaring `ephemeral`. */
  visibleTo?: string;
  content: ImContent;
}

export type ImConnectionState = "connecting" | "connected" | "offline" | "error";

/** The common layer's commands, for registering as native slash commands or menu entries. */
export interface ImCommand {
  name: string;
  description: string;
  /** Shown as the argument hint, e.g. `token answer`. */
  args?: string;
}

/** A reaction's meaning; the adapter picks the emoji (👀 / ✅ / ❌) and replaces the previous one. */
export type ImReaction = "received" | "done" | "failed";

export interface ImAdapterSession {
  deliver(command: ImDelivery): Promise<{ messageId: string }>;
  download?(ref: ImAttachmentRef): Promise<Uint8Array>;
  /** SDK 0.2.5. Typing or the platform's "thinking" status; `idle` clears it. Best effort. */
  indicate?(command: { address: ImAddress; threadId?: string; state: "typing" | "thinking" | "idle" }): Promise<void>;
  /** SDK 0.2.5. Reacts to a message the person sent. Best effort. */
  react?(command: { address: ImAddress; messageId: string; reaction: ImReaction }): Promise<void>;
  /** SDK 0.2.5. A native streaming message, used when `stream` is `native`. */
  stream?: {
    start(command: ImDelivery): Promise<{ messageId: string }>;
    append(command: { operationId: string; address: ImAddress; messageId: string; delta: string }): Promise<void>;
    /** Settles the message with its final content, which may differ from what was appended. */
    stop(command: { operationId: string; address: ImAddress; messageId: string; content: ImContent }): Promise<{ messageId: string }>;
  };
  /** SDK 0.2.5. Registers the commands natively, when `nativeCommands`. Called after every connect. */
  commands?(commands: ImCommand[]): Promise<void>;
  /** SDK 0.2.5. The bot the credentials signed in as, checked against the platform; shown so the person sees setup worked. */
  identity?: { id: string; name?: string };
  close(): void | Promise<void>;
}

/** SDK 0.2.5. One value a person copies from the platform's developer console. */
export interface ImCredentialField {
  key: string;
  label: Localized;
  /** Drawn as a password field. Every value is sealed by the OS keychain either way. */
  secret?: boolean;
  optional?: boolean;
  placeholder?: string;
  help?: Localized;
}

/** SDK 0.2.5. What connecting one bot takes, for the settings wizard. */
export interface ImAdapterSetup {
  fields: ImCredentialField[];
  /** What to do in the platform's console, in order; Markdown. */
  steps: Localized[];
  /** Scopes or permissions the app needs. */
  permissions?: string[];
  /** An app manifest to paste, e.g. Slack's. */
  manifest?: { format: "json" | "yaml"; text: string };
  docsUrl?: string;
}

/** What the platform can do. Fields marked 0.2.5 are optional; leaving them out declares the 0.2.2 behaviour. */
export interface ImCapabilities {
  edit: boolean;
  buttons: boolean;
  inboundFiles: boolean;
  outboundFiles: boolean;
  maxTextLength: number;
  maxFileBytes: number;
  /** SDK 0.2.5. Replies can go into a thread under the triggering message. */
  threads?: boolean;
  reactions?: boolean;
  typing?: boolean;
  /** `native`: session.stream. `edit`: throttled edits of one message. `none`: only the final message. */
  stream?: "native" | "edit" | "none";
  select?: boolean;
  multiSelect?: boolean;
  /** Free-text answer entries (`input` elements). */
  textInput?: boolean;
  /** Sections, fields and links render natively. */
  cards?: boolean;
  /** A message with buttons or selects can be updated in place; defaults to `edit`. */
  cardUpdate?: boolean;
  nativeCommands?: boolean;
  ephemeral?: boolean;
  /** Defaults to `markdown`: the text arrives as the common layer wrote it. */
  markdown?: ImMarkdownDialect;
  /** Messages and edits allowed per conversation in a window, e.g. WeCom's 30 a minute. */
  rateLimit?: { messages: number; windowMs: number };
}

export const IM_MARKDOWN_DIALECTS = ["plain", "markdown", "slack", "telegram-html", "discord", "lark", "dingtalk", "wecom"] as const satisfies readonly ImMarkdownDialect[];

/** The capability fields only SDK 0.2.5 understands; declaring one needs `engines.sdk` of at least that. */
export const IM_CAPABILITIES_V2 = ["threads", "reactions", "typing", "stream", "select", "multiSelect", "textInput", "cards", "cardUpdate", "nativeCommands", "ephemeral", "markdown", "rateLimit"] as const;

export const ImCapabilitiesSchema = z.object({
  edit: z.boolean(),
  buttons: z.boolean(),
  inboundFiles: z.boolean(),
  outboundFiles: z.boolean(),
  maxTextLength: z.number().int().min(128),
  maxFileBytes: z.number().int().min(0),
  threads: z.boolean().optional(),
  reactions: z.boolean().optional(),
  typing: z.boolean().optional(),
  stream: z.enum(["native", "edit", "none"]).optional(),
  select: z.boolean().optional(),
  multiSelect: z.boolean().optional(),
  textInput: z.boolean().optional(),
  cards: z.boolean().optional(),
  cardUpdate: z.boolean().optional(),
  nativeCommands: z.boolean().optional(),
  ephemeral: z.boolean().optional(),
  markdown: z.enum(IM_MARKDOWN_DIALECTS).optional(),
  rateLimit: z.object({ messages: z.number().int().min(1), windowMs: z.number().int().min(1) }).optional()
});

/** Every capability spelled out, with the 0.2.2 behaviour where an adapter is silent. */
export type ResolvedImCapabilities = Required<Omit<ImCapabilities, "rateLimit">> & Pick<ImCapabilities, "rateLimit">;

export function resolveImCapabilities(caps: ImCapabilities): ResolvedImCapabilities {
  const parsed = ImCapabilitiesSchema.parse(caps);
  return {
    ...parsed,
    threads: parsed.threads ?? false,
    reactions: parsed.reactions ?? false,
    typing: parsed.typing ?? false,
    stream: parsed.stream ?? "none",
    select: parsed.select ?? false,
    multiSelect: parsed.multiSelect ?? false,
    textInput: parsed.textInput ?? false,
    cards: parsed.cards ?? false,
    cardUpdate: parsed.cardUpdate ?? parsed.edit,
    nativeCommands: parsed.nativeCommands ?? false,
    ephemeral: parsed.ephemeral ?? false,
    markdown: parsed.markdown ?? "markdown"
  };
}

export interface ImAdapter {
  /** Carries the plugin's namespace. */
  id: string;
  title: string;
  capabilities: ImCapabilities;
  /** SDK 0.2.5. Without it, connections take no credentials in settings and the adapter keeps its own. */
  setup?: ImAdapterSetup;
  /** Credentials never go into events, routes, Agent context or logs. */
  open(connectionId: string, io: {
    signal: AbortSignal;
    /** SDK 0.2.5. The connection's values for `setup.fields`, decrypted. */
    credentials: Record<string, string>;
    /** Resolves after local persistence, not after the Agent finishes. */
    receive(event: ImInbound): Promise<{ receiptId: string }>;
    status(state: ImConnectionState, detail?: string): void;
    /** Reads only handles explicitly included in a delivery for this connection. */
    readOutboundFile(id: string): Promise<Uint8Array>;
  }): Promise<ImAdapterSession>;
}

export interface ImApi {
  register(adapter: ImAdapter): Promise<() => void>;
}

/** Only a known-unsent operation is safe to retry; unknown failures remain uncertain. */
export class ImDeliveryError extends Error {
  constructor(message: string, public readonly disposition: "retryable" | "uncertain" | "permanent", public readonly retryAfterMs?: number) {
    super(message);
    this.name = "ImDeliveryError";
  }
}
