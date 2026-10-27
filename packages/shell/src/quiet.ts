import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * What runs without asking under "checks": reading, and the project's own checks. Anything that could write,
 * reach the network or run code of its choosing is not here, and waits for the person as before.
 */
const READERS = new Set(["ls", "cat", "head", "tail", "wc", "grep", "rg", "pwd", "tree", "file", "stat", "du", "which", "diff"]);
const GIT_READS = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "grep", "branch", "shortlog", "describe"]);
/** The only words after `git branch` that keep it a listing; anything else may create, move or delete one. */
const BRANCH_LISTING = /^(?:-a|-r|-v|-vv|--all|--remotes|--list|--show-current|--no-color)$/;
/** A reading subcommand that writes anyway: to a file it names, or through an external diff tool. */
const GIT_WRITING_FLAGS = /^(?:--output(?:=.*)?|-o|--ext-diff|-O.*|--open-files-in-pager(?:=.*)?)$/;
/** A reader's own flags that run a program or write a file: ripgrep's preprocessor, tree's output file, file's magic compiler. */
const READER_ACTIONS: Record<string, RegExp> = { rg: /^--pre(?:-glob)?(?:=.*)?$/, tree: /^(?:-o|--output(?:=.*)?)$/, file: /^(?:-C|--compile)$/ };
const FIND_ACTIONS = /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;
const CHECK_SCRIPT = /^(?:test|lint|typecheck|check)(?::[\w-]+)?$/;
const RUNNERS = new Set(["pnpm", "npm", "yarn"]);

/**
 * The command's words, when it is one plain command: no pipe, redirection, chaining, substitution, expansion,
 * escape or newline anywhere — quotes only group words. null otherwise, and then it is asked about.
 */
export function plainWords(command: string): string[] | null {
  if (/[|&;<>`$\\\n\r(){}]/.test(command)) return null;
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(current);
  return words.length ? words : null;
}

/** A word that could name a place outside the folder: an absolute or home path, or one that climbs out. */
const leavesFolder = (word: string) => /^[/~]/.test(word) || /(?:^|[/=])\.\.(?:[/]|$)/.test(word);

/** Whether a command only reads inside its folder, or runs one of the project's own check scripts (`scripts` from its package.json). */
export function isQuietCommand(command: string, scripts: ReadonlySet<string>): boolean {
  const words = plainWords(command);
  if (!words || words.some(leavesFolder)) return false;
  const [head, ...rest] = words;
  if (READERS.has(head!)) return !rest.some((w) => READER_ACTIONS[head!]?.test(w));
  if (head === "find") return !rest.some((w) => FIND_ACTIONS.test(w));
  if (head === "git") {
    const at = rest.findIndex((w) => !w.startsWith("-"));
    const sub = rest[at];
    // git's own options before the subcommand (-C, -c, --git-dir…) could point it anywhere or change what it runs
    if (!sub || !GIT_READS.has(sub) || rest.slice(0, at).some((w) => w !== "--no-pager")) return false;
    const args = rest.slice(at + 1);
    if (sub === "branch") return args.every((w) => BRANCH_LISTING.test(w));
    return !args.some((w) => GIT_WRITING_FLAGS.test(w));
  }
  if (RUNNERS.has(head!)) {
    const script = rest[0] === "run" ? rest[1] : rest[0];
    return !!script && CHECK_SCRIPT.test(script) && scripts.has(script);
  }
  return false;
}

/** The scripts the folder's package.json names; none when it has none. */
export function scriptsOf(cwd: string): Set<string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    return new Set(Object.keys(pkg.scripts ?? {}));
  } catch {
    return new Set();
  }
}

const git = async (cwd: string, args: string[]): Promise<string | null> => {
  try {
    return (await run("git", args, { cwd, timeout: 3000 })).stdout.trim();
  } catch {
    return null;
  }
};

/**
 * Whether the folder is a ticket's own copy: a linked worktree, not a repository's main checkout, whose
 * top is the folder itself and whose branch is the one the ticket's conversation works on.
 */
export async function isTicketCopy(cwd: string, branch: string): Promise<boolean> {
  const [top, dir, common, current] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel"]),
    git(cwd, ["rev-parse", "--absolute-git-dir"]),
    git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(cwd, ["branch", "--show-current"])
  ]);
  if (!top || !dir || !common || !current) return false;
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(top) === real(cwd) && real(dir) !== real(common) && current === branch;
}
