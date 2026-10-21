import fs from "node:fs";
import type { Context } from "cordis";
import { z } from "zod";
import type { SettingsSection } from "@tomradex/settings";
import { defineTool, type ToolInvocation } from "@tomradex/tools";
import { DEFAULT_TIMEOUT_S, describeResult, findBash, runShell } from "./run.js";
import { SHELL_WORDS } from "./words.js";
import { contract, localeOf } from "@tomradex/contracts";

export { OutputBuffer, describeResult, findBash, plain, runShell, type ShellResult, type ShellRun } from "./run.js";

export type Approval = "ask" | "auto" | "off";

export interface ShellSettings {
  approval: Approval;
}

export const SHELL_SECTION: SettingsSection<ShellSettings> = {
  id: "shell",
  title: "Shell",
  description:
    "A bash tool for the assistant. Commands run in the conversation's workstream checkout, or else in the project's Files folder, and what they change is outside a run's Undo. Claude Code and Codex keep their own shells; this one is never served to them or to any other MCP client.",
  schema: z.object({
    approval: z
      .enum(["ask", "auto", "off"])
      .default("ask")
      .meta({ title: "Commands" })
      .describe("ask: each command waits for Allow once, Allow for this turn or Deny. auto: commands run without asking. off: the assistant has no shell.")
  }),
  defaults: { approval: "ask" },
  order: 16,
  scope: "machine",
  // An agent must not be able to grant itself a shell that stops asking.
  agent: "none",
  words: {
    en: {
      fields: {
        approval: {
          description: "Ask each time: every command waits for Allow once, Allow for this turn or Deny. Run without asking: commands just run. Off: the assistant has no shell.",
          options: { ask: "Ask each time", auto: "Run without asking", off: "Off" }
        }
      }
    },
    zh: {
      title: "Shell 命令",
      description: "给助手用的 bash 工具。命令在对话所在工作流的检出目录里运行，没有的话就在项目的 Files 文件夹里运行；命令造成的改动不在运行的撤销范围内。Claude Code 和 Codex 用它们自己的 shell；这个工具不会提供给它们，也不会提供给其他任何 MCP 客户端。",
      fields: {
        approval: {
          title: "命令",
          description: "每次询问：每条命令都等你选择允许一次、本轮都允许或拒绝。不询问直接运行：命令直接执行。关闭：助手没有 shell。",
          options: { ask: "每次询问", auto: "不询问直接运行", off: "关闭" }
        }
      }
    }
  }
};

/** The approval question and its answers, in the person's language; the answer is compared with the same words. */
// Run-scoped: approval for the rest of the turn, and the command still running.
const APPROVED = "shell/approved";
const QUEUE = "shell/queue";

const BashArgs = z.object({
  command: z.string().min(1),
  timeout: z.number().int().min(1).max(600).optional().describe(`Seconds; default ${DEFAULT_TIMEOUT_S}`)
});

const description = (approval: Approval): string =>
  [
    "Run a shell command (bash -c) in this conversation's working folder: the workstream's checkout, else the project's Files folder (pwd says which). " +
      "Non-interactive and time-limited: no stdin, pager or password prompts, and no servers, watchers or anything that waits. Returns the exit code, then stdout and stderr, shortened in the middle when long. Each call is a fresh shell: chain steps with &&.",
    "Use it to read code and git history, count, run a check or a script, convert a file. Tickets and Files change through Tomrade's own tools, and a ticket's implementation belongs to a coding agent started from it.",
    "Commands are outside the run's one-click undo: delete, overwrite, commit, push or switch branches only when the user asked.",
    ...(approval === "ask" ? ["Each command waits for the user's approval: combine related steps, and don't run one when another tool already answers."] : [])
  ].join("\n");

/** The run's workstream folder, else the project's Files folder; null when the conversation has neither. */
function workdir(ctx: Context, invocation: ToolInvocation): string | null {
  if (invocation.run?.cwd) return invocation.run.cwd;
  const files = contract(ctx, "files");
  const dir = invocation.projectId ? files?.dirFor(invocation.projectId) : null;
  return dir && fs.existsSync(dir) ? dir : null;
}

export function bashTool(ctx: Context, approval: Approval) {
  const run = async ({ command, timeout }: z.output<typeof BashArgs>, invocation: ToolInvocation): Promise<string> => {
    const handle = invocation.run!;
    const bash = findBash();
    if (!bash) throw new Error(process.platform === "win32" ? "No bash on this machine — install Git for Windows" : "No bash on this machine");
    const cwd = workdir(ctx, invocation);
    if (!cwd) throw new Error("This conversation has no folder to run in: put it on a workstream with a checkout, or give the project a folder");
    if (approval === "ask" && !handle.scratch.get(APPROVED)) {
      if (!invocation.ask) throw new Error("Nobody can be asked to approve a command here");
      const w = SHELL_WORDS(localeOf(ctx));
      const [once, turn, deny] = [w("once"), w("turn"), w("deny")];
      const answer = await invocation.ask(w("question", { cwd, command }), [once, turn, deny]);
      if (answer === null) throw new Error("Not run — the run was stopped");
      if (answer === deny) throw new Error("The user declined this command. Do not run it another way; go on without it, or ask what they want instead.");
      if (answer === turn) handle.scratch.set(APPROVED, true);
    }
    const result = await runShell(command, { bash, cwd, env: handle.env, timeoutS: timeout, signal: invocation.signal });
    return describeResult(result, timeout);
  };
  return defineTool({
    name: "bash",
    title: "Shell",
    description: description(approval),
    input: BashArgs,
    // A shell is for the person in this app; no outside client may reach it.
    mcp: false,
    execute(args, invocation) {
      if (!invocation.run) throw new Error("bash runs only inside an assistant conversation");
      // One command at a time per run, each asked about only when its turn comes.
      const previous = (invocation.run.scratch.get(QUEUE) as Promise<unknown> | undefined) ?? Promise.resolve();
      const next = previous.then(() => run(args, invocation));
      invocation.run.scratch.set(QUEUE, next.catch(() => {}));
      return next;
    }
  });
}

export default {
  name: "shell",
  inject: ["tools", "settings"],
  apply(ctx: Context) {
    ctx.settings.register(SHELL_SECTION);
    let current: Approval | null = null;
    let unregister: (() => void) | null = null;
    // The description says whether commands wait for approval, so a change re-registers the tool.
    const sync = () => {
      const approval = ((ctx.settings.get().shell as ShellSettings | undefined) ?? SHELL_SECTION.defaults).approval;
      if (approval === current) return;
      unregister?.();
      unregister = null;
      current = approval;
      if (approval !== "off") unregister = ctx.tools.register(bashTool(ctx, approval));
    };
    sync();
    ctx.on("settings/changed", sync);
  }
};
