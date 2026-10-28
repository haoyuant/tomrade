import { execFile } from "node:child_process";

/**
 * The token of the GitHub CLI signed in on this machine, or "" without gh or a
 * sign-in. Run by name, as the pull request code runs gh, so both find the same
 * binary. The token is returned to the caller and never logged.
 */
export const ghToken = (env: NodeJS.ProcessEnv = process.env): Promise<string> =>
  new Promise((resolve) => {
    execFile("gh", ["auth", "token"], { timeout: 10_000, env }, (error, stdout) => resolve(error ? "" : String(stdout).trim()));
  });
