import { z } from "zod";
import type { Locale } from "./words.js";

const Text = z.object({ en: z.string().min(1).max(600), zh: z.string().min(1).max(600) });

/**
 * A problem someone already ran into and understood. Data only: what it
 * offers names verbs the panel already knows, so a catalog fetched from
 * tomrade.com can explain and point, never run anything.
 */
export const KnownIssue = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  /** Only for this engine's failures. */
  engine: z.string().optional(),
  /** Any one of these: a pattern in the error or its details, or a fact's value. */
  when: z.array(z.union([
    z.object({ text: z.string().min(1).max(200) }),
    z.object({ fact: z.string().min(1).max(64), matches: z.string().min(1).max(200) })
  ])).min(1).max(8),
  title: Text,
  explain: Text,
  confidence: z.enum(["high", "medium", "low"]),
  offer: z.array(z.enum(["retry-with", "sign-in", "install", "settings", "recheck"])).max(4).default([]),
  /** The release that fixed it: from there on it no longer matches. */
  fixedIn: z.string().optional()
});
export type KnownIssue = z.infer<typeof KnownIssue>;

export interface Evidence {
  engineId?: string;
  /** Error lines and their details, from the failed turn and the test turn. */
  texts: string[];
  facts: Record<string, string>;
  version: string;
}

const pattern = (source: string): RegExp | null => {
  try { return new RegExp(source, "i"); } catch { return null; }
};

/** Whether `version` (1.2.3, v-prefixed or not) comes before `fixed`. */
export function before(version: string, fixed: string): boolean {
  // Missing parts count as 0, so "dev" or "1.2" compare like any release.
  const parts = (v: string) => [0, 1, 2].map((i) => Number.parseInt(v.replace(/^v/, "").split(/[.-]/)[i] ?? "", 10) || 0);
  const [a, b] = [parts(version), parts(fixed)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

export function matches(issue: KnownIssue, evidence: Evidence): boolean {
  if (issue.engine && issue.engine !== evidence.engineId) return false;
  if (issue.fixedIn && !before(evidence.version, issue.fixedIn)) return false;
  return issue.when.some((cond) => {
    if ("text" in cond) {
      const re = pattern(cond.text);
      return !!re && evidence.texts.some((t) => re.test(t));
    }
    const value = evidence.facts[cond.fact];
    const re = pattern(cond.matches);
    return value !== undefined && !!re && re.test(value);
  });
}

export const said = (text: { en: string; zh: string }, locale: Locale): string => text[locale];

/** The problems known when this release was made. A newer catalog from tomrade.com adds to them. */
export const BUNDLED: KnownIssue[] = [
  KnownIssue.parse({
    id: "workbuddy-ioa-edition",
    engine: "workbuddy",
    when: [{ fact: "edition", matches: "^ioa$" }, { text: "-ioa\\b" }, { text: "copilot\\.tencent\\.com" }],
    title: { en: "WorkBuddy is Tencent's internal (iOA) edition", zh: "这是腾讯内部版（iOA）的 WorkBuddy" },
    explain: {
      en: "Its models end in -ioa and it talks to Tencent's internal endpoint. Tomrade has not run against this edition yet, and its sign-in may not carry over when Tomrade starts it. Carry on with another agent for now, and send this report — it tells the developer exactly what to fix.",
      zh: "它的模型名以 -ioa 结尾，连的是腾讯内部的服务地址。Tomrade 还没在这个版本上跑通过，Tomrade 启动它时登录可能对不上。先换个智能体继续，并把这份报告发给开发者——里面有修好它需要的信息。"
    },
    confidence: "medium",
    offer: ["retry-with"]
  })
];
