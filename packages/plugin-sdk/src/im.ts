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

export type ImInbound = {
  eventId: string;
  address: ImAddress;
  actor: { id: string; name?: string; isBot: boolean };
} & (
  | { kind: "message"; messageId: string; text: string; activation: "dm" | "mention" | "reply"; attachments?: ImAttachmentRef[]; permalink?: string }
  | { kind: "action"; token: string; value?: string | string[] }
);

export interface ImContent {
  text: string;
  actions?: { label: string; token: string }[];
  files?: { id: string; name: string; mimeType: string; size: number }[];
}

export interface ImDelivery {
  /** Stable across retries. A provider should use its native deduplication where available. */
  operationId: string;
  address: ImAddress;
  replaceMessageId?: string;
  content: ImContent;
}

export type ImConnectionState = "connecting" | "connected" | "offline" | "error";

export interface ImAdapterSession {
  deliver(command: ImDelivery): Promise<{ messageId: string }>;
  download?(ref: ImAttachmentRef): Promise<Uint8Array>;
  close(): void | Promise<void>;
}

export interface ImAdapter {
  /** Carries the plugin's namespace. */
  id: string;
  title: string;
  capabilities: {
    edit: boolean;
    buttons: boolean;
    inboundFiles: boolean;
    outboundFiles: boolean;
    maxTextLength: number;
    maxFileBytes: number;
  };
  /** Credentials stay in the adapter's machine settings, never in events or routes. */
  open(connectionId: string, io: {
    signal: AbortSignal;
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
