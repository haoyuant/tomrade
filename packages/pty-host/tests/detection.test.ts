import fs from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { compileManifest, detect, ENGINE_VERSION, regionText, rustRegex, type AgentManifest, type DetectionInput } from "../src/detection.js";
import { HERDR_COMMIT, MANIFESTS } from "../src/manifests.js";

const vendored = path.join(__dirname, "../agent-detection");
const screens = path.join(__dirname, "fixtures/agent-screens");

/** A manifest of test rules under codex's name, as herdr's own engine tests write them. */
const rules = (list: AgentManifest["rules"]) => compileManifest({ id: "codex", rules: list });
const input = (screen: string, oscTitle = "", oscProgress = ""): DetectionInput => ({ screen, oscTitle, oscProgress });
const manifest = (file: string) => compileManifest(MANIFESTS[file]!);

describe("Rust regex patterns, as JavaScript reads them", () => {
  it("spells \\x{…} escapes, in and out of classes", () => {
    expect(rustRegex("^[\\x{2800}-\\x{28FF}\\x{25D0}-\\x{25D3}] ").test("⠂ Fixing the parser")).toBe(true);
    expect(rustRegex("^\\x{2733} ").test("✳ Claude Code")).toBe(true);
    expect(rustRegex("^⚠[\\u{fe0e}\\u{fe0f}]?(?:\\s|$)").test("⚠️ blocked")).toBe(true);
    expect(rustRegex("^\\s*[\\u2801-\\u28FF]+\\s+\\S").test("  ⠋ thinking")).toBe(true);
  });

  it("takes the flags leading a pattern as its flags", () => {
    expect(rustRegex("(?i)esc to close\\s*$").test("Esc To Close")).toBe(true);
    expect(rustRegex("(?m)^\\s*❯\\s*$").test("text\n ❯ \nmore")).toBe(true);
    expect(rustRegex("^\\s*❯\\s*$").test("text\n ❯ \nmore")).toBe(false);
    expect(rustRegex("(?s)^.*$").test("a\nb")).toBe(true);
    expect(rustRegex("(?is)A.B").test("a\nb")).toBe(true);
    expect(rustRegex("(?im)^b$").test("a\nB\nc")).toBe(true);
  });

  it("anchors \\A and \\z to the whole text, never a line", () => {
    expect(rustRegex("(?m)done\\z").test("done\n")).toBe(false);
    expect(rustRegex("(?m)done\\s*\\z").test("done\n")).toBe(true);
    expect(rustRegex("(?m)\\A> You").test("x\n> You")).toBe(false);
    expect(rustRegex("\\A> You are in [^\\r\\n]+(?:\\r?\\n|$)").test("> You are in /repo\nmore")).toBe(true);
  });

  it("reads \\d, \\w and \\b as Unicode, as Rust does", () => {
    expect(rustRegex("^\\d+$").test("٣٤")).toBe(true);
    expect(rustRegex("^\\w+$").test("Ärger")).toBe(true);
    expect(rustRegex("[-\\w.]+").exec("kimi-k2.5é")?.[0]).toBe("kimi-k2.5é");
    expect(rustRegex("(?i)\\byes\\b").test("yesé")).toBe(false);
    expect(rustRegex("(?i)\\byes\\b").test("1. Yes")).toBe(true);
    expect(rustRegex("\\p{Alphabetic}+\\w*ing\\b").test("Thinking…")).toBe(true);
  });

  it("drops escapes Rust allows on any punctuation and JavaScript does not", () => {
    expect(rustRegex("a\\-b\\#c\\~").test("a-b#c~")).toBe(true);
    expect(rustRegex("[\\-x]").test("-")).toBe(true);
    expect(rustRegex("(?P<n>ab)").exec("ab")?.groups?.n).toBe("ab");
  });

  it("tries a leading .* only where its run starts, finding the same matches", () => {
    const re = rustRegex("(?i).*opencode.*esc (again to )?interrupt");
    expect(re.source.startsWith("(?<!.)")).toBe(true);
    expect(re.test("  OpenCode · esc again to interrupt")).toBe(true);
    expect(re.test("opencode esc interrupt")).toBe(true);
    expect(re.test("esc interrupt opencode")).toBe(false);
    expect(rustRegex(".*b").test("a\nxb")).toBe(true);
    expect(rustRegex("(?s).*b\\z").test("a\nxb")).toBe(true);
    const line = "✻ Thinking… ".repeat(40);
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) re.test(line);
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it("refuses what has no spelling here", () => {
    expect(() => rustRegex("a(?i)b")).toThrow(/start of a pattern/);
    expect(() => rustRegex("(?x)a b")).toThrow(/flag x/);
    expect(() => rustRegex("[[:alpha:]]")).toThrow(/nested/);
    expect(() => rustRegex("[a-z--b]")).toThrow(/set operations/);
  });
});

/** herdr's own engine tests (src/detect/manifest/tests.rs), read by this engine. */
describe("herdr's manifest engine", () => {
  it("reads a known agent no rule matches as idle", () => {
    expect(detect(rules([{ id: "test", state: "working", contains: ["active-marker"] }]), input("unmatched-marker"))).toEqual({ state: "idle", rule: null, skip: false, visibleIdle: false, visibleBlocker: false, visibleWorking: false });
  });

  it("applies gates, priority and line_regex", () => {
    const m = rules([
      { id: "low_contains", state: "idle", priority: 1, contains: ["match"] },
      { id: "high_nested_gates", state: "working", priority: 10, contains: ["match"], all: [{ any: [{ regex: ["w[io]n"] }, { contains: ["fallback"] }] }], not: [{ contains: ["blocked"] }] },
      { id: "line_regex", state: "blocked", priority: 20, line_regex: ["^exact line$"] }
    ]);
    expect(detect(m, input("match win"))).toMatchObject({ state: "working", rule: "high_nested_gates" });
    expect(detect(m, input("match win blocked"))).toMatchObject({ state: "idle", rule: "low_contains" });
    expect(detect(m, input("before\nexact line\nafter"))).toMatchObject({ state: "blocked", rule: "line_regex" });
  });

  it("keeps the earlier of two rules of the same priority", () => {
    const m = rules([
      { id: "first", state: "working", priority: 5, contains: ["x"] },
      { id: "second", state: "blocked", priority: 5, contains: ["x"] }
    ]);
    expect(detect(m, input("x")).rule).toBe("first");
  });

  it("lets end-anchored footer gates allow only an auxiliary tail", () => {
    const m = rules([
      {
        id: "live_controls",
        state: "blocked",
        region: "whole_recent",
        regex: ["(?i)(?:^|\\n)controls:\\s+(?:confirm-marker|select-marker\\s+navigate-marker)\\s+cancel-marker[ \\t]*\\n---[^\\n]*(?:\\npanel: \\d+(?:\\nrow: [^\\n]+)+(?:\\n… \\+\\d+ pending)?)?(?:\\n[ \\t]*)*\\z"]
      }
    ]);
    const footer = "controls: select-marker navigate-marker cancel-marker";
    for (const tail of ["--- name", "--- name\npanel: 5\nrow: active\nrow: pending\nrow: pending\nrow: pending\nrow: done\n", "--- name\npanel: 5\nrow: active\nrow: done\n… +3 pending"]) {
      const live = `old output\n${footer}\n${tail}`;
      expect(detect(m, input(live)).state).toBe("blocked");
      for (const later of ["new output", "prompt:", "--- next\nprompt:", "prompt: continue…", "working: processing…", "…ordinary output", "finished…", "… +2 arbitrary words"]) {
        expect(detect(m, input(`${live}\n${later}`)).state).toBe("idle");
      }
    }
    for (const tail of ["--- name\n… +2 pending", "--- name\nrow: active", "--- name\npanel: 5", "--- name\npanel: 5\nrow: active\n  working: processing…", "--- name\npanel: 5\nrow: active\n  prompt: continue…"]) {
      expect(detect(m, input(`${footer}\n${tail}`)).state).toBe("idle");
    }
    for (const controls of ["controls: confirm-marker cancel-marker", "controls: select-marker\nnavigate-marker cancel-marker", "controls:\nselect-marker\nnavigate-marker\ncancel-marker"]) {
      expect(detect(m, input(`${controls}\n--- name`)).state).toBe("blocked");
    }
    for (const controls of ["controls: select-marker cancel-marker", "controls: navigate-marker cancel-marker", "controls: confirm-marker", "controls: select-marker unrelated navigate-marker cancel-marker", "controls: select-marker\nprompt: navigate-marker cancel-marker"]) {
      expect(detect(m, input(`confirm-marker navigate-marker\n${controls}\n--- name`)).state).toBe("idle");
    }
  });

  it("requires paired alternatives to hold whole at the bottom", () => {
    const m = rules([
      {
        id: "paired",
        state: "blocked",
        region: "bottom_non_empty_lines(3)",
        visible_blocker: true,
        any: [{ all: [{ contains: ["alpha heading"] }, { regex: ["alpha\\s+control\\s*\\z"] }] }, { all: [{ contains: ["beta heading"] }, { regex: ["beta\\s+control\\s*\\z"] }] }]
      }
    ]);
    for (const text of ["alpha heading\nalpha control", "beta heading\nbeta\ncontrol"]) expect(detect(m, input(text))).toMatchObject({ state: "blocked", visibleBlocker: true });
    for (const text of ["alpha heading\nbeta control", "beta heading\nalpha control", "beta control", "beta heading", "beta heading\nbeta control\nnewer content", "beta heading\nfiller one\nfiller two\nbeta control"]) {
      expect(detect(m, input(text))).toMatchObject({ rule: null, visibleBlocker: false });
    }
  });

  it("reads the title and the progress apart from the screen, under one priority", () => {
    const m = rules([
      { id: "screen", state: "idle", priority: 10, region: "whole_recent", visible_idle: true, contains: ["screen-marker"] },
      { id: "title", state: "working", priority: 20, region: "osc_title", visible_working: true, regex: ["^title-marker$"] },
      { id: "progress", state: "blocked", priority: 30, region: "osc_progress", visible_blocker: true, regex: ["^progress-marker$"] }
    ]);
    const cases: [DetectionInput, string, string][] = [
      [input("screen-marker"), "idle", "screen"],
      [input("screen-marker", "title-marker"), "working", "title"],
      [input("screen-marker", "title-marker", "progress-marker"), "blocked", "progress"],
      [input("screen-marker title-marker progress-marker"), "idle", "screen"]
    ];
    for (const [given, state, rule] of cases) {
      const d = detect(m, given);
      expect([d.state, d.rule]).toEqual([state, rule]);
      expect([d.visibleIdle, d.visibleWorking, d.visibleBlocker]).toEqual([state === "idle", state === "working", state === "blocked"]);
    }
    expect(detect(m, input("", "progress-marker", "title-marker")).rule).toBeNull();
  });

  it("has a skip rule leave the state without visible evidence", () => {
    const m = rules([
      { id: "activity", state: "working", priority: 10, visible_working: true, contains: ["activity-marker"] },
      { id: "overlay", state: "unknown", priority: 20, skip_state_update: true, contains: ["overlay-marker"] }
    ]);
    expect(detect(m, input("activity-marker overlay-marker"))).toEqual({ state: "unknown", rule: "overlay", skip: true, visibleIdle: false, visibleBlocker: false, visibleWorking: false });
  });

  it("cuts screen regions as herdr does", () => {
    const cases: [string, string, string][] = [
      ["old\n\nnew\n", "bottom_lines(2)", "\nnew\n"],
      ["before\n› input\nafter\n", "after_last_prompt_marker", "after\n"],
      ["before\n› input\nafter\n", "before_current_prompt_marker", "before\n"],
      ["before\n› input\nafter\n", "whole_recent_without_current_prompt_marker", ""],
      ["no marker\n", "whole_recent_without_current_prompt_marker", "no marker\n"],
      ["• old\n■ latest\n› input\n", "current_prompt_block_marker", "■ latest"],
      ["• old\n■ latest\n› input\n", "after_current_prompt_block_marker", "■ latest\n› input\n"],
      ["› old\n• new\n", "current_prompt_block_marker", ""],
      ["above\n\n───\nbody\n───\nfooter\n", "above_prompt_box", "above\n\n"],
      ["above\n\n───\nbody\n───\nfooter\n", "last_non_empty_above_prompt_box", "above"],
      ["above\n───\nbody\n───\nfooter\n", "prompt_box_body", "body\n"],
      ["above\n───\nbody\n───\nfooter\n", "after_last_horizontal_rule", "footer\n"],
      ["marker\nold\n\nmiddle\nmarker\nnew\n", "bottom_non_empty_lines(2)", "marker\nnew\n"],
      ["\nmarker\nold\n\nmiddle\nmarker\nnew\n", "top_non_empty_lines(2)", "\nmarker\nold\n"]
    ];
    for (const [screen, region, expected] of cases) expect([region, regionText(input(screen), region)]).toEqual([region, expected]);
  });

  it("refuses what herdr refuses", () => {
    expect(() => rules([{ id: "typo", state: "working", contain: ["Working"] } as never])).toThrow(/unknown field contain/);
    expect(() => compileManifest({ id: "codex", rules: [] })).toThrow(/no rules/);
    expect(() => rules([{ id: "r", state: "working", region: "bottom(3)", contains: ["x"] }])).toThrow(/unknown region/);
    expect(() => rules([{ id: "r", state: "working", regex: ["(unclosed"] }])).toThrow(/rule r/);
    expect(() => rules([{ id: "r", state: "idle", skip_state_update: true, contains: ["x"] }])).toThrow(/skip_state_update/);
    expect(() => rules([{ id: "r", state: "working", not: [{ contains: ["x"] }] }])).toThrow(/positive matcher/);
    expect(() => compileManifest({ id: "codex", min_engine_version: ENGINE_VERSION + 1, rules: [{ id: "r", contains: ["x"] }] })).toThrow(`needs engine ${ENGINE_VERSION + 1}`);
    expect(() => compileManifest({ id: "codex", min_engine_version: 2, rules: [{ id: "r", state: "working", region: " top_non_empty_lines(1) ", contains: ["x"] }] })).toThrow(/min_engine_version 3/);
    for (const n of ["0", "01", "+1", "65536"]) expect(() => rules([{ id: "r", state: "working", region: `top_non_empty_lines(${n})`, contains: ["x"] }])).toThrow(/unknown region/);
  });
});

describe("the vendored manifests", () => {
  it("are herdr's files as published, at the commit NOTICE names", () => {
    const files = fs.readdirSync(vendored).filter((f) => f.endsWith(".toml") && f !== "index.toml").sort();
    expect(Object.keys(MANIFESTS).sort()).toEqual(files);
    for (const file of files) expect([file, MANIFESTS[file]]).toEqual([file, parse(fs.readFileSync(path.join(vendored, file), "utf8"))]);
    const index = parse(fs.readFileSync(path.join(vendored, "index.toml"), "utf8")) as { agents: { path: string }[] };
    expect(index.agents.map((a) => a.path).sort()).toEqual(files);
    expect(fs.readFileSync(path.join(vendored, "NOTICE"), "utf8")).toContain(`at commit ${HERDR_COMMIT}`);
    expect(fs.readFileSync(path.join(vendored, "LICENSE"), "utf8")).toContain("Apache License");
  });

  it("all compile, every pattern included", () => {
    for (const [file, m] of Object.entries(MANIFESTS)) expect(() => compileManifest(m), file).not.toThrow();
  });
});

/**
 * Screens of Claude Code and Codex (fixtures/agent-screens) and how herdr 0.9.5 reads them with these same manifests
 * (2026.10.11.1): `herdr agent explain --file <screen> --agent <claude|codex> --json` gave every state and rule here.
 * After refreshing the manifests, check a changed expectation against herdr the same way.
 */
describe("Claude Code and Codex screens, as herdr reads them", () => {
  const read: [string, string, string | null, string][] = [
    ["claude-idle.txt", "idle", "live_prompt_box", "visibleIdle"],
    ["claude-idle-typing.txt", "idle", "live_prompt_box", "visibleIdle"],
    ["claude-history-prompt.txt", "idle", "live_prompt_box", "visibleIdle"],
    ["claude-working.txt", "working", "live_turn_working", "visibleWorking"],
    ["claude-working-footer.txt", "working", "live_turn_working", "visibleWorking"],
    ["claude-blocked-bash.txt", "blocked", "bash_permission_prompt", "visibleBlocker"],
    ["claude-blocked-edit.txt", "blocked", "legacy_no_prompt_blocker", ""],
    ["claude-blocked-question.txt", "blocked", "live_blocked_form", "visibleBlocker"],
    ["claude-transcript.txt", "unknown", "transcript_viewer", "skip"],
    ["codex-idle.txt", "idle", null, ""],
    ["codex-idle-after-turn.txt", "idle", null, ""],
    ["codex-working.txt", "working", "screen_working_fallback", "visibleWorking"],
    ["codex-working-long.txt", "working", "screen_working_fallback", "visibleWorking"],
    ["codex-blocked-command.txt", "blocked", "live_strong_blocker", "visibleBlocker"],
    ["codex-blocked-allow.txt", "blocked", "live_strong_blocker", "visibleBlocker"],
    ["codex-blocked-trust.txt", "blocked", "trust_directory", "visibleBlocker"]
  ];

  it.each(read)("%s reads %s (%s)", (file, state, rule, flag) => {
    const d = detect(manifest(`${file.split("-")[0]}.toml`), input(fs.readFileSync(path.join(screens, file), "utf8")));
    expect([d.state, d.rule]).toEqual([state, rule]);
    for (const key of ["skip", "visibleIdle", "visibleBlocker", "visibleWorking"] as const) expect([key, d[key]]).toEqual([key, key === flag]);
  });

  it("reads Claude's title: its spinner working whatever the screen shows, its resting mark idle", () => {
    const claude = manifest("claude.toml");
    const idle = fs.readFileSync(path.join(screens, "claude-idle.txt"), "utf8");
    expect(detect(claude, input(idle, "⠂ Fixing the parser"))).toMatchObject({ state: "working", rule: "osc_title_working" });
    expect(detect(claude, input(idle, "◐ Fixing the parser"))).toMatchObject({ state: "working", rule: "osc_title_working" });
    expect(detect(claude, input("", "✳ Claude Code"))).toMatchObject({ state: "idle", rule: "osc_title_idle", visibleIdle: true });
    expect(detect(claude, input("", "", "4;0;"))).toMatchObject({ state: "idle", rule: "osc_progress_idle" });
    // A permission prompt outranks the idle title Claude keeps while it asks.
    expect(detect(claude, input(fs.readFileSync(path.join(screens, "claude-blocked-bash.txt"), "utf8"), "✳ Claude Code"))).toMatchObject({ state: "blocked" });
  });

  it("reads Codex's title: its spinner working, Action Required blocked, any other title idle", () => {
    const codex = manifest("codex.toml");
    expect(detect(codex, input("", "⠙ demo"))).toMatchObject({ state: "working", rule: "osc_title_working" });
    expect(detect(codex, input("", "Action Required · demo"))).toMatchObject({ state: "blocked", rule: "osc_title_blocked" });
    expect(detect(codex, input("", "demo"))).toMatchObject({ state: "idle", rule: "osc_title_idle", visibleIdle: true });
  });
});
