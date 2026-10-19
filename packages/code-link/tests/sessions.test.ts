import { describe, expect, it } from "vitest";
import { hookCommand, hooksSettings, lastSaid } from "@tomradex/code-link";

describe("the last line a pane said", () => {
  it("skips the input box, rules and shortcut hints, and keeps the last line of substance", () => {
    expect(lastSaid("❯ Reading files…\n⏺ Scaffold in place. Next: CI.\n╭──────────╮\n│ > │\n╰──────────╯\n? for shortcuts\n")).toBe("⏺ Scaffold in place. Next: CI.");
    expect(lastSaid("> \n")).toBe("");
    expect(lastSaid(null)).toBe("");
    expect(lastSaid("x".repeat(300))).toHaveLength(200);
  });
});

describe("session hooks", () => {
  it("leaves the event response on stdout for Claude Code", () => {
    const settings = hooksSettings("http://127.0.0.1/session") as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    const command = settings.hooks.PostToolUseFailure?.[0]?.hooks[0]?.command ?? "";
    // The committed hooks' command, so it runs in the same shells; only curl's answer is not swallowed.
    expect(command).toBe(hookCommand("http://127.0.0.1/session", undefined, { reply: true, seconds: 5 }));
    expect(command).toContain("curl -s -m 5");
    // run in a herdr pane, the hook names it; outside one the variable is empty and curl sends no such header
    expect(command).toContain(`-H "X-Tomrade-Herdr-Pane: $HERDR_PANE_ID"`);
    expect(command).not.toMatch(/\$\(curl/);
    expect(command.replaceAll("2>&1", "")).not.toMatch(/'|\|\||>|\/dev\/null/);
  });
});
