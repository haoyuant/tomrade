/** Which two versions a ticket's diff compares; `since` is what changed after the person last reviewed it, `run` what one run of an agent changed. */
export type ChangeScope = { kind: "branch" } | { kind: "uncommitted" } | { kind: "commit"; sha: string } | { kind: "since" } | { kind: "run"; id: string };
export type ChangeScopeKind = ChangeScope["kind"];

export interface ChangeLine {
  kind: "context" | "add" | "del";
  /** One-based line number on each side; null on the side the line is not on. */
  old: number | null;
  new: number | null;
  /** The line without its diff marker or line ending. */
  text: string;
  /** The file ends here without a newline. */
  noEol?: boolean;
}

export interface ChangeHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** What git prints after the second `@@`: the enclosing function, when it found one. */
  header: string;
  lines: ChangeLine[];
}

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  path: string;
  /** Where a renamed file was. */
  oldPath: string | null;
  status: ChangeStatus;
  /** Null for a binary file, and for an untracked file too large to read with the rest. */
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  /** A lockfile, a build output or a file `.gitattributes` marks linguist-generated: folded until asked for. */
  generated: boolean;
  /** Its hunks were left out or cut short for size; `codeLink.changeFile` reads them. */
  truncated: boolean;
  /** Null when not read: binary, or left for `codeLink.changeFile`. */
  hunks: ChangeHunk[] | null;
  /**
   * A binary file's two sides as pictures, which `codeLink.changeFile` alone reads: data URLs of a PNG, JPEG, GIF or
   * WebP, a side null where the file is not there. Null when neither side is such a picture.
   */
  image?: { before: string | null; after: string | null } | null;
}

export interface ChangeCommit {
  sha: string;
  subject: string;
  author: string;
  /** Milliseconds. */
  at: number;
}

/** What a person had in front of them when they last reviewed a code link, on this machine. */
export interface ChangeReviewed {
  /** A commit holding that state: the branch's tip, or a snapshot of the working tree kept under `refs/tomrade/reviewed/`. */
  sha: string;
  /** Milliseconds. */
  at: number;
}

export interface ChangeLinkChoice {
  id: string;
  branch: string;
  repoName: string;
}

export interface ChangesOptions {
  /** One of the ticket's code links; its primary one when omitted. */
  linkId?: string;
  /** `branch` when omitted. */
  scope?: ChangeScope;
  ignoreWhitespace?: boolean;
}

/** Which file `codeLink.changeFile` reads, and how much of it. */
export interface ChangeFileOptions {
  path: string;
  /** The unchanged lines too, so the file comes back as one hunk: what unfolding between hunks shows. */
  full?: boolean;
}

/** One run of an agent in a code link's folder on this machine: the folder as a commit at each end, kept under `refs/tomrade/runs/`. */
export interface ChangeRun {
  id: string;
  /** The engine that ran, or the outside session's agent. */
  source: string;
  /** Milliseconds. */
  startedAt: number;
  /** Null while it runs, and for a run whose end was never heard. */
  endedAt: number | null;
  /** Null where the folder was not kept at that end, or a file too large to keep changed meanwhile: the run then has no diff to show. */
  before: string | null;
  after: string | null;
}

/** What a ticket changed, for one code link and one scope. */
export interface ChangesView {
  linkId: string;
  /** Every current code link of the ticket that has a branch; more than one means a picker. */
  links: ChangeLinkChoice[];
  /** The scopes this machine can show for the link: `uncommitted` only with a worktree here, `since` only after a review, `run` only with a run kept. */
  scopes: ChangeScopeKind[];
  /** The link's last review, while git still has its commit; null before the first. */
  reviewed: ChangeReviewed | null;
  /** The branch's own commits, newest first. */
  commits: ChangeCommit[];
  scope: ChangeScope;
  /** The commits compared; null where a side is the working tree. */
  base: string | null;
  head: string | null;
  /** The folder the files are in on this machine, for opening one in an editor; null when there is none. */
  root: string | null;
  /** The link's runs on this machine that changed something or are not over, newest first. */
  runs: ChangeRun[];
  /** The scope is a run without both of its ends: nothing can be compared, and `files` is empty. */
  unavailable?: boolean;
  /** What was last submitted for the ticket's current delivery; null before a submission. */
  report: string | null;
  files: ChangedFile[];
}

/** How much a ticket's branch changes against its base: what the ticket says before the diff is opened. */
export interface ChangesSummary {
  files: number;
  additions: number;
  deletions: number;
}
