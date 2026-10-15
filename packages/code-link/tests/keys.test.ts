import { describe, expect, it, vi } from "vitest";
import type { LlmService } from "@tomradex/llm";
import { SLUG_MAX, branchFor, keysInText, parseBranch, slugify, titleSlug, usableSlug } from "@tomradex/code-link";

/** Only completeJson is exercised; the rest throws so a wrong path is loud. */
const llmAnswering = (answer: unknown, seen?: string[]): LlmService =>
  ({
    completeJson: async (_schema: unknown, request: { user: string }) => {
      seen?.push(request.user);
      return answer;
    },
    for: () => {
      throw new Error("not used");
    },
    forProfile: () => {
      throw new Error("not used");
    },
    ready: () => ({ ok: false }),
    profiles: () => [],
    test: async () => ({ ok: true }),
    lend: () => () => {},
    worker: async () => ({ ok: false })
  }) as unknown as LlmService;

describe("keys", () => {
  it("names a branch from the template", () => {
    expect(branchFor("{key}/{slug}", "TOM-42", "Push notifications!")).toBe("tom-42/push-notifications");
    expect(branchFor("feat/{KEY}-{slug}", "TOM-42", "Push")).toBe("feat/TOM-42-push");
    expect(branchFor("{num}-{slug}", "TOM-42", "Push")).toBe("42-push");
    expect(slugify("中文标题")).toBe("work");
    expect(slugify("  Über  läuft  ")).toBe("uber-lauft");
    // A slug chosen elsewhere is used as it is: the template does not slug it again.
    expect(branchFor("{key}/{slug}", "TOM-42", "ignored", "unify-usage-statistics")).toBe("tom-42/unify-usage-statistics");
  });

  it("caps a slug at the limit, only lowercase letters, digits and dashes", () => {
    expect(slugify("a".repeat(200))).toHaveLength(SLUG_MAX);
    expect(slugify("Mixed_CASE and dots.")).toBe("mixed-case-and-dots");
    expect(usableSlug("  Unify usage!!! statistics. ")).toBe("unify-usage-statistics");
    expect(usableSlug("!!! ???")).toBe("");
    expect(usableSlug(42)).toBe("");
    expect(usableSlug("x".repeat(200))).toHaveLength(SLUG_MAX);
  });

  it("slugs a title a local rule can read without asking a model", async () => {
    const seen: string[] = [];
    const llm = llmAnswering({ slug: "never" }, seen);
    expect(await titleSlug(llm, "Push notifications!")).toBe("push-notifications");
    expect(await titleSlug(llm, "")).toBe("work");
    expect(await titleSlug(llm, "!!! ???")).toBe("work");
    expect(seen).toEqual([]);
  });

  it("asks the model for a Chinese title and tidies whatever it answers", async () => {
    const seen: string[] = [];
    const llm = llmAnswering({ slug: "Unify Usage Statistics" }, seen);
    expect(await titleSlug(llm, "统一 ticket 用量与用量统计的 token 口径")).toBe("unify-usage-statistics");
    expect(seen).toEqual(["统一 ticket 用量与用量统计的 token 口径"]);
  });

  it("falls back to the local rule when the model is absent, broken or answers rubbish", async () => {
    expect(await titleSlug(null, "统一 ticket 用量与用量统计的 token 口径")).toBe("ticket-token");
    const broken = { completeJson: async () => {
      throw new Error("offline");
    } } as unknown as LlmService;
    expect(await titleSlug(broken, "代码守卫")).toBe("work");
    expect(await titleSlug(llmAnswering({ slug: "!!!" }), "统一 ticket 用量")).toBe("ticket");
    expect(await titleSlug(llmAnswering({ notASlug: 1 }), "修复 bug")).toBe("bug");
  });

  it("does not let a model that streams on hold Start: a short cap and a deadline, then the local rule", async () => {
    vi.useFakeTimers();
    try {
      let asked: { maxTokens?: number; signal?: AbortSignal } = {};
      const endless = { completeJson: (_schema: unknown, request: { maxTokens?: number; signal?: AbortSignal }) => {
        asked = request;
        return new Promise((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(request.signal!.reason)));
      } } as unknown as LlmService;
      const slug = titleSlug(endless, "修复 bug");
      await vi.advanceTimersByTimeAsync(8000);
      expect(await slug).toBe("bug");
      expect(asked.maxTokens).toBe(100);
      expect(asked.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the key back wherever the template put it", () => {
    expect(parseBranch("tom-42/push", "TOM")).toBe(42);
    expect(parseBranch("origin/feat/TOM-42-push", "TOM")).toBe(42);
    expect(parseBranch("refs/remotes/origin/tom-7", "TOM")).toBe(7);
    expect(parseBranch("refs/heads/TOM-7", "TOM")).toBe(7);
    expect(parseBranch("atom-42/x", "TOM")).toBeNull();
    expect(parseBranch("tom-42abc", "TOM")).toBeNull();
    expect(parseBranch("main", "TOM")).toBeNull();
  });

  it("finds every key a commit message names, once, in order", () => {
    expect(keysInText("TOM-42: add push\n\nRefs TOM-42, tom-7. Not XTOM-9 or TOM-10a", "TOM")).toEqual([42, 7]);
    expect(keysInText("nothing here", "TOM")).toEqual([]);
  });
});
