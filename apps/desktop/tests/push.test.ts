import { expect, it } from "vitest";
import { PhonePush, type FetchLike } from "../src/push.js";

const answer = (body: string, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => body });

/** A fetch that records what was posted and answers as the service would. */
function recorder(answers: string[] = []) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    return answer(answers[calls.length - 1] ?? "{}");
  };
  return { calls, fetch };
}

const request = { title: "TOM-12 · Claude Code needs your approval", body: "Fix the login redirect\nWaited 3 min" };

it("publishes an ntfy notice as JSON at the server root, naming the topic from the address", async () => {
  const { calls, fetch } = recorder();
  const sent = await new PhonePush({ fetch }).send([{ channel: "ntfy", url: "https://ntfy.sh/tomrade-7f3a" }], request);
  expect(sent).toBeNull();
  expect(calls).toEqual([{ url: "https://ntfy.sh/", body: { topic: "tomrade-7f3a", title: request.title, message: request.body } }]);
});

it("posts a Bark push to the server's push endpoint with the device key from the address", async () => {
  const { calls, fetch } = recorder(['{"code":200,"message":"success"}']);
  const sent = await new PhonePush({ fetch }).send([{ channel: "bark", url: "https://api.day.app/abc123" }], request);
  expect(sent).toBeNull();
  expect(calls).toEqual([{ url: "https://api.day.app/push", body: { device_key: "abc123", title: request.title, body: request.body } }]);
});

it("sends a Feishu bot the notice as one text message, and reads the refusal it hides behind HTTP 200", async () => {
  const ok = recorder(['{"code":0,"msg":"success"}']);
  const hook = "https://open.feishu.cn/open-apis/bot/v2/hook/xyz";
  expect(await new PhonePush({ fetch: ok.fetch }).send([{ channel: "feishu", url: hook }], request)).toBeNull();
  expect(ok.calls).toEqual([{ url: hook, body: { msg_type: "text", content: { text: `${request.title}\n${request.body}` } } }]);

  const refused = recorder(['{"code":19024,"msg":"Key Words Not Found"}']);
  const failure = await new PhonePush({ fetch: refused.fetch }).send([{ channel: "feishu", url: hook }], request);
  expect(failure).toMatchObject({ channel: "feishu", error: "Key Words Not Found" });
});

it("keeps sending to the other services when one refuses, and remembers the first refusal until a notice gets through", async () => {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    return url.includes("down.example") ? answer("nope", 503) : answer("{}");
  };
  const push = new PhonePush({ fetch, now: () => 1700000000000 });
  const failure = await push.send(
    [
      { channel: "ntfy", url: "https://down.example/topic" },
      { channel: "feishu", url: "https://open.feishu.cn/open-apis/bot/v2/hook/xyz" }
    ],
    request
  );
  expect(calls).toHaveLength(2);
  expect(failure).toEqual({ at: 1700000000000, channel: "ntfy", error: "HTTP 503" });
  expect(push.lastFailure()).toEqual(failure);

  await push.send([{ channel: "ntfy", url: "https://ntfy.sh/topic" }], request);
  expect(push.lastFailure()).toBeNull();
});

it("says nothing and touches no network when the person configured no address", async () => {
  const { calls, fetch } = recorder();
  const push = new PhonePush({ fetch });
  expect(await push.send([], request)).toBeNull();
  expect(calls).toEqual([]);
  expect(push.lastFailure()).toBeNull();
});
