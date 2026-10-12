import { describe, expect, it } from "vitest";
import { DETAILS_MAX_CHARS, describeFailure, redactSecrets } from "@tomradex/agent";

describe("describeFailure", () => {
  it("names each section and leaves the empty ones out", () => {
    expect(describeFailure({ error: undefined, stderr: "" })).toBeUndefined();
    const text = describeFailure({ response: { stopReason: "refusal", _meta: { reason: "upstream said no" } }, stderr: "  warn: slow\n" })!;
    expect(text).toContain("── response ──\n{\n  \"stopReason\": \"refusal\"");
    expect(text).toContain("upstream said no");
    expect(text).toContain("── stderr ──\nwarn: slow");
  });

  it("keeps an error's own fields, its causes and where it was thrown", () => {
    const error = Object.assign(new Error("request failed", { cause: new TypeError("socket hang up") }), {
      status: 502,
      response: { url: "https://api.example.com/v1/chat/completions", body: "{\"error\":\"bad gateway\"}" },
      headers: new Map([["x-request-id", "req_1"]])
    });
    const text = describeFailure({ error })!;
    expect(text).toMatch(/^── error ──\nError: request failed/);
    expect(text).toContain("status: 502");
    expect(text).toContain("bad gateway");
    expect(text).toContain("\"x-request-id\": \"req_1\"");
    expect(text).toContain("caused by TypeError: socket hang up");
    expect(text).toContain("failure.test.ts");
  });

  it("never shows a key or token", () => {
    const leaked = 'Authorization: Bearer abcdefghijklmnop sk-ant-api03-0123456789abcdef {"api_key": "s3cr3tvalue"} ghp_0123456789abcdefghij token=abcdef123456';
    const clean = redactSecrets(leaked);
    for (const secret of ["abcdefghijklmnop", "0123456789abcdef", "s3cr3tvalue", "0123456789abcdefghij", "abcdef123456"]) expect(clean).not.toContain(secret);
    expect(describeFailure({ stderr: leaked })).not.toContain("s3cr3tvalue");
  });

  it("keeps the head and the tail of something long", () => {
    const text = describeFailure({ stderr: `first line\n${"x".repeat(DETAILS_MAX_CHARS * 2)}\nlast line` })!;
    expect(text.length).toBeLessThan(DETAILS_MAX_CHARS + 100);
    expect(text).toContain("first line");
    expect(text).toContain("last line");
    expect(text).toMatch(/characters left out/);
  });
});
