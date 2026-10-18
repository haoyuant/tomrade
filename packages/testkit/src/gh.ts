import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** How the fake answers a command: what it prints, a failure of its own, or one of the ways the real gh fails. */
export type FakeGhReply = { stdout: string } | { stderr: string; code?: number } | "signed-out" | "rate-limited" | "offline";

/** What gh 2.x prints and exits with when it fails these ways; 4 is its "authentication required". */
const FAILURES = {
  "signed-out": { stderr: "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.", code: 4 },
  "rate-limited": { stderr: "GraphQL: API rate limit exceeded for user ID 1. (https://docs.github.com/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api)", code: 1 },
  offline: { stderr: "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com", code: 1 }
};

const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * A `gh` that never reaches GitHub, for code that runs the CLI by name: an
 * executable in a folder of its own, which the test puts first on PATH. It
 * answers `--version`, replies to each command as told — signed out until told
 * otherwise, as on a machine nobody logged in on — and records every call.
 */
export class FakeGh {
  readonly dir: string;
  private readonly log: string;
  private readonly replies = new Map<string, FakeGhReply>();

  constructor(dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-"))) {
    fs.mkdirSync(dir, { recursive: true });
    this.dir = dir;
    this.log = path.join(dir, "calls");
    this.reset();
  }

  /** How later calls of a command — "pr create", "pr view", "api" — are answered. */
  answer(command: string, reply: FakeGhReply): void {
    this.replies.set(command, reply);
    this.write();
  }

  /** Back to signed out, with no calls recorded. */
  reset(): void {
    this.replies.clear();
    fs.writeFileSync(this.log, "");
    this.write();
  }

  /** Every call so far, as its arguments, oldest first. */
  get calls(): string[][] {
    return fs.readFileSync(this.log, "utf8").split("\x1e").filter(Boolean).map((call) => call.split("\x1f").slice(0, -1));
  }

  private write(): void {
    const reply = (r: FakeGhReply): string => {
      if (typeof r === "object" && "stdout" in r) return `printf '%s\\n' ${quote(r.stdout)}; exit 0`;
      const { stderr, code } = typeof r === "string" ? FAILURES[r] : r;
      return `printf '%s\\n' ${quote(stderr)} >&2; exit ${code ?? 1}`;
    };
    const script = [
      "#!/bin/sh",
      `printf '%s\\037' "$@" >> ${quote(this.log)}`,
      `printf '\\036' >> ${quote(this.log)}`,
      'case "$*" in',
      "  --version) echo 'gh version 2.0.0 (fake)'; exit 0 ;;",
      ...[...this.replies].map(([command, r]) => `  ${quote(command)}*) ${reply(r)} ;;`),
      "esac",
      reply("signed-out"),
      ""
    ].join("\n");
    // Renamed into place, so a gh starting meanwhile reads one script whole.
    const next = path.join(this.dir, "gh.next");
    fs.writeFileSync(next, script, { mode: 0o755 });
    fs.renameSync(next, path.join(this.dir, "gh"));
  }
}
