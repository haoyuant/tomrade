import type { Finding, Observed } from "./analyze.js";

/** What the store's review found, as the listing shows it and the publisher reads it. */
export interface ReviewReport {
  v: 1;
  verdict: "listed" | "held" | "rejected";
  /** One paragraph a person can read before installing. */
  summary: string;
  risk: "low" | "elevated" | "high";
  riskReasons: string[];
  observed: Observed | null;
  findings: Finding[];
  tests: { ok: boolean; checks: { name: string; ok: boolean; detail?: string }[] } | null;
  ai: {
    model: string;
    summary: string;
    malicious: { verdict: "none" | "suspected" | "clear"; confidence: "low" | "medium" | "high"; evidence: { file: string; line: number | null; explanation: string }[] };
    matchesDescription: boolean;
    concerns: { severity: "info" | "warn" | "high"; title: string; detail: string; file: string | null; line: number | null }[];
    promptInjection: { where: string; text: string; explanation: string }[];
    diff: { from: string; risk: "low" | "medium" | "high"; carryOver: boolean; summary: string } | null;
  } | null;
  /** When the badge came from an earlier human review, the version that review was of. */
  reviewedAs: string | null;
  bundled: string[];
  builtAt: number;
}
