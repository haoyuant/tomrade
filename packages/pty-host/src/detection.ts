/*
 * herdr's agent detection manifests (herdrdev/herdr, Apache-2.0, copied into
 * agent-detection/) read in TypeScript, as herdr's engine reads them: each
 * agent's rules say which part of its pane's live screen (or its title) to
 * look at, what to look for there, and what that means. The highest-priority
 * rule that matches wins; a known agent that no rule matches is idle. Their
 * patterns are Rust `regex` syntax, spelled here as JavaScript reads it.
 */

/** The manifest engine this reads (`min_engine_version`): 3 has `top_non_empty_lines`. */
export const ENGINE_VERSION = 3;

type ScreenState = "idle" | "working" | "blocked" | "unknown";

/** Matchers that all have to hold: `contains` (any case), `regex` on the region, `line_regex` on one of its lines. */
interface ManifestGate {
  all?: ManifestGate[];
  any?: ManifestGate[];
  not?: ManifestGate[];
  contains?: string[];
  regex?: string[];
  line_regex?: string[];
}

interface ManifestRule extends ManifestGate {
  id: string;
  state?: ScreenState;
  priority?: number;
  region?: string;
  visible_idle?: boolean;
  visible_blocker?: boolean;
  visible_working?: boolean;
  /** A screen that says nothing of the state (a transcript viewer): the state stays what it was. */
  skip_state_update?: boolean;
}

export interface AgentManifest {
  id: string;
  version?: string;
  min_engine_version?: number;
  updated_at?: string;
  aliases?: string[];
  rules: ManifestRule[];
}

/** What a rule can look at: the pane's live bottom (as `detectionText` reads it), its title and its last OSC 9 progress. */
export interface DetectionInput {
  screen: string;
  oscTitle: string;
  oscProgress: string;
}

export interface Detection {
  state: ScreenState;
  /** The rule that decided it; null when none matched and the agent is idle by default. */
  rule: string | null;
  skip: boolean;
  visibleIdle: boolean;
  visibleBlocker: boolean;
  visibleWorking: boolean;
}

interface Gate {
  all: Gate[];
  any: Gate[];
  not: Gate[];
  contains: string[];
  regex: RegExp[];
  lineRegex: RegExp[];
}

interface Rule {
  id: string;
  state: ScreenState;
  priority: number;
  region: string;
  skip: boolean;
  visibleIdle: boolean;
  visibleBlocker: boolean;
  visibleWorking: boolean;
  gate: Gate;
}

export interface CompiledManifest {
  id: string;
  aliases: string[];
  version: string | null;
  /** Highest priority first, herdr's order among equals: the first that matches is the one herdr picks. */
  rules: Rule[];
}

/** Unicode's word characters, which Rust's `\w` and `\b` mean (JavaScript's are ASCII). */
const WORD = "\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}";
const BOUNDARY = `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;
const NOT_BOUNDARY = `(?:(?<=[${WORD}])(?=[${WORD}])|(?<![${WORD}])(?![${WORD}]))`;
/** What JavaScript's Unicode mode lets be escaped; Rust lets any punctuation be. */
const SYNTAX = new Set("^$\\.*+?()[]{}|/");

/**
 * A Rust `regex` pattern as a JavaScript RegExp in Unicode mode: flags leading the pattern (`(?i)`, `(?ms)`) become its
 * flags; `\x{…}`, `\A`, `\z` and Unicode's `\d`, `\w`, `\b` are spelled as JavaScript reads them. What has no
 * spelling here (flags mid-pattern, nested classes, class set operations) is refused.
 */
export function rustRegex(pattern: string): RegExp {
  let flags = "u";
  let i = 0;
  for (let lead: RegExpExecArray | null; (lead = /^\(\?([a-zA-Z]+)\)/.exec(pattern.slice(i))); i += lead[0].length) {
    for (const f of lead[1]!) {
      if (f !== "i" && f !== "m" && f !== "s") throw new Error(`flag ${f} is not supported`);
      if (!flags.includes(f)) flags += f;
    }
  }
  // A leading `.*` is tried from every column by a backtracking engine (Rust's runs in linear time): a match can always
  // start where its run of `.` characters starts, so only such places are tried.
  let out = pattern.startsWith(".*", i) ? "(?<!.)" : "";
  let inClass = false;
  for (; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") {
      const n = pattern[++i];
      if (n === undefined) throw new Error("a pattern ends in a backslash");
      const braced = pattern[i + 1] === "{";
      if ((n === "x" || n === "u" || n === "U") && braced) {
        const end = pattern.indexOf("}", i);
        if (end < 0) throw new Error("an unclosed \\x{");
        out += `\\u{${pattern.slice(i + 2, end)}}`;
        i = end;
      } else if (n === "x") {
        out += `\\x${pattern.slice(i + 1, i + 3)}`;
        i += 2;
      } else if (n === "u") {
        out += `\\u${pattern.slice(i + 1, i + 5)}`;
        i += 4;
      } else if (n === "U") {
        out += `\\u{${pattern.slice(i + 1, i + 9)}}`;
        i += 8;
      } else if (n === "p" || n === "P") {
        const end = braced ? pattern.indexOf("}", i) : i + 1;
        if (end < 0) throw new Error("an unclosed \\p{");
        out += `\\${n}{${braced ? pattern.slice(i + 2, end) : pattern[end]}}`;
        i = end;
      } else if (n === "d") out += "\\p{Nd}";
      else if (n === "w") out += inClass ? WORD : `[${WORD}]`;
      else if (n === "a") out += "\\x07";
      else if (inClass && "DWbBAz".includes(n)) throw new Error(`\\${n} in a class is not supported`);
      else if (n === "D") out += "\\P{Nd}";
      else if (n === "W") out += `[^${WORD}]`;
      else if (n === "b") out += BOUNDARY;
      else if (n === "B") out += NOT_BOUNDARY;
      else if (n === "A") out += "(?<![\\s\\S])";
      else if (n === "z") out += "(?![\\s\\S])";
      else if (/[A-Za-z0-9]/.test(n) || SYNTAX.has(n) || (inClass && n === "-")) out += `\\${n}`;
      else out += n;
      continue;
    }
    if (inClass) {
      if (c === "[") throw new Error("nested classes are not supported");
      if ((c === "&" || c === "-" || c === "~") && pattern[i + 1] === c) throw new Error("class set operations are not supported");
      if (c === "]") inClass = false;
      out += c;
      continue;
    }
    if (c === "[") {
      inClass = true;
      out += c;
      if (pattern[i + 1] === "^") out += pattern[++i];
      // A `]` first in a class is one in Rust (JavaScript reads an empty class).
      if (pattern[i + 1] === "]") {
        out += "\\]";
        i++;
      }
      continue;
    }
    if (c === "(" && pattern[i + 1] === "?") {
      const kind = pattern[i + 2];
      if (kind === "P" && pattern[i + 3] === "<") {
        out += "(?<";
        i += 3;
        continue;
      }
      if (kind !== ":" && kind !== "<") throw new Error("flags are supported at the start of a pattern only");
    }
    out += c;
  }
  return new RegExp(out, flags);
}

/** Rust's `str::lines`: split at `\n` (dropping a `\r` before it), with no line after a last newline. */
function linesOf(content: string): string[] {
  if (!content) return [];
  const parts = content.split("\n");
  const ended = parts.at(-1) === "";
  if (ended) parts.pop();
  return parts.map((line, i) => (line.endsWith("\r") && (ended || i < parts.length - 1) ? line.slice(0, -1) : line));
}

/** Where line `index` starts, counted as herdr counts it (each line and its newline). */
function lineStart(content: string, lines: string[], index: number): number {
  let at = 0;
  for (let i = 0; i < Math.min(index, lines.length); i++) at += lines[i]!.length + 1;
  return Math.min(at, content.length);
}

/** The last index whose line passes, or -1 (ES2022 has no findLastIndex). */
function lastIndex(lines: string[], test: (line: string) => boolean, before = lines.length): number {
  for (let i = Math.min(before, lines.length) - 1; i >= 0; i--) if (test(lines[i]!)) return i;
  return -1;
}

const fromLine = (content: string, lines: string[], index: number) => content.slice(lineStart(content, lines, index));
const nonEmpty = (line: string) => line.trim() !== "";

function isHorizontalRule(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  let rule = 0;
  while (trimmed[rule] === "─") rule++;
  if (!rule) return false;
  return !trimmed.slice(rule).trimStart() || rule >= 3;
}

const codexPrompt = (line: string) => line === "›" || line.startsWith("› ");
const codexBlockMarker = (line: string) => /^[•■✗✓]/.test(line);

function currentCodexPrompt(lines: string[]): number | null {
  const at = lastIndex(lines, codexPrompt);
  if (at < 0 || lines.slice(at + 1).some(codexBlockMarker)) return null;
  return at;
}

function promptBoxTop(lines: string[]): number | null {
  let borders = 0;
  for (let i = lines.length - 1; i >= 0; i--) if (isHorizontalRule(lines[i]!) && ++borders === 2) return i;
  return null;
}

function abovePromptBox(content: string, lines: string[]): string {
  const top = promptBoxTop(lines);
  return top === null ? content : content.slice(0, lineStart(content, lines, top));
}

/** `bottom_lines(3)` → 3; null when the spec is not that region. */
function count(spec: string, name: string): number | null {
  const m = new RegExp(`^${name}\\((\\+?\\d+)\\)$`).exec(spec);
  return m ? Number(m[1]) : null;
}

function topCount(spec: string): number | null {
  const m = /^top_non_empty_lines\(([1-9]\d*)\)$/.exec(spec);
  return m && Number(m[1]) <= 0xffff ? Number(m[1]) : null;
}

const NAMED_REGIONS = new Set([
  "whole_recent",
  "after_last_prompt_marker",
  "before_current_prompt_marker",
  "whole_recent_without_current_prompt_marker",
  "current_prompt_block_marker",
  "after_current_prompt_block_marker",
  "prompt_box_body",
  "above_prompt_box",
  "last_non_empty_above_prompt_box",
  "after_last_horizontal_rule",
  "osc_title",
  "osc_progress"
]);

const knownRegion = (spec: string) => NAMED_REGIONS.has(spec) || count(spec, "bottom_lines") !== null || count(spec, "bottom_non_empty_lines") !== null || topCount(spec) !== null;

/** The text a rule's region names, cut from the input as herdr cuts it. */
export function regionText(input: DetectionInput, region: string): string {
  const spec = region.trim();
  if (spec === "osc_title") return input.oscTitle;
  if (spec === "osc_progress") return input.oscProgress;
  const content = input.screen;
  const lines = linesOf(content);
  switch (spec) {
    case "whole_recent":
      return content;
    case "after_last_prompt_marker": {
      const at = lastIndex(lines, codexPrompt);
      return at < 0 ? content : fromLine(content, lines, at + 1);
    }
    case "before_current_prompt_marker": {
      const at = currentCodexPrompt(lines);
      return at === null ? content : content.slice(0, lineStart(content, lines, at));
    }
    case "whole_recent_without_current_prompt_marker":
      return currentCodexPrompt(lines) === null ? content : "";
    case "current_prompt_block_marker": {
      const at = currentCodexPrompt(lines);
      const block = at === null ? -1 : lastIndex(lines, codexBlockMarker, at);
      return block < 0 ? "" : lines[block]!;
    }
    case "after_current_prompt_block_marker": {
      const at = currentCodexPrompt(lines);
      const block = at === null ? -1 : lastIndex(lines, codexBlockMarker, at);
      return block < 0 ? "" : fromLine(content, lines, block);
    }
    case "prompt_box_body": {
      const top = promptBoxTop(lines);
      if (top === null) return "";
      const below = lines.slice(top + 1).findIndex(isHorizontalRule);
      return content.slice(lineStart(content, lines, top + 1), lineStart(content, lines, below < 0 ? lines.length : top + 1 + below));
    }
    case "above_prompt_box":
      return abovePromptBox(content, lines);
    case "last_non_empty_above_prompt_box":
      const above = linesOf(abovePromptBox(content, lines));
      const at = lastIndex(above, nonEmpty);
      return at < 0 ? "" : above[at]!;
    case "after_last_horizontal_rule": {
      let end = 0;
      let at = 0;
      for (const line of lines) {
        at += line.length + 1;
        if (isHorizontalRule(line)) end = Math.min(at, content.length);
      }
      return content.slice(end);
    }
  }
  const bottom = count(spec, "bottom_lines");
  if (bottom !== null) return fromLine(content, lines, Math.max(0, lines.length - bottom));
  const bottomNonEmpty = count(spec, "bottom_non_empty_lines");
  if (bottomNonEmpty !== null) {
    let start = -1;
    for (let i = lines.length - 1, seen = 0; i >= 0 && seen < bottomNonEmpty; i--) {
      if (nonEmpty(lines[i]!)) {
        start = i;
        seen++;
      }
    }
    return start < 0 ? "" : fromLine(content, lines, start);
  }
  const top = topCount(spec);
  if (top !== null) {
    let end = -1;
    for (let i = 0, seen = 0; i < lines.length && seen < top; i++) {
      if (nonEmpty(lines[i]!)) {
        end = i;
        seen++;
      }
    }
    return end < 0 ? "" : content.slice(0, lineStart(content, lines, end + 1));
  }
  return "";
}

const GATE_KEYS = ["all", "any", "not", "contains", "regex", "line_regex"];
const GATE_SET = new Set(GATE_KEYS);
const RULE_KEYS = new Set([...GATE_KEYS, "id", "state", "priority", "region", "visible_idle", "visible_blocker", "visible_working", "skip_state_update"]);
const MANIFEST_KEYS = new Set(["id", "version", "min_engine_version", "updated_at", "aliases", "rules"]);
const STATES = new Set(["idle", "working", "blocked", "unknown"]);

/** A key herdr does not know, which herdr refuses (a misspelt matcher would otherwise match everything). */
function unknownKey(value: object, known: Set<string>): string | undefined {
  return Object.keys(value).find((key) => !known.has(key));
}

const positive = (g: ManifestGate) => !!(g.contains?.length || g.regex?.length || g.line_regex?.length || g.all?.length || g.any?.length);

function compileGate(g: ManifestGate, negated: boolean): Gate {
  const unknown = unknownKey(g, GATE_SET);
  if (unknown) throw new Error(`unknown field ${unknown}`);
  if (negated ? !positive(g) && !g.not?.length : !positive(g)) throw new Error(negated ? "an empty not gate" : "a gate with no positive matcher");
  return {
    all: (g.all ?? []).map((x) => compileGate(x, false)),
    any: (g.any ?? []).map((x) => compileGate(x, false)),
    not: (g.not ?? []).map((x) => compileGate(x, true)),
    contains: (g.contains ?? []).map((needle) => needle.toLowerCase()),
    regex: (g.regex ?? []).map(rustRegex),
    lineRegex: (g.line_regex ?? []).map(rustRegex)
  };
}

/** A manifest ready to read screens with; throws on one this engine cannot read, naming the rule. */
export function compileManifest(manifest: AgentManifest): CompiledManifest {
  if ((manifest.min_engine_version ?? 0) > ENGINE_VERSION) throw new Error(`${manifest.id} needs engine ${manifest.min_engine_version}, this is ${ENGINE_VERSION}`);
  const unknown = unknownKey(manifest, MANIFEST_KEYS);
  if (unknown) throw new Error(`${manifest.id}: unknown field ${unknown}`);
  if (!manifest.rules?.length) throw new Error(`${manifest.id} has no rules`);
  const rules = manifest.rules.map((r): Rule => {
    try {
      const unknown = unknownKey(r, RULE_KEYS);
      if (unknown) throw new Error(`unknown field ${unknown}`);
      if (!r.id?.trim()) throw new Error("a rule with no id");
      const region = (r.region ?? "whole_recent").trim();
      if (!knownRegion(region)) throw new Error(`unknown region ${region}`);
      if (topCount(region) !== null && (manifest.min_engine_version ?? ENGINE_VERSION) < 3) throw new Error("top_non_empty_lines needs min_engine_version 3");
      const state = r.state ?? "unknown";
      if (!STATES.has(state)) throw new Error(`unknown state ${state}`);
      if (r.skip_state_update && (state !== "unknown" || r.visible_idle || r.visible_blocker || r.visible_working)) throw new Error("skip_state_update with a state");
      const gate = compileGate({ all: r.all, any: r.any, not: r.not, contains: r.contains, regex: r.regex, line_regex: r.line_regex }, false);
      return { id: r.id, state, priority: r.priority ?? 0, region, skip: !!r.skip_state_update, visibleIdle: !!r.visible_idle, visibleBlocker: !!r.visible_blocker, visibleWorking: !!r.visible_working, gate };
    } catch (err) {
      throw new Error(`${manifest.id} rule ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  // Stable: among equal priorities the earlier rule stays first, as herdr keeps it.
  rules.sort((a, b) => b.priority - a.priority);
  return { id: manifest.id, aliases: manifest.aliases ?? [], version: manifest.version ?? null, rules };
}

/** A region's text with what its matchers want of it, each made once. */
class Region {
  private lowerText: string | null = null;
  private lineList: string[] | null = null;
  constructor(readonly text: string) {}
  get lower(): string {
    return (this.lowerText ??= this.text.toLowerCase());
  }
  get lines(): string[] {
    return (this.lineList ??= linesOf(this.text));
  }
}

function matches(g: Gate, r: Region): boolean {
  if (g.contains.length) {
    const lower = r.lower;
    if (!g.contains.every((needle) => lower.includes(needle))) return false;
  }
  if (!g.regex.every((re) => re.test(r.text))) return false;
  if (!g.lineRegex.every((re) => r.lines.some((line) => re.test(line)))) return false;
  if (!g.all.every((x) => matches(x, r))) return false;
  if (g.any.length && !g.any.some((x) => matches(x, r))) return false;
  return !g.not.some((x) => matches(x, r));
}

/** How a known agent's pane reads: the first rule (by priority) that matches, else idle. */
export function detect(manifest: CompiledManifest, input: DetectionInput): Detection {
  const regions = new Map<string, Region>();
  for (const rule of manifest.rules) {
    let region = regions.get(rule.region);
    if (!region) regions.set(rule.region, (region = new Region(regionText(input, rule.region))));
    if (!matches(rule.gate, region)) continue;
    const state = rule.state;
    return { state, rule: rule.id, skip: rule.skip, visibleIdle: rule.visibleIdle && state === "idle", visibleBlocker: rule.visibleBlocker && state === "blocked", visibleWorking: rule.visibleWorking && state === "working" };
  }
  return { state: "idle", rule: null, skip: false, visibleIdle: false, visibleBlocker: false, visibleWorking: false };
}
