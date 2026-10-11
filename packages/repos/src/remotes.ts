import { execFile } from "node:child_process";
import { cleanRemote } from "@tomradex/storage";

/** Two spellings of one repository read the same: no credential, no trailing `.git`, no trailing slash. */
export const normalizeRemote = (remote: string): string => cleanRemote(remote.trim()).replace(/\/+$/, "").replace(/\.git$/, "");

/** Where a network remote lives, whatever the scheme, user or port. Local paths have no identity beyond their spelling. */
export interface RemoteIdentity {
  host: string;
  path: string;
  ssh: boolean;
}

/** SSH-over-443 endpoints serve the very repositories of their main host. */
const SAME_HOST: Record<string, string> = { "ssh.github.com": "github.com", "altssh.gitlab.com": "gitlab.com", "altssh.bitbucket.org": "bitbucket.org" };

const canonicalHost = (host: string): string => {
  const lower = host.toLowerCase();
  return SAME_HOST[lower] ?? lower;
};

const canonicalPath = (p: string): string => p.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase();

export const remoteIdentity = (remote: string): RemoteIdentity | null => {
  const raw = remote.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (!url.hostname || url.protocol === "file:") return null;
      return { host: canonicalHost(url.hostname), path: canonicalPath(decodeURIComponent(url.pathname)), ssh: url.protocol === "ssh:" || url.protocol === "git+ssh:" };
    } catch {
      return null;
    }
  }
  // scp-like `user@host:owner/repo`; a one-letter "host" is a Windows drive.
  const scp = /^(?:[^@/:]+@)?([^/:]{2,}):(?!\/\/)(.+)$/.exec(raw);
  return scp ? { host: canonicalHost(scp[1]!), path: canonicalPath(scp[2]!), ssh: true } : null;
};

/** The real server behind an alias in ~/.ssh/config (`Host github.com-work` → `HostName github.com`), or the name itself. */
export const sshHostName = (host: string): Promise<string> =>
  new Promise((resolve) => {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(host)) return resolve(host);
    execFile("ssh", ["-G", "--", host], { timeout: 3000, windowsHide: true }, (error, stdout) => {
      const named = error ? null : /^hostname\s+(\S+)$/m.exec(String(stdout))?.[1];
      resolve(named ?? host);
    });
  });

/**
 * Whether two remotes are one repository: `git@github.com:acme/app.git`,
 * `https://github.com/acme/app` and an SSH alias of github.com all are.
 */
export async function sameRepository(a: string, b: string, resolveHost: (host: string) => Promise<string> = sshHostName): Promise<boolean> {
  if (normalizeRemote(a) === normalizeRemote(b)) return true;
  const x = remoteIdentity(a);
  const y = remoteIdentity(b);
  if (!x || !y || x.path !== y.path) return false;
  if (x.host === y.host) return true;
  const real = async (id: RemoteIdentity) => (id.ssh ? canonicalHost(await resolveHost(id.host)) : id.host);
  const [hx, hy] = await Promise.all([real(x), real(y)]);
  return hx === hy;
}
