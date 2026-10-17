import { execFile } from "node:child_process";
import { Context, Service } from "cordis";
import type {} from "@tomradex/doctor";
import type { Check } from "@tomradex/doctor";
import { HerdrError, herdrCall, herdrSocketPath } from "./client.js";
import { HERDR_WORDS } from "./words.js";

export { HerdrError, herdrCall, herdrSocketPath } from "./client.js";

/** The herdr server answering on this machine's socket. */
export interface HerdrServer {
  version: string;
  protocol: number;
  socket: string;
}

declare module "cordis" {
  interface Context {
    herdr: Herdr;
  }
}

/** Where to get herdr; shown wherever it is missing. */
export const HERDR_INSTALL = "brew install herdr";

/**
 * herdr on this machine — the terminal workspace manager coding agents run
 * in. Tomrade neither bundles nor starts it: when it is there, a session's
 * pane can be found again; when it is not, nothing here is called.
 */
export class Herdr extends Service {
  static provide = "herdr";

  constructor(ctx: Context) {
    super(ctx, "herdr");
  }

  [Service.init]() {
    this.ctx.inject(["doctor"], (ctx) => ctx.doctor.check(this.check(ctx)));
  }

  socketPath(): string {
    return herdrSocketPath();
  }

  /** The herdr CLI's version, or null when `herdr` is not on PATH. */
  installed(): Promise<string | null> {
    return new Promise((resolve) => {
      execFile("herdr", ["--version"], { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(String(stdout).trim().replace(/^herdr\s+/, "") || null);
      });
    });
  }

  /** The running server, or null when none answers on the socket. */
  async server(): Promise<HerdrServer | null> {
    const socket = this.socketPath();
    try {
      const pong = await herdrCall<{ version?: string; protocol?: number }>(socket, "ping", {}, 2000);
      return { version: pong.version ?? "", protocol: pong.protocol ?? 0, socket };
    } catch {
      return null;
    }
  }

  /** One request to the server; a refusal is a `HerdrError` with herdr's own code. */
  call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return herdrCall<T>(this.socketPath(), method, params);
  }

  /** Bring a pane to the front in herdr — its workspace, then the pane itself. False when herdr cannot: gone, or the pane with it. */
  async focus(paneId: string): Promise<boolean> {
    try {
      const { pane } = await this.call<{ pane: { workspace_id: string } }>("pane.get", { pane_id: paneId });
      await this.call("workspace.focus", { workspace_id: pane.workspace_id });
      await this.call("pane.focus", { pane_id: paneId });
      return true;
    } catch (err) {
      if (!(err instanceof HerdrError)) throw err;
      return false;
    }
  }

  /** The troubleshooter's line about herdr: there or not, never a problem in itself. */
  private check(ctx: Context): Check {
    return {
      id: "herdr",
      title: () => "herdr",
      run: async () => {
        const w = HERDR_WORDS(ctx.doctor.locale());
        const version = await this.installed();
        if (!version) return { state: "skip", line: w("notInstalled", { install: HERDR_INSTALL }) };
        const server = await this.server();
        if (!server) return { state: "ok", line: w("installedNotRunning", { version }), facts: { herdr: version } };
        return { state: "ok", line: w("running", { version: server.version, socket: server.socket }), facts: { herdr: server.version } };
      }
    };
  }
}

export default Herdr;
