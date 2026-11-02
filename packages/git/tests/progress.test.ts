import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncRecorder, parseGitProgress, proxyInUse, type SyncProgress } from "../src/progress.js";

afterEach(() => vi.useRealTimers());

describe("what git says of a transfer", () => {
  it("reads the latest of the lines git rewrites in place", () => {
    const chunk = "Receiving objects:  12% (257/2137), 1.20 MiB | 15.00 KiB/s\rReceiving objects:  45% (961/2137), 5.32 MiB | 15.00 KiB/s";
    expect(parseGitProgress(chunk)).toEqual({ phase: "Receiving objects", percent: 45, done: 961, total: 2137, size: "5.32 MiB", rate: "15.00 KiB/s" });
    expect(parseGitProgress("remote: Counting objects: 100% (5/5), done.")).toEqual({ phase: "Counting objects", percent: 100, done: 5, total: 5 });
    expect(parseGitProgress("From https://github.com/acme/docs\n * branch main -> FETCH_HEAD")).toBeNull();
  });

  it("names the proxy git goes through, never its credential", () => {
    expect(proxyInUse({ HTTPS_PROXY: "http://me:secret@127.0.0.1:7897" })).toBe("http://127.0.0.1:7897");
    expect(proxyInUse({ http_proxy: "http://proxy.corp:3128" })).toBe("http://proxy.corp:3128");
    expect(proxyInUse({})).toBeNull();
  });
});

describe("a sync as it goes", () => {
  it("tells a new step at once and a transfer at most every 300 ms, then that it is over", () => {
    vi.useFakeTimers();
    const told: (SyncProgress | null)[] = [];
    const recorder = new SyncRecorder((progress) => told.push(progress));
    recorder.step("reaching");
    recorder.step("fetching");
    expect(told.map((p) => p?.step)).toEqual(["reaching", "fetching"]);
    recorder.stderr("Receiving objects:  10% (1/10)\r");
    recorder.stderr("Receiving objects:  20% (2/10)\r");
    recorder.stderr("Receiving objects:  30% (3/10)\r");
    expect(told).toHaveLength(2);
    vi.advanceTimersByTime(300);
    expect(told).toHaveLength(3);
    expect(told[2]?.transfer?.percent).toBe(30);
    recorder.finish();
    expect(told.at(-1)).toBeNull();
  });

  it("says nothing at its end when it never told anything", () => {
    const told: (SyncProgress | null)[] = [];
    new SyncRecorder((progress) => told.push(progress)).finish();
    expect(told).toEqual([]);
  });

  it("keeps each step's time and whether it failed, where it went, and what git said without progress or credentials", () => {
    const recorder = new SyncRecorder();
    expect(recorder.located).toBe(false);
    recorder.step("saving");
    recorder.locate({ remote: "https://x-access-token:ghs_secret@github.com/acme/docs.git", branch: "main", directory: "project-files" });
    recorder.step("reaching");
    recorder.step("fetching");
    recorder.stderr("Receiving objects:  45% (961/2137), 5.32 MiB | 15.00 KiB/s\r");
    recorder.stderr("error: RPC failed; curl 56 Recv failure: Connection was reset\nfatal: unable to access 'https://x-access-token:ghs_secret@github.com/acme/docs.git/': early EOF\n");
    recorder.fail();
    const trace = recorder.finish();
    expect(recorder.located).toBe(true);
    expect(trace.steps.map((s) => [s.step, s.ok])).toEqual([["saving", true], ["reaching", true], ["fetching", false]]);
    expect(trace).toMatchObject({ remote: "https://github.com/acme/docs.git", branch: "main", directory: "project-files" });
    expect(trace.output).toBe("error: RPC failed; curl 56 Recv failure: Connection was reset\nfatal: unable to access 'https://github.com/acme/docs.git/': early EOF");
  });
});
