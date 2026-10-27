/**
 * "Reading and checks without asking": which commands count, and where — only a ticket's own copy, a linked
 * worktree on its conversation's branch. Everything else waits for the person as under "ask".
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent } from "@tomradex/agent";
import { fakeChat, type ChatEvent, type ChatModel } from "@tomradex/llm";
import loop from "@tomradex/engine-loop";
import shell from "@tomradex/shell";
import { isQuietCommand, isTicketCopy, plainWords } from "../src/quiet.js";

const scripts = new Set(["test", "test:related", "lint", "typecheck", "build", "deploy"]);

describe("which commands run without asking", () => {
  it("lets plain reads and the project's own checks through", () => {
    for (const command of [
      "ls -la src",
      "cat package.json",
      "head -n 20 src/index.ts",
      'grep -rn "session bar" packages/ui/src',
      "rg --files",
      "find . -name '*.test.ts'",
      "wc -l src/*.ts",
      "git status",
      "git --no-pager log --oneline -5",
      "git diff --stat origin/main",
      "git show HEAD:package.json",
      "git branch",
      "git branch -a",
      "pnpm test",
      "pnpm test packages/shell/tests/quiet.test.ts",
      "pnpm test:related",
      "npm run lint",
      "yarn typecheck"
    ])
      expect(isQuietCommand(command, scripts), command).toBe(true);
  });

  it("asks about anything chained, piped, redirected, substituted or expanded", () => {
    for (const command of ["ls && rm -rf src", "cat a; rm b", "grep x | sh", "cat a > b", "cat < /etc/passwd", "echo $(whoami)", "ls `pwd`", "cat $HOME/.ssh/id_rsa", "ls & sleep 9", "ls\nrm x", "cat 'unclosed", "ls \\; rm x"])
      expect(isQuietCommand(command, scripts), command).toBe(false);
  });

  it("asks about reads of anything outside the folder", () => {
    for (const command of ["cat /etc/passwd", "cat ~/.ssh/id_rsa", "ls ../other-repo", "head src/../../secrets", "grep -r key ..", "git --no-pager log -- ../x"])
      expect(isQuietCommand(command, scripts), command).toBe(false);
  });

  it("asks about commands that write, delete, push, reach out or run code of their choosing", () => {
    for (const command of [
      "rm -rf dist",
      "touch x",
      "mv a b",
      "sed -i s/a/b/ file",
      "awk 'BEGIN{system(\"rm x\")}'",
      "node -e 1",
      "python3 x.py",
      "curl https://example.com",
      "find . -delete",
      "find . -exec rm {} +",
      "rg --pre ./run.sh x",
      "tree -o out.txt",
      "file -C -m magic",
      "git push",
      "git commit -m x",
      "git checkout main",
      "git branch -D tom-1/x",
      "git branch new-branch",
      "git diff --output=patch.diff",
      "git diff --ext-diff",
      "git grep -Ovim foo",
      "git -C /tmp status",
      "git -c core.pager=sh log",
      "pnpm install",
      "pnpm build",
      "pnpm deploy",
      "npm run deploy",
      "pnpm check",
      "pnpm exec rm -rf x"
    ])
      expect(isQuietCommand(command, scripts), command).toBe(false);
  });

  it("splits words on spaces with quotes grouping them, and refuses what it cannot split cleanly", () => {
    expect(plainWords(`grep -n "a b" 'c d' e`)).toEqual(["grep", "-n", "a b", "c d", "e"]);
    expect(plainWords("   ")).toBeNull();
    expect(plainWords(`echo "x`)).toBeNull();
  });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

function repoWithCopy() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-quiet-")));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const copy = path.join(root, "copy");
  git(repo, "worktree", "add", "-q", "-b", "tom-1/work", copy);
  fs.writeFileSync(path.join(copy, "package.json"), JSON.stringify({ scripts: { test: "echo tested" } }));
  fs.writeFileSync(path.join(copy, "note.txt"), "hello\n");
  return { root, repo, copy };
}

describe.skipIf(process.platform === "win32")("where commands run without asking", () => {
  it("is a ticket's own copy only: a linked worktree, at its top, on the conversation's branch", async () => {
    const { root, repo, copy } = repoWithCopy();
    try {
      expect(await isTicketCopy(copy, "tom-1/work")).toBe(true);
      expect(await isTicketCopy(repo, "main")).toBe(false);
      expect(await isTicketCopy(copy, "tom-2/other")).toBe(false);
      fs.mkdirSync(path.join(copy, "sub"));
      expect(await isTicketCopy(path.join(copy, "sub"), "tom-1/work")).toBe(false);
      expect(await isTicketCopy(root, "tom-1/work")).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs a read in the ticket's copy without asking, and still asks about a write there, or a read in the main checkout", async () => {
    const { root, repo, copy } = repoWithCopy();
    const steps: ChatEvent[][] = [
      [{ type: "tool_call", id: "a", name: "bash", args: { command: "cat note.txt" } }, { type: "stop", reason: "tool_use" }],
      [{ type: "tool_call", id: "b", name: "bash", args: { command: "pnpm test" } }, { type: "stop", reason: "tool_use" }],
      [{ type: "tool_call", id: "c", name: "bash", args: { command: "touch made.txt" } }, { type: "stop", reason: "tool_use" }]
    ];
    let step = 0;
    const model: ChatModel = { capabilities: { tools: true, streaming: true, json: true }, async *chat() { for (const ev of steps[step++] ?? [{ type: "stop", reason: "end" }]) yield ev; } };
    const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], fakeChat(model), [Agent, { mediaDir: path.join(root, "media") }], loop, shell] });
    try {
      ctx.settings.set({ ...ctx.settings.get(), shell: { approval: "checks" } });
      let cwd = copy;
      ctx.on("agent/prepare-turn", (input) => void (input.cwd = cwd));
      const thread = ctx.agent.newThread(project.id, "loop");
      // the conversation of a ticket, on the copy's branch
      const read = ctx.agent.store.thread.bind(ctx.agent.store);
      ctx.agent.store.thread = (projectId: string, id: string) => {
        const th = read(projectId, id);
        return th && id === thread.id ? { ...th, itemId: "ticket", branch: "tom-1/work" } : th;
      };
      const ran = ctx.agent.send(project.id, thread.id, { kind: "text", text: "go" });
      // the read and the check run; the write waits for the person
      await expect.poll(() => ctx.agent.thread(project.id, thread.id).pending?.kind).toBe("permission");
      const asked = ctx.agent.thread(project.id, thread.id).pending!.question;
      expect(asked.text).toContain("touch made.txt");
      ctx.agent.send(project.id, thread.id, { kind: "answer", questionId: asked.id, value: "Deny" });
      await expect.poll(() => ctx.agent.store.run(project.id, ran.runId)?.status).not.toBe("running");
      const traces = ctx.agent.thread(project.id, thread.id).messages.flatMap((m) => (m.block.type === "trace" ? [m.block] : []));
      expect(traces.map((t) => t.ok)).toEqual([true, true, false]);
      expect(fs.existsSync(path.join(copy, "made.txt"))).toBe(false);

      // the same read in the repository's main checkout is asked about
      cwd = repo;
      steps.splice(0, steps.length, [{ type: "tool_call", id: "d", name: "bash", args: { command: "ls" } }, { type: "stop", reason: "tool_use" }]);
      step = 0;
      const again = ctx.agent.send(project.id, thread.id, { kind: "text", text: "again" });
      await expect.poll(() => ctx.agent.thread(project.id, thread.id).pending?.kind).toBe("permission");
      const second = ctx.agent.thread(project.id, thread.id).pending!.question;
      ctx.agent.send(project.id, thread.id, { kind: "answer", questionId: second.id, value: "Deny" });
      await expect.poll(() => ctx.agent.store.run(project.id, again.runId)?.status).not.toBe("running");
    } finally {
      await ctx.fiber.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
