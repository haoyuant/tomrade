import type { Disposer, Localized } from "./contract.js";

type Maybe<T> = T | Promise<T>;

/** SDK 0.2.33. What kind of feedback an entry is; anything else arrives as "feedback". */
export type InboxKind = "bug" | "feedback" | "idea";

export interface InboxAttachment {
  name: string;
  url: string;
}

/** One piece of feedback as a source hands it over. */
export interface InboxEntryInput {
  /** The source's own id for it: one entry per (source, externalId), however often it is pulled. */
  externalId: string;
  url?: string | null;
  kind?: InboxKind;
  /** Who sent it, as far as the source shows: a login, a handle. */
  reporter?: string | null;
  title: string;
  body?: string;
  attachments?: InboxAttachment[];
  /** Epoch ms. */
  receivedAt: number;
}

/** An entry as the inbox keeps it, shown to the source it came from when it is replied to or triaged. A copy. */
export interface InboxEntry {
  id: string;
  projectId: string;
  source: string;
  externalId: string;
  url: string | null;
  kind: InboxKind;
  reporter: string | null;
  title: string;
  body: string;
  attachments: InboxAttachment[];
  receivedAt: number;
  status: "new" | "accepted" | "merged" | "closed";
  /** The ticket it became, or was merged into. */
  itemId: string | null;
  closeReason: "wontfix" | "duplicate" | null;
  reply: string | null;
  repliedAt: number | null;
  triagedAt: number | null;
  activityAt: number | null;
  shippedIn: string | null;
  duplicateOf: string | null;
}

/** What the inbox tells a source after a triage, so whoever wrote sees it where they wrote. */
export type InboxTriageChange =
  | { state: "accepted" | "merged"; ticket: { key: string; title: string } }
  | { state: "closed"; reason: "wontfix" | "duplicate"; duplicateOf?: { externalId: string; url: string | null } }
  | { state: "reopened" }
  | { state: "shipped"; version: string; ticket: { key: string; title: string } };

/** Something new at the source on an entry already here: a comment, a reopen. */
export interface InboxActivity {
  externalId: string;
  at: number;
}

export interface InboxPullScope {
  projectId: string;
  /** Epoch ms the last pull reached; null: from the start. */
  since: number | null;
  /** The source's own bookkeeping from its last pull, kept as given (JSON). */
  state: unknown;
}

export type InboxPullResult =
  | InboxEntryInput[]
  | {
      entries: InboxEntryInput[];
      /** Where the next pull starts — needed when the source leaves some of what it read out. */
      cursor: number | null;
      activity?: InboxActivity[];
      state?: unknown;
      /** What went wrong without failing the pull; the next pull's replace them. */
      warnings?: string[];
    };

/** A per-project switch the source offers, such as whether it may close what it brought in. */
export interface InboxSourceOption {
  id: string;
  title: Localized;
  description?: Localized;
  default: boolean;
}

/** Where feedback comes from, as the app's own sources are. Pull only: the backlog is never mirrored back. */
export interface InboxSourceSpec {
  /** Namespaced like every id a plugin registers. */
  id: string;
  title: Localized;
  /** What one of its ids looks like in text ("#\\d+"), as a regular expression. */
  keyPattern?: string;
  /** Null when it can pull in this project; otherwise why not, in the person's language. */
  available?(projectId: string): Maybe<string | null>;
  /** What arrived since `since`; entries already here are skipped. */
  pull(scope: InboxPullScope): Maybe<InboxPullResult>;
  /** Carries a person's answer to whoever wrote. */
  reply?(entry: InboxEntry, text: string): Maybe<void>;
  /** Hears each triage of what came from it; a change it could not take is tried again before the next pull. */
  setStatus?(entry: InboxEntry, change: InboxTriageChange): Maybe<void>;
  options?: InboxSourceOption[];
}

/** SDK 0.2.33. Sources only: triage stays with the person. */
export interface InboxApi {
  /** Each project switches it on in the inbox's Sources pane; it is gone when disposed or the plugin unloads, and what it brought in stays. */
  source(spec: InboxSourceSpec): Promise<Disposer>;
}
