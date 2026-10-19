/**
 * Plugins shape the in-app loop the way they shape a dsh agent's: each model
 * request before it is sent, a failed request (sent again, changed or on
 * another model), and the end of a turn (kept going until their condition
 * holds). A hook that fails is passed over, and none can loop forever.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { describe, expect, it } from "vitest";
import { fresh, sdk } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent } from "@tomradex/agent";
import type { ChatEvent, ChatModel, ChatRequest } from "@tomradex/llm";
import { definePlugin } from "@tomradex/plugin-sdk";
import loop from "@tomradex/engine-loop";

const answer = (text = "done"): ChatEvent[] => [{ type: "text", delta: text }, { type: "stop", reason: "end" }];

type Sent = ChatRequest & { profile: string };

/** One model per profile id; each request is kept, with the profile it went to. */
function models(replies: Record<string, (request: ChatRequest, n: number) => ChatEvent[] | Error>) {
  const sent: Sent[] = [];
  const model = (profile: string): ChatModel => ({
    capabilities: { tools: true, streaming: true, json: true },
    async *chat(request: ChatRequest) {
      sent.push({ ...request, profile });
      const out = replies[profile]!(request, sent.filter((s) => s.profile === profile).length - 1);
      if (out instanceof Error) throw out;
      yield* out;
    }
  });
  const plugin = {
    name: "fake-models",
    apply(ctx: Context) {
      ctx.provide("llm", {
        for: () => model("a"),
        forProfile: (id: string) => {
          if (!replies[id]) throw new Error(`no profile ${id}`);
          return model(id);
        },
        profiles: () => Object.keys(replies).map((id) => ({ id, title: id })),
        ready: () => ({ ok: true, profile: { id: "a", title: "a", provider: "fake", model: "fake" } }),
        test: async () => ({ ok: true }),
        listing: async () => ({ ok: true, models: [], capabilities: {} }),
        lend: () => () => {},
        worker: async () => ({ ok: true, via: "profile", title: "a" })
      } as never);
    }
  };
  return { sent, plugin };
}

async function turn(replies: Parameters<typeof models>[0], hooks: unknown[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-loop-hooks-"));
  const { sent, plugin } = models(replies);
  const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], plugin, [Agent, { mediaDir: path.join(root, "media") }], loop, ...(hooks as never[])] });
  const warnings: string[] = [];
  ctx.logger.exporter({ colors: 0, export: (m: { type: string; args: unknown[] }) => void (m.type === "warn" && warnings.push(String(m.args[0]))) } as never);
  const thread = ctx.agent.newThread(project.id, "loop");
  const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "tidy the backlog" });
  await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status, { timeout: 5_000 }).not.toBe("running");
  const status = ctx.agent.store.run(project.id, run.runId)?.status;
  const notes = ctx.agent.store.messages(project.id, thread.id).flatMap((m) => (m.block.type === "note" ? [m.block.text] : []));
  await ctx.fiber.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  return { sent, status, notes, warnings };
}

const extension = (plugin: ReturnType<typeof definePlugin>, namespace = "shaper") => sdk(plugin as never, { id: `someone/${namespace}`, namespace, origin: "extension" });
const lastText = (request: ChatRequest) => request.messages.at(-1)!.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");

describe("plugins in the in-app loop", () => {
  it("shape each request before it is sent: what they hand back is what goes", async () => {
    const seen: unknown[] = [];
    const raw = {
      name: "raw-shaper",
      apply(ctx: Context) {
        ctx.on("agent/request", async (request, next) => {
          seen.push(request.turn);
          request.system += "\n(raw: answer in haiku)";
          request.tools = request.tools.filter((t) => t.name !== "delete_item");
          return next();
        });
      }
    };
    const fromSdk = extension(
      definePlugin({
        inject: ["agent"],
        async apply(p) {
          await p.agent.request((request) => ({ system: `${request.system}\n(sdk: step ${request.turn.step})`, messages: [...request.messages, { role: "user", content: [{ type: "text", text: "(sdk: one more line)" }] }] }));
        }
      })
    );
    const { sent, status } = await turn({ a: () => answer() }, [raw, fromSdk]);
    expect(status).toBe("done");
    expect(sent[0]!.system).toContain("(raw: answer in haiku)");
    expect(sent[0]!.system).toContain("(sdk: step 1)");
    expect((sent[0]!.tools ?? []).map((t) => t.name)).not.toContain("delete_item");
    expect((sent[0]!.tools ?? []).map((t) => t.name)).toContain("list_items");
    expect(lastText(sent[0]!)).toBe("(sdk: one more line)");
    expect(seen[0]).toMatchObject({ purpose: "backlog", profile: "a", step: 1 });
  });

  it("pass over a hook that throws, and the request goes as it was", async () => {
    const raw = { name: "raw-broken", apply: (ctx: Context) => void ctx.on("agent/request", () => { throw new Error("raw hook broke"); }) };
    const fromSdk = extension(definePlugin({ inject: ["agent"], async apply(p) { await p.agent.request(() => { throw new Error("sdk hook broke"); }); } }), "breaker");
    const { sent, status, warnings } = await turn({ a: () => answer() }, [fromSdk, raw]);
    expect(status).toBe("done");
    expect(sent).toHaveLength(1);
    expect(warnings.join("\n")).toMatch(/sdk hook broke/);
    expect(warnings.join("\n")).toMatch(/raw hook broke/);
  });

  it("send a failed request again on a plugin's answer — changed, on another model — at most twice a step", async () => {
    const fallback = extension(
      definePlugin({
        inject: ["agent"],
        async apply(p) {
          await p.agent.requestError((failure) => (failure.message.includes("overloaded") ? { profile: "b", request: { system: "(fallback)" } } : undefined));
        }
      }),
      "fallback"
    );
    const done = await turn({ a: () => new Error("model a is overloaded"), b: () => answer("from b") }, [fallback]);
    expect(done.status).toBe("done");
    expect(done.sent.map((s) => s.profile)).toEqual(["a", "b"]);
    expect(done.sent[1]!.system).toBe("(fallback)");

    const stubborn = { name: "stubborn", apply: (ctx: Context) => void ctx.on("agent/request-error", () => ({ request: {} })) };
    const failed = await turn({ a: () => new Error("still down") }, [stubborn]);
    expect(failed.status).toBe("error");
    expect(failed.sent).toHaveLength(3);
  });

  it("keep a turn going until a plugin's condition holds, a few times at most, and say so", async () => {
    let checks = 0;
    const tests = extension(
      definePlugin({
        inject: ["agent"],
        async apply(p) {
          await p.agent.turnEnding((ending) => (ending.continued === 0 && (checks += 1) ? { continue: "(run the tests before you finish)" } : undefined));
        }
      }),
      "tests"
    );
    const kept = await turn({ a: (_r, n) => answer(n === 0 ? "all done" : "tests pass, done") }, [tests]);
    expect(kept.status).toBe("done");
    expect(kept.sent).toHaveLength(2);
    expect(lastText(kept.sent[1]!)).toBe("(run the tests before you finish)");
    expect(kept.notes).toHaveLength(1);
    expect(checks).toBe(1);

    const never = { name: "never-satisfied", apply: (ctx: Context) => void ctx.on("agent/turn-stopping", () => ({ continue: "(again)" })) };
    const bounded = await turn({ a: () => answer() }, [never]);
    expect(bounded.status).toBe("done");
    expect(bounded.sent).toHaveLength(4);
  });
});
