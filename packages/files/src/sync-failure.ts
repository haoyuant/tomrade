import type { FilesSyncFailure } from "./types.js";

/** The step of an exchange with the remote that git refused. */
export type ExchangeStep = "reach" | "fetch" | "push";

export interface ExchangeFailure {
  step: ExchangeStep;
  failure: FilesSyncFailure;
  /** The line of git's output that says why, credentials removed; empty when git said nothing. */
  said: string;
}

const LOCKED = /Unable to create '[^']*\.lock': File exists|Another git process seems to be running/i;
const HELPER = /tomrade-credential.*(?:cannot execute|No such file or directory|Permission denied|not found)|credential-[\w-]+ is not a git command/i;
const CREDENTIALS = /Authentication failed|could not read Username|could not read Password|Permission denied \(publickey\)|repository(?:\s+'[^']*'|\s+"[^"]*")?\s+not found|The requested URL returned error: 40[13]|Invalid username or (?:password|token)|\b403\b/i;
const MOVED = /non-fast-forward|\(fetch first\)|Updates were rejected because the (?:remote|tip)/i;
/** Broke off after it began: only a fetch or a push has a transfer to lose. */
const INTERRUPTED = /early EOF|the remote end hung up unexpectedly|RPC failed|unexpected disconnect|transfer closed|index-pack failed|invalid index-pack output|Connection was reset|Connection reset by peer|Recv failure|curl (?:18|56)|SSL_read|GnuTLS recv error/i;
const NETWORK = /could not resolve|failed to connect|couldn't connect|connection (?:refused|timed out|reset|closed)|network is unreachable|timed out|no route to host|unable to look up|unable to access|proxy|\bssl\b|\btls\b|does not appear to be a git repository/i;

/** Git puts a credential in the URLs it repeats; none leaves this module. */
const scrub = (text: string): string => text.replace(/\/\/[^@\s/]*@/g, "//");

export function classifyFailure(step: ExchangeStep, stderr: string): FilesSyncFailure {
  if (LOCKED.test(stderr)) return "locked";
  if (HELPER.test(stderr)) return "helper";
  if (CREDENTIALS.test(stderr)) return "credentials";
  if (step === "push" && MOVED.test(stderr)) return "moved";
  if (step !== "reach" && INTERRUPTED.test(stderr)) return "interrupted";
  if (NETWORK.test(stderr) || INTERRUPTED.test(stderr)) return "network";
  return "other";
}

/** The helper's own line, else git's first fatal or the remote's own words, else its last line: hints never say why. */
export function failureLine(stderr: string): string {
  const lines = scrub(stderr).split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("hint:"));
  return (lines.find((line) => HELPER.test(line)) ?? lines.find((line) => /^(?:fatal|remote):|^! \[/.test(line)) ?? lines.at(-1) ?? "").slice(0, 300);
}

export const exchangeFailure = (step: ExchangeStep, stderr: string): ExchangeFailure => ({ step, failure: classifyFailure(step, stderr), said: failureLine(stderr) });
