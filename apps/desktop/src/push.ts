import type {} from "@tomradex/ipc";

/**
 * Where a phone notice goes: one address per service the person set up. All of
 * them are third-party apps — Tomrade keeps no relay — so the message itself is
 * only what the ticket says, never code or a conversation.
 */
export interface PushTarget {
  channel: "ntfy" | "bark" | "feishu";
  url: string;
}

export interface PushRequest {
  /** One line: the ticket key, who waits and what for. */
  title: string;
  /** The ticket's title and how long it waited, plus what the agent said if the person asked for it. */
  body: string;
}

/** The last push that did not get through, for the settings pane to show. */
export interface PushFailure {
  at: number;
  channel: PushTarget["channel"];
  error: string;
}

type Reply = { ok: boolean; status: number; text(): Promise<string> };
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<Reply>;

const said = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A configured address split into the part every call goes to and the last segment that names this person. */
function split(url: string): { base: string; last: string } {
  const at = new URL(url);
  const parts = at.pathname.split("/").filter(Boolean);
  const last = decodeURIComponent(parts.pop() ?? "");
  return { base: `${at.origin}${parts.length ? `/${parts.join("/")}` : ""}`, last };
}

const json = (reply: Reply): Promise<unknown> => reply.text().then((text) => (text ? JSON.parse(text) : null));

/**
 * One phone notice, posted to every service the person configured. A service
 * that refuses is recorded and the others still go; a notice that got through
 * clears the recorded failure.
 */
export class PhonePush {
  private failure: PushFailure | null = null;

  constructor(private readonly deps: { fetch: FetchLike; now?: () => number; timeoutMs?: number }) {}

  /** The last push that failed, or null once one has gone through. */
  lastFailure(): PushFailure | null {
    return this.failure;
  }

  /** Never throws: the desktop notification is not held back by a phone that cannot be reached. */
  async send(targets: PushTarget[], request: PushRequest): Promise<PushFailure | null> {
    if (!targets.length) return this.failure;
    const at = this.deps.now ?? Date.now;
    const failures = await Promise.all(
      targets.map(async (target): Promise<PushFailure | null> => {
        try {
          await this.one(target, request);
          return null;
        } catch (error) {
          return { at: at(), channel: target.channel, error: said(error) };
        }
      })
    );
    this.failure = failures.find((failure): failure is PushFailure => failure !== null) ?? null;
    return this.failure;
  }

  private async one(target: PushTarget, request: PushRequest): Promise<void> {
    const signal = AbortSignal.timeout(this.deps.timeoutMs ?? 10_000);
    const post = async (url: string, body: unknown): Promise<Reply> => {
      const reply = await this.deps.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal
      });
      if (!reply.ok) throw new Error(`HTTP ${reply.status}`);
      return reply;
    };
    if (target.channel === "ntfy") {
      // ntfy publishes a message as JSON to its root, naming the topic — a title in a
      // header cannot carry the words of a language that is not Latin-1.
      const { base, last } = split(target.url);
      if (!last) throw new Error("the ntfy address names no topic");
      await post(`${base}/`, { topic: last, title: request.title, message: request.body });
      return;
    }
    if (target.channel === "bark") {
      const { base, last } = split(target.url);
      if (!last) throw new Error("the Bark address carries no device key");
      const reply = await json(await post(`${base}/push`, { device_key: last, title: request.title, body: request.body })) as { code?: number; message?: string } | null;
      if (reply?.code !== undefined && reply.code !== 200) throw new Error(reply.message ?? `Bark answered ${reply.code}`);
      return;
    }
    // Feishu answers 200 even when it refuses, and says why in the body.
    const reply = await json(await post(target.url, { msg_type: "text", content: { text: `${request.title}\n${request.body}` } })) as
      | { code?: number; msg?: string; StatusCode?: number; StatusMessage?: string }
      | null;
    const code = reply?.code ?? reply?.StatusCode;
    if (code !== undefined && code !== 0) throw new Error(reply?.msg ?? reply?.StatusMessage ?? `Feishu answered ${code}`);
  }
}
