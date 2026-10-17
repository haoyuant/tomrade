import { expect, it } from "vitest";
import { collect, userMessage, type ChatRequest } from "@tomradex/llm";
import { cliLentModel, NotSignedIn, type CliAnswer } from "@tomradex/engine-claude-code";

/** A CLI whose answer to each call is `says()`: an answer, NotSignedIn, or another failure. */
function cli(opts: { found?: () => boolean; recheckMs?: number } = {}) {
  const asked: ChatRequest[] = [];
  let says: () => CliAnswer = () => ({ text: '{"ok":true}', inputTokens: 5, outputTokens: 2 });
  const lent = cliLentModel({
    id: "fake", title: "Fake CLI", rank: 20, recheckMs: opts.recheckMs ?? 60_000,
    found: async () => opts.found?.() ?? true,
    async ask(request) {
      asked.push(request);
      await new Promise((r) => setTimeout(r, 5));
      return says();
    }
  });
  return { lent, asked, say: (next: () => CliAnswer) => (says = next) };
}
const signedOut = () => {
  throw new NotSignedIn("Fake CLI is not signed in — run fake and /login");
};
const ask = (lent: ReturnType<typeof cli>["lent"]) => collect(lent.model.chat({ system: "s", messages: [userMessage("go")] }));

it("asks once whether it is signed in, then trusts what the calls say", async () => {
  const { lent, asked } = cli();
  expect(lent.rank).toBe(20);
  expect(await Promise.all([lent.ready(), lent.ready()])).toEqual([true, true]);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ system: "Reply with one word.", maxTokens: 1 });
  expect(await lent.ready()).toBe(true);
  expect(asked).toHaveLength(1);
  const out = await ask(lent);
  expect(out.text).toBe('{"ok":true}');
  expect(out.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
});

it("is not ready once the CLI says it is signed out, and asks again after a while", async () => {
  const { lent, asked, say } = cli({ recheckMs: 50 });
  say(signedOut);
  expect(await lent.ready()).toBe(false);
  expect(await lent.ready()).toBe(false);
  expect(asked).toHaveLength(1);
  await new Promise((r) => setTimeout(r, 60));
  say(() => ({ text: "pong", inputTokens: 1, outputTokens: 1 }));
  expect(await lent.ready()).toBe(true);
  expect(asked).toHaveLength(2);

  // signed out between calls: the call fails with the CLI's words and the next ready() says so
  say(signedOut);
  await expect(ask(lent)).rejects.toThrow(/not signed in — run fake and \/login/);
  expect(await lent.ready()).toBe(false);
});

it("stays ready when its check fails for another reason, and asks nothing while the CLI is missing", async () => {
  let found = false;
  const { lent, asked, say } = cli({ found: () => found });
  expect(await lent.ready()).toBe(false);
  expect(asked).toHaveLength(0);
  found = true;
  say(() => {
    throw new Error("network down");
  });
  expect(await lent.ready()).toBe(true);
  await expect(ask(lent)).rejects.toThrow(/network down/);
  expect(await lent.ready()).toBe(true);
});
