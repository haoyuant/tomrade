import { userMessage, type ChatEvent, type ChatModel, type ChatRequest, type LentModel } from "@tomradex/llm";

/** The CLI said, in its own words, that it is not signed in. */
export class NotSignedIn extends Error {}

export interface CliAnswer {
  text: string;
  /** All of the input, what the cache read included. */
  inputTokens: number;
  cacheReadTokens?: number;
  outputTokens: number;
}

/** A CLI found signed out, or whose check said nothing clear, is asked again after this long. */
export const SIGN_IN_RECHECK_MS = 30_000;
const CHECK_MS = 30_000;

/**
 * A lent model over a CLI with no sign-in status command, each call a process
 * of its own. Whether it is signed in is learned by asking: one tiny prompt the
 * first time (a signed-out CLI refuses it at once, before any model call), then
 * what each call says. Only a clear "not signed in" makes it unready.
 */
export function cliLentModel(opts: {
  id: string;
  title: string;
  rank?: number;
  /** Whether the CLI is there to run. */
  found(): Promise<boolean>;
  /** One answer; throws NotSignedIn when the CLI says it is not signed in. */
  ask(request: ChatRequest, signal?: AbortSignal): Promise<CliAnswer>;
  recheckMs?: number;
}): LentModel {
  const recheck = opts.recheckMs ?? SIGN_IN_RECHECK_MS;
  let known: { signedIn: boolean; sure: boolean; at: number } | null = null;
  let checking: Promise<void> | null = null;
  const learn = (signedIn: boolean, sure: boolean) => {
    known = { signedIn, sure, at: Date.now() };
  };

  async function signedIn(): Promise<boolean> {
    const settled = known && ((known.sure && known.signedIn) || Date.now() - known.at < recheck);
    if (!settled) {
      checking ??= opts.ask({ system: "Reply with one word.", messages: [userMessage("ping")], maxTokens: 1 }, AbortSignal.timeout(CHECK_MS))
        .then(() => learn(true, true), (error) => learn(!(error instanceof NotSignedIn), error instanceof NotSignedIn))
        .finally(() => {
          checking = null;
        });
      await checking;
    }
    return known?.signedIn ?? true;
  }

  const model: ChatModel = {
    capabilities: { tools: false, streaming: false, json: false },
    async *chat(request, signal) {
      let answer: CliAnswer;
      try {
        answer = await opts.ask(request, signal);
      } catch (error) {
        if (error instanceof NotSignedIn) learn(false, true);
        throw error;
      }
      learn(true, true);
      const events: ChatEvent[] = [
        { type: "usage", inputTokens: answer.inputTokens, outputTokens: answer.outputTokens, ...(answer.cacheReadTokens !== undefined ? { cacheReadTokens: answer.cacheReadTokens } : {}) },
        { type: "text", delta: answer.text },
        { type: "stop", reason: "end" }
      ];
      yield* events;
    }
  };
  return {
    id: opts.id,
    title: opts.title,
    ...(opts.rank !== undefined ? { rank: opts.rank } : {}),
    ready: async () => (await opts.found()) && signedIn(),
    model
  };
}
