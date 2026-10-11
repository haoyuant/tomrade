import { beforeEach, describe, expect, it, vi } from "vitest";

const fetch = vi.fn();
vi.mock("electron", () => ({ app: { getVersion: () => "0.2.0" }, net: { fetch: (...args: unknown[]) => fetch(...args) } }));
import { checkForUpdate, compareVersions } from "../src/about.js";

describe("comparing versions", () => {
  it("orders by the numbers, not as text", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("v0.2.0", "0.2.1")).toBe(-1);
  });

  it("puts a pre-release before its release", () => {
    expect(compareVersions("0.3.0-beta.1", "0.3.0")).toBe(-1);
    expect(compareVersions("0.3.0", "0.3.0-rc.2")).toBe(1);
    expect(compareVersions("0.3.0-beta.1", "0.2.0")).toBe(1);
  });

  it("follows semver between pre-releases", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.11")).toBe(-1);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0-beta.9")).toBe(1);
  });

  it("ignores build metadata", () => {
    expect(compareVersions("1.0.0+abc", "1.0.0+def")).toBe(0);
  });
});

describe("checking for an update", () => {
  beforeEach(() => fetch.mockReset());
  const answer = (body: unknown, status = 200) => fetch.mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it("reports a newer release from the download manifest", async () => {
    answer({ version: "0.3.0", date: "2026-11-01T08:00:00Z", files: [] });
    await expect(checkForUpdate()).resolves.toEqual({ latest: "0.3.0", date: "2026-11-01T08:00:00Z", newer: true });
    expect(fetch.mock.calls[0][0]).toBe("https://download.tomrade.com/latest.json");
  });

  it("says nothing is newer when this is the latest", async () => {
    answer({ version: "0.2.0", date: "2026-10-11T08:37:49Z", files: [] });
    await expect(checkForUpdate()).resolves.toMatchObject({ latest: "0.2.0", newer: false });
  });

  it("fails rather than guess when the manifest is missing or malformed", async () => {
    answer({ error: "not found" }, 404);
    await expect(checkForUpdate()).rejects.toThrow("404");
    answer({ files: [] });
    await expect(checkForUpdate()).rejects.toThrow("no version");
  });
});
