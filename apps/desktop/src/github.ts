import path from "node:path";
import { Context } from "cordis";
import GitHubAccount, { type GitHubConfig } from "@tomradex/github";
import { safeCipher } from "./cipher.js";

/** The GitHub account, with its sign-in kept in the OS keychain's encryption. */
export default function github(ctx: Context, config: { userData: string } & Omit<GitHubConfig, "cipher" | "sessionFile">) {
  const { userData, ...rest } = config;
  ctx.plugin(GitHubAccount, { ...rest, sessionFile: path.join(userData, "github-session.enc"), cipher: safeCipher });
}
