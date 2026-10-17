import { describe, expect, it } from "vitest";
import { hooksSettings } from "@tomradex/code-link";

describe("session hooks", () => {
  it("leaves the event response on stdout for Claude Code", () => {
    const settings = hooksSettings("http://127.0.0.1/session") as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    const command = settings.hooks.PostToolUseFailure?.[0]?.hooks[0]?.command ?? "";
    expect(command).toContain("curl -s -m 5");
    // run in a herdr pane, the hook names it; outside one the variable is empty and curl sends no such header
    expect(command).toContain(`-H "X-Tomrade-Herdr-Pane: $HERDR_PANE_ID"`);
    expect(command).toContain("2>/dev/null || true");
    expect(command).not.toMatch(/(?:^|\s)>\/dev\/null/);
  });
});
