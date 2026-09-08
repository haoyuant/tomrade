import { describe, expect, it } from "vitest";
import { hooksSettings } from "@tomrade/code-link";

describe("session hooks", () => {
  it("leaves the event response on stdout for Claude Code", () => {
    const settings = hooksSettings("http://127.0.0.1/session") as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    const command = settings.hooks.PostToolUseFailure?.[0]?.hooks[0]?.command ?? "";
    expect(command).toContain("curl -s -m 5");
    expect(command).toContain("2>/dev/null || true");
    expect(command).not.toMatch(/(?:^|\s)>\/dev\/null/);
  });
});
