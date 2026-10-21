import { execFile } from "node:child_process";
import { GIT_ENV, cleanRemote, type Git } from "@tomradex/git";

export type RemoteFailure = "credentials" | "network" | "helper" | "unknown";

export interface RemoteIdentity {
  host: string | null;
  login: string | null;
  /** The checkout asks Tomrade's own helper, so a missing login means Tomrade's account is not connected. */
  tomrade?: boolean;
}

export interface RemoteProbe {
  state: "exists" | "absent" | "offline";
  stderr: string;
  detail: string | null;
  failure: RemoteFailure | null;
}

/** Git repeats remotes in errors; credentials embedded in one never leave this boundary. */
export const scrubRemoteOutput = (text: string): string => text.replace(/\/\/[^@\s/]*@/g, "//");

/** A Tomrade credential helper that cannot run: git then ends with a vague "unable to access" that hides it. */
const BROKEN_HELPER = /tomrade-credential.*(?:cannot execute|No such file or directory|Permission denied|not found)/i;

export function remoteFailureDetail(stderr: string): string | null {
  const lines = scrubRemoteOutput(stderr)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  // The helper's own line is the cause; the last line is only what git concluded from it.
  return (lines.find((line) => BROKEN_HELPER.test(line)) ?? lines.at(-1))?.slice(0, 400) ?? null;
}

/** The remedy differs: credentials belong to a person; a network outage can be worked around locally. */
export function classifyRemoteFailure(stderr: string): RemoteFailure {
  if (BROKEN_HELPER.test(stderr)) return "helper";
  if (/Authentication failed|could not read Username|Permission denied \(publickey\)|repository(?:\s+'[^']*'|\s+"[^"]*")?\s+not found|\b403\b|The requested URL returned error: 40[13]|Invalid username or token/i.test(stderr)) return "credentials";
  if (/Could not resolve host|Connection timed out|Failed to connect|Connection refused|Network is unreachable/i.test(stderr)) return "network";
  if (/unable to access/i.test(stderr)) return "network";
  return "unknown";
}

export function remoteFailureMessage(stderr: string): string {
  if (/repository(?:\s+'[^']*'|\s+"[^"]*")?\s+not found/i.test(stderr)) return "origin says the repository does not exist; for a private repository that usually means the account git uses here cannot see it";
  const detail = remoteFailureDetail(stderr) ?? "unknown error";
  const kind = classifyRemoteFailure(stderr);
  if (kind === "helper") return `the credential helper in this checkout's git config cannot run (${detail})`;
  if (kind === "credentials") return `origin rejected the credentials git uses in this checkout (${detail})`;
  if (kind === "network") return `origin is unreachable on the network (${detail})`;
  return `origin is unreachable from this checkout (${detail})`;
}

export async function probeRemote(git: Git, checkout: string, branch: string): Promise<RemoteProbe> {
  const result = await git(["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], { cwd: checkout, ok: true });
  const stderr = scrubRemoteOutput(result.stderr ?? "");
  if (result.code === 0) return { state: "exists", stderr: "", detail: null, failure: null };
  if (result.code === 2) return { state: "absent", stderr: "", detail: null, failure: null };
  return { state: "offline", stderr, detail: remoteFailureDetail(stderr), failure: classifyRemoteFailure(stderr) };
}

function remoteParts(remote: string): { kind: "https" | "ssh"; host: string; path: string } | null {
  const cleaned = cleanRemote(remote);
  if (cleaned.startsWith("https://")) {
    try {
      const url = new URL(cleaned);
      return { kind: "https", host: url.hostname, path: url.pathname.replace(/^\/+|\.git$/g, "") };
    } catch {
      return null;
    }
  }
  const scp = /^git@([^:]+):(.+)$/.exec(cleaned);
  if (scp) return { kind: "ssh", host: scp[1]!, path: scp[2]!.replace(/\.git$/, "") };
  if (cleaned.startsWith("ssh://")) {
    try {
      const url = new URL(cleaned);
      return { kind: "ssh", host: url.hostname, path: url.pathname.replace(/^\/+|\.git$/g, "") };
    } catch {
      return null;
    }
  }
  return null;
}

const sshGreeting = (host: string): Promise<string> =>
  new Promise((resolve) => {
    execFile("ssh", ["-T", "-o", "BatchMode=yes", `git@${host}`], { env: { ...process.env, ...GIT_ENV }, timeout: 6000 }, (_error, stdout, stderr) => resolve(`${stdout}${stderr}`));
  });

/** Read the account this checkout will use without returning or retaining a credential secret. */
export async function readRemoteIdentity(git: Git, checkout: string, remote: string): Promise<RemoteIdentity> {
  const parsed = remoteParts(remote);
  if (!parsed) return { host: null, login: null };
  if (parsed.kind === "https") {
    const result = await git(["credential", "fill"], {
      cwd: checkout,
      ok: true,
      stdin: `protocol=https\nhost=${parsed.host}\npath=${parsed.path}\n\n`
    });
    const login = result.stdout
      .split("\n")
      .find((line) => line.startsWith("username="))
      ?.slice("username=".length)
      .trim();
    return { host: parsed.host, login: login || null };
  }
  const greeting = await sshGreeting(parsed.host);
  const login = /Hi ([^!\s]+)!/i.exec(greeting)?.[1] ?? null;
  return { host: parsed.host, login };
}
