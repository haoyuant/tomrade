import { createHash } from "node:crypto";
import { z } from "zod";
import type { SettingsSection } from "@tomradex/settings";
import type { TerminalStatus } from "@tomradex/contracts";

export const IdleSettings = z.object({
  enabled: z.boolean().default(true).meta({ title: "Close idle terminals" }).describe("A terminal Tomrade opened that no cell of the Terminal window shows is closed once nothing has happened in it for a while. A working agent, one waiting on you, or a command still running is never closed."),
  minutes: z.number().int().min(5).max(10080).default(60).meta({ title: "Idle for (minutes)" }).describe("How long such a terminal stays with no output, no input and its agent not working before it is closed.")
});
export type IdleSettings = z.infer<typeof IdleSettings>;

export const IDLE_SECTION: SettingsSection<IdleSettings> = {
  id: "terminalIdle",
  title: "Idle terminals",
  description: "Terminals Tomrade opened pile up once no cell shows them. Those left with nothing happening are closed; a closed session's conversation can still be resumed from History.",
  schema: IdleSettings,
  defaults: IdleSettings.parse({}),
  scope: "machine",
  order: 32,
  words: {
    zh: {
      title: "闲置终端",
      description: "Tomrade 开的终端不在格子里显示后容易越积越多。一段时间没有任何动静的会被关掉；关掉的会话仍可在历史里恢复对话。",
      fields: {
        enabled: { title: "自动关闭闲置终端", description: "Tomrade 开的、终端窗口格子里没显示的终端，一段时间没有任何动静就关掉。正在工作或等你回答的 agent、还在跑的命令永远不关。" },
        minutes: { title: "闲置多久后关闭（分钟）", description: "这样的终端没有输出、没有输入、agent 也没在工作，持续这么久就关掉。" }
      }
    }
  }
};

/** How often the panes are looked at: the idle time is counted in these steps. */
export const IDLE_SWEEP_MS = 5 * 60_000;
/** The screen lines compared between looks: any change on them is activity. */
export const IDLE_TAIL_LINES = 40;

/** One pane as a sweep found it: its agent's status, the end of its screen, and whether a command other than a shell runs in it. */
export interface PaneLook {
  pane: string;
  status: TerminalStatus;
  tail: string | null;
  busy: boolean;
}

/**
 * When each pane last showed activity, as the sweeps saw it: its screen changing, its agent working or waiting on the
 * person, a command running. A pane first seen counts from then, so nothing is closed for idling before Tomrade looked.
 */
export class IdleTracker {
  private readonly seen = new Map<string, { mark: string; at: number }>();

  /** Notes each pane's look; the panes idle for `idleMs` or more. Panes not in `looks` are forgotten. */
  look(looks: PaneLook[], now: number, idleMs: number): string[] {
    const here = new Set(looks.map((l) => l.pane));
    for (const pane of [...this.seen.keys()]) if (!here.has(pane)) this.seen.delete(pane);
    const idle: string[] = [];
    for (const l of looks) {
      const mark = createHash("sha1").update(l.tail ?? "").digest("hex");
      const was = this.seen.get(l.pane);
      const active = !was || was.mark !== mark || l.busy || l.status === "working" || l.status === "blocked";
      const at = active ? now : was.at;
      this.seen.set(l.pane, { mark, at });
      if (now - at >= idleMs) idle.push(l.pane);
    }
    return idle;
  }

  forget(pane: string): void {
    this.seen.delete(pane);
  }

  clear(): void {
    this.seen.clear();
  }
}
