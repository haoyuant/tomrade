import type { AgentManifest } from "./detection.js";

/*
 * Detection manifests for agents Tomrade starts that herdr has none for, in herdr's shape. Hand-written, kept apart
 * from the generated manifests.ts so a refresh leaves them; a manifest herdr publishes for the same agent wins.
 */

/** Tomrade's own manifests, by agent. */
export const TOMRADE_MANIFESTS: Record<string, AgentManifest> = {
  // CodeBuddy Code (WorkBuddy's CLI) 2.177: its folder trust, tool permission, AskUserQuestion menu and its review step.
  codebuddy: {
    id: "codebuddy",
    version: "2026.10.28.1",
    min_engine_version: 2,
    aliases: ["codebuddy-code", "workbuddy"],
    rules: [
      { id: "trust_prompt", state: "blocked", priority: 990, region: "whole_recent", visible_blocker: true, contains: ["do you trust the files in this folder?", "no, exit", "enter to confirm"] },
      {
        id: "question_menu",
        state: "blocked",
        priority: 980,
        region: "bottom_non_empty_lines(4)",
        visible_blocker: true,
        line_regex: ["(?i)^[\\s│]*enter to select · (?:↑/↓|↑↓|arrow keys) to navigate · esc to cancel[\\s│]*$"]
      },
      { id: "question_review", state: "blocked", priority: 980, region: "bottom_non_empty_lines(8)", visible_blocker: true, contains: ["ready to submit your answers?", "enter to select"] },
      {
        id: "tool_permission",
        state: "blocked",
        priority: 970,
        region: "bottom_non_empty_lines(12)",
        visible_blocker: true,
        line_regex: ["(?i)^[\\s│]*>?\\s*1\\.\\s*yes[\\s│]*$"],
        any: [{ contains: ["no, and tell"] }, { line_regex: ["(?i)^[\\s│]*>?\\s*[23]\\.\\s*no\\b"] }]
      },
      { id: "idle_prompt", state: "idle", priority: 100, region: "bottom_non_empty_lines(3)", visible_idle: true, line_regex: ["(?i)\\(shift\\+tab to cycle\\)\\s*$"] }
    ]
  }
};
