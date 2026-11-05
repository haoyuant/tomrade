import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, runCli, type CliDeps } from "../src/cli.js";

const noDir = () => false;
// Paths as this platform spells them.
const work = path.resolve("/work/tomrade");
const otherDir = path.resolve("/work/other");

describe("tomrade term's arguments", () => {
  it("reads a folder, a ticket with or without an agent, and a pane to attach", () => {
    expect(parseArgs([], noDir)).toEqual({ op: "help" });
    expect(parseArgs(["term", "--help"], noDir)).toEqual({ op: "help" });
    expect(parseArgs(["term"], noDir)).toEqual({ op: "open", dir: null });
    expect(parseArgs(["term", "."], noDir)).toEqual({ op: "open", dir: "." });
    expect(parseArgs(["term", "--agent", "codex", "TOM-638"], noDir)).toEqual({ op: "start", key: "TOM-638", agent: "codex" });
    expect(parseArgs(["term", "tom-638", "--agent=claude"], noDir)).toEqual({ op: "start", key: "TOM-638", agent: "claude" });
    expect(parseArgs(["term", "TOM-638"], noDir)).toEqual({ op: "start", key: "TOM-638", agent: null });
    // A folder of that name is a folder.
    expect(parseArgs(["term", "TOM-638"], () => true)).toEqual({ op: "open", dir: "TOM-638" });
    expect(parseArgs(["term", "--attach", "2"], noDir)).toEqual({ op: "attach", cell: 2 });
    expect(parseArgs(["term", "--attach=3"], noDir)).toEqual({ op: "attach", cell: 3 });
    expect(parseArgs(["term", "--attach"], noDir)).toEqual({ op: "attach", cell: null });
  });

  it("refuses what it cannot read, saying what", () => {
    expect(parseArgs(["tem"], noDir)).toEqual({ op: "bad", what: "tem" });
    expect(parseArgs(["term", "--agent"], noDir)).toEqual({ op: "bad", what: "--agent" });
    expect(parseArgs(["term", "--agent", "codex", "."], noDir)).toEqual({ op: "bad", what: "." });
    expect(parseArgs(["term", "--attach", "2", "x"], noDir)).toEqual({ op: "bad", what: "x" });
    expect(parseArgs(["term", "a", "b"], noDir)).toEqual({ op: "bad", what: "b" });
    expect(parseArgs(["term", "--frob"], noDir)).toEqual({ op: "bad", what: "--frob" });
  });
});

type Sent = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

/** A run of the command against answers it is given, recording what it sent, printed and started. */
function harness(answers: ((body: Record<string, unknown>) => Response | Error)[], over: Partial<CliDeps> = {}) {
  const sent: Sent[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const spawned: { command: string; args: string[]; env: NodeJS.ProcessEnv | undefined; stdio: unknown }[] = [];
  let at = 0;
  const deps: CliDeps = {
    config: () => ({ url: "http://127.0.0.1:19090", open: "/Applications/Tomrade.app", locale: "en" }),
    cwd: work,
    platform: "darwin",
    env: { PATH: "/usr/bin" },
    fetch: (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      sent.push({ url, body, headers: init.headers as Record<string, string> });
      const answer = answers[Math.min(at++, answers.length - 1)]!(body);
      if (answer instanceof Error) throw answer;
      return answer;
    }) as typeof fetch,
    spawn: ((command: string, args: string[], opts: { env?: NodeJS.ProcessEnv; stdio?: unknown }) => {
      spawned.push({ command, args, env: opts.env, stdio: opts.stdio });
      const child = Object.assign(new EventEmitter(), { unref() {} });
      setImmediate(() => child.emit("exit", 0));
      return child;
    }) as never,
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    sleep: async () => {},
    isDir: (dir) => dir === work || dir === otherDir,
    ...over
  };
  return { deps, sent, out, err, spawned };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });

describe("the tomrade command", () => {
  it("asks Tomrade over its port to open a pane in the folder, and prints the answer", async () => {
    const h = harness([() => json({ ok: true, text: "Opened pane 3 in the Terminal window · ~/work/other" })]);
    expect(await runCli(["term", "../other"], h.deps)).toBe(0);
    expect(h.sent).toEqual([{ url: "http://127.0.0.1:19090/cli/term", body: { op: "open", cwd: otherDir }, headers: { "Content-Type": "application/json", "X-Tomrade-Cli": "1" } }]);
    expect(h.out).toEqual(["Opened pane 3 in the Terminal window · ~/work/other"]);
    // A folder that is not there is said before anything is asked.
    const missing = harness([() => json({ ok: true, text: "" })]);
    expect(await runCli(["term", "nope"], missing.deps)).toBe(1);
    expect(missing.sent).toEqual([]);
    expect(missing.err).toEqual(["There is no folder nope"]);
  });

  it("starts a ticket with the agent named, and says so while Tomrade works on it", async () => {
    const h = harness([() => json({ ok: true, text: "Pane 4 · claimed TOM-638 · started Codex on tom-638/x" })]);
    expect(await runCli(["term", "--agent", "codex", "TOM-638"], h.deps)).toBe(0);
    expect(h.sent[0]!.body).toEqual({ op: "start", cwd: work, key: "TOM-638", agent: "codex" });
    expect(h.err).toEqual(["Starting TOM-638…"]);
    const no = harness([() => json({ ok: false, text: "No ticket TOM-9 in your projects on this computer" })]);
    expect(await runCli(["term", "TOM-9"], no.deps)).toBe(1);
    expect(no.err.at(-1)).toBe("No ticket TOM-9 in your projects on this computer");
  });

  it("starts Tomrade when nothing answers, waits for it, and asks again", async () => {
    let up = false;
    const h = harness([() => (up ? json({ ok: true, text: "opened" }) : refused()), () => refused(), () => json({ error: "not yet" }, 503), () => json({ ok: true, text: "opened" })], {
      spawn: ((command: string, args: string[]) => {
        h.spawned.push({ command, args, env: undefined, stdio: undefined });
        up = true;
        const child = new EventEmitter();
        setImmediate(() => child.emit("exit", 0));
        return child;
      }) as never
    });
    expect(await runCli(["term"], h.deps)).toBe(0);
    expect(h.spawned).toEqual([{ command: "open", args: ["-a", "/Applications/Tomrade.app"], env: undefined, stdio: undefined }]);
    expect(h.err).toEqual(["Starting Tomrade…"]);
    expect(h.out).toEqual(["opened"]);
    // A checkout names nothing to start: it says Tomrade is not running.
    const none = harness([() => refused()], { config: () => ({ url: "http://127.0.0.1:19091", open: "", locale: "zh" }) });
    expect(await runCli(["term"], none.deps)).toBe(1);
    expect(none.err).toEqual(["Tomrade 没在运行。打开它后再试一次。"]);
    // One that never comes up is given up on.
    const never = harness([() => refused()], { waitMs: 0 });
    expect(await runCli(["term"], never.deps)).toBe(1);
    expect(never.err.at(-1)).toBe("Tomrade did not answer. Open it, then try again.");
  });

  it("never sends a request again after one that reached Tomrade failed", async () => {
    const h = harness([() => Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } })]);
    expect(await runCli(["term", "--agent", "codex", "TOM-1"], h.deps)).toBe(1);
    expect(h.sent).toHaveLength(1);
    expect(h.spawned).toEqual([]);
  });

  it("attaches a pane with herdr's own client on Tomrade's socket, then hands it back to its cell", async () => {
    const h = harness([
      () => json({ ok: true, text: "Attaching pane 2 · TOM-634", attach: { herdr: "/opt/homebrew/bin/herdr", socket: "/Users/me/.config/herdr/herdr.sock", terminal: "term_abc" }, projectId: "p1", cell: "c7" }),
      () => json({ ok: true, text: "" })
    ]);
    expect(await runCli(["term", "--attach", "2"], h.deps)).toBe(0);
    expect(h.sent.map((s) => s.body)).toEqual([{ op: "attach", cwd: work, cell: 2 }, { op: "detached", projectId: "p1", cell: "c7" }]);
    expect(h.spawned).toEqual([{ command: "/opt/homebrew/bin/herdr", args: ["terminal", "attach", "term_abc", "--takeover"], env: { PATH: "/usr/bin", HERDR_SOCKET_PATH: "/Users/me/.config/herdr/herdr.sock" }, stdio: "inherit" }]);
    // Without a number, the panes are listed.
    const list = harness([() => json({ ok: true, text: "The panes of Tomrade's Terminal window:", cells: ["1  empty", "2  TOM-634 · Claude Code · x"] })]);
    expect(await runCli(["term", "--attach"], list.deps)).toBe(0);
    expect(list.sent[0]!.body).toEqual({ op: "attach", cwd: work });
    expect(list.out).toEqual(["The panes of Tomrade's Terminal window:\n  1  empty\n  2  TOM-634 · Claude Code · x"]);
  });

  it("prints its usage for help, and with what it did not understand", async () => {
    const h = harness([]);
    expect(await runCli(["--help"], h.deps)).toBe(0);
    expect(h.out[0]).toContain("tomrade term --attach <n>");
    const bad = harness([]);
    expect(await runCli(["term", "--frob"], bad.deps)).toBe(2);
    expect(bad.err[0]).toMatch(/^tomrade does not know --frob\n\nUsage:/);
  });
});
