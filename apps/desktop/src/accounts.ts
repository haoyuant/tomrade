import { app } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { relaunchArgs } from "./background.js";
import { requestSafeStart, SAFE_FLAG, SAFE_REQUEST_FILE } from "./safe-start.js";

export interface Roots {
  userData: string;
  tomradeDir: string;
}

/** Where this machine keeps Tomrade before any account is chosen. */
export function machineRoots(): Roots {
  const userData = app.getPath("userData");
  // A separate checkout keeps its own projects and extensions, as it keeps its own database.
  return { userData, tomradeDir: process.env.TOMRADE_USER_DATA ? userData : path.join(os.homedir(), "Tomrade") };
}

const Registry = z.object({
  v: z.literal(1),
  /** The folder the next start opens; null is the original one. */
  active: z.string().nullable(),
  accounts: z.record(z.string(), z.object({ email: z.string(), folder: z.string().nullable() }))
});
type Registry = z.infer<typeof Registry>;

/**
 * One local Hub per account. The first account keeps the original folders, so a
 * machine that never switches never moves anything; each other account gets
 * `accounts/<folder>` under both the app data and the visible Tomrade folder.
 */
export class AccountFolders {
  private readonly file: string;

  constructor(private readonly roots: Roots) {
    this.file = path.join(roots.userData, "accounts.json");
  }

  private read(): Registry {
    try {
      return Registry.parse(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch {
      return { v: 1, active: null, accounts: {} };
    }
  }

  private write(registry: Registry): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(registry, null, 2) + "\n");
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  /** An account's app data and its visible folder, the boot's `userData` and `hubDir`. */
  dirs(folder: string | null): { userData: string; hubDir: string } {
    if (folder === null) return { userData: this.roots.userData, hubDir: this.roots.tomradeDir };
    return { userData: path.join(this.roots.userData, "accounts", folder), hubDir: path.join(this.roots.tomradeDir, "accounts", folder) };
  }

  get active(): string | null {
    return this.read().active;
  }

  /** The folder whose app data is `userData`; undefined for a directory this registry does not manage. */
  folderAt(userData: string): string | null | undefined {
    const dir = path.resolve(userData);
    if (dir === path.resolve(this.roots.userData)) return null;
    if (path.dirname(dir) === path.resolve(this.roots.userData, "accounts")) return path.basename(dir);
    return undefined;
  }

  elsewhere(userId: string, here: string | null): boolean {
    const entry = this.read().accounts[userId];
    return entry !== undefined && entry.folder !== here;
  }

  claim(user: { id: string; email: string }, here: string | null): void {
    const registry = this.read();
    const entry = registry.accounts[user.id];
    const email = user.email || entry?.email || "";
    if (entry && entry.folder === here && entry.email === email) return;
    // A folder holds one account; an older claim on it is stale.
    for (const [id, other] of Object.entries(registry.accounts)) if (other.folder === here) delete registry.accounts[id];
    registry.accounts[user.id] = { email, folder: here };
    this.write(registry);
  }

  /** The user's folder; a new one is named after their address. */
  folderFor(user: { id: string; email: string }): string | null {
    const registry = this.read();
    const known = registry.accounts[user.id];
    return known ? known.folder : this.name(registry, user.email);
  }

  /** A deleted account owns no folder any more; whoever signs in there next takes it. */
  forget(userId: string): void {
    const registry = this.read();
    if (!registry.accounts[userId]) return;
    delete registry.accounts[userId];
    this.write(registry);
  }

  /** Open `folder` at the next start, as the user's. */
  activate(user: { id: string; email: string }, folder: string | null): void {
    const registry = this.read();
    registry.accounts[user.id] = { email: user.email || registry.accounts[user.id]?.email || "", folder };
    registry.active = folder;
    this.write(registry);
  }

  private name(registry: Registry, email: string): string {
    const base = email.toLowerCase().replace(/[^a-z0-9@._+-]+/g, "_").replace(/^\.+/, "") || "account";
    const taken = new Set(Object.values(registry.accounts).map((a) => a.folder));
    const free = (name: string) => !taken.has(name) && !fs.existsSync(this.dirs(name).userData) && !fs.existsSync(this.dirs(name).hubDir);
    let name = base;
    for (let n = 2; !free(name); n++) name = `${base}-${n}`;
    return name;
  }
}

/** Quit through the usual flush, then start again — once without the person's own plugins when `safe`. */
export function restart(opts: { safe?: boolean } = {}): void {
  // A file rather than an argument, so the dev launcher's restart carries it too.
  if (opts.safe) requestSafeStart(path.join(machineRoots().userData, SAFE_REQUEST_FILE));
  // `pnpm dev` owns the dev server: its launcher starts Electron again on this code.
  const code = Number(process.env.TOMRADE_RESTART_EXIT_CODE);
  if (code) {
    app.once("will-quit", (event) => {
      event.preventDefault();
      app.exit(code);
    });
  } else {
    app.relaunch({ args: relaunchArgs().filter((arg) => arg !== SAFE_FLAG) });
  }
  app.quit();
}
