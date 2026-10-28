import { useState, type ReactNode } from "react";
import type { Board, Project } from "@tomradex/domain";
import type { FolderRepo } from "@tomradex/repos";
import { Icon } from "~/components/icons";
import { invoke } from "~/lib/api";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { isCommitKey } from "~/lib/keys";
import { useCreateProject } from "~/lib/queries";
import { pickDirectory } from "~/lib/shell";
import { readableError } from "~/lib/toast";

type StepState = "done" | "active" | "failed" | "pending";
type Failure = { at: "project" | "repo" | "link" | "send"; message: string };
/** What the first two steps made: kept, so a retry goes on from where it stopped instead of making a second project. */
type Ready = { project: Project; added?: FolderRepo; board?: Board; dir: string };

const FAIL: Record<Failure["at"], [MessageKey, MessageKey]> = {
  project: ["firstTask.failProject", "firstTask.failProjectNext"],
  repo: ["firstTask.failRepo", "firstTask.failRepoNext"],
  link: ["firstTask.failLink", "firstTask.failLinkNext"],
  send: ["firstTask.failSend", "firstTask.failSendNext"]
};

const folderName = (dir: string) => dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || dir;

/**
 * The first run's "do a small thing in my repository": the project, the
 * repository and the first request made here with the same calls the rest of
 * the app uses, then the project opens on the assistant's answer. Each step
 * says where it stands, why it failed and what to do next; the last four
 * happen in the project and are told ahead.
 */
export function RepoTask({ agents, onBack, onOpened }: { agents: string | null; onBack: () => void; onOpened: (projectId: string) => void }) {
  const { t, locale } = useI18n();
  const create = useCreateProject();
  const [ready, setReady] = useState<Ready | null>(null);
  const [busy, setBusy] = useState<"picking" | "preparing" | "sending" | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [task, setTask] = useState("");
  const [dir, setDir] = useState<string | null>(null);
  const linked = !!ready?.board;

  // Steps 2a–2c, from wherever the last try stopped.
  const prepare = async (from: Ready | { dir: string }) => {
    setBusy("preparing");
    setFailure(null);
    let at: Failure["at"] = "project";
    try {
      let project = "project" in from ? from.project : await create.mutateAsync({ input: { name: folderName(from.dir), locale } });
      // A folder refused before left its project behind: it takes the new folder's name.
      if ("project" in from && !from.added && project.name !== folderName(from.dir)) project = (await invoke("projects.update", project.id, { name: folderName(from.dir) })) ?? project;
      let step: Ready = { ...("project" in from ? from : {}), project, dir: from.dir };
      setReady(step);
      at = "repo";
      const added = step.added ?? (await invoke("repos.addFromFolder", project.id, from.dir));
      step = { ...step, added };
      setReady(step);
      at = "link";
      const boards = await invoke("boards.list", project.id);
      const board = boards.find((b) => b.repoId === added.repo.id) ?? boards.find((b) => !b.repoId) ?? boards[0];
      if (!board) throw new Error("no workstream");
      setReady({ ...step, board: board.repoId === added.repo.id ? board : await invoke("boards.update", project.id, board.id, { repoId: added.repo.id, repoPath: "" }) });
    } catch (error) {
      setFailure({ at, message: readableError(error) });
    } finally {
      setBusy(null);
    }
  };

  const pick = async () => {
    setBusy("picking");
    const chosen = await pickDirectory(t("firstTask.pickTitle"), t("firstTask.pickButton"));
    setBusy(null);
    if (!chosen) return;
    setDir(chosen);
    // A project already made keeps its rows; only the repository is asked again.
    await prepare(ready ? { project: ready.project, dir: chosen } : { dir: chosen });
  };

  const send = async () => {
    const text = task.trim();
    if (!text || !ready?.board || busy) return;
    setBusy("sending");
    setFailure(null);
    try {
      // A thread on the linked workstream, so its tickets are filed and run there.
      const thread = await invoke("agent.newThread", ready.project.id, undefined, ready.board.id, {});
      await invoke("agent.send", ready.project.id, thread.id, t("firstTask.message", { task: text }));
      onOpened(ready.project.id);
    } catch (error) {
      setFailure({ at: "send", message: readableError(error) });
      setBusy(null);
    }
  };

  const failed = (at: Failure["at"][]) => (failure && at.includes(failure.at) ? failure : null);
  const why = (f: Failure, retry: ReactNode) => (
    <>
      <span className="setup-fix" role="alert" data-testid="repo-task-failure" data-at={f.at}>
        {t(FAIL[f.at][0], { message: f.message })}
      </span>
      <span className="setup-fix">{t(FAIL[f.at][1])}</span>
      {retry}
    </>
  );
  const retryButton = (run: () => void, label: MessageKey = "firstTask.retry") => (
    <span className="setup-action">
      <button type="button" className="btn btn-secondary btn-sm" data-testid="repo-task-retry" disabled={!!busy} onClick={run}>
        {t(label)}
      </button>
    </span>
  );

  const pickFailed = failed(["repo"]);
  const projectFailed = failed(["project", "link"]);
  const sendFailed = failed(["send"]);
  const pickButton = (
    <span className="setup-action">
      <button type="button" className={ready ? "btn btn-secondary btn-sm" : "btn btn-primary btn-sm"} data-testid="repo-task-pick" disabled={!!busy} onClick={() => void pick()}>
        {busy === "picking" ? t("firstTask.stepPickChoosing") : t(ready ? "firstTask.stepPickAgain" : "firstTask.stepPickButton")}
      </button>
    </span>
  );

  const steps: { id: string; label: MessageKey; state: StepState; body: ReactNode }[] = [
    {
      id: "pick",
      label: "firstTask.stepPick",
      state: pickFailed ? "failed" : dir ? "done" : "active",
      body: pickFailed ? (
        why(pickFailed, pickButton)
      ) : dir ? (
        <>
          <span className="setup-live" title={dir}>{dir}</span>
          {!linked && !busy && pickButton}
        </>
      ) : (
        <>
          <span className="setup-line">{t("firstTask.stepPickNote")}</span>
          {pickButton}
        </>
      )
    },
    {
      id: "project",
      label: "firstTask.stepProject",
      state: projectFailed ? "failed" : linked ? "done" : busy === "preparing" ? "active" : "pending",
      body: projectFailed ? (
        why(projectFailed, retryButton(() => void prepare(ready ?? { dir: dir ?? "" })))
      ) : linked && ready.added ? (
        <>
          <span className="setup-line">{t("firstTask.stepProjectDone", { project: ready.project.name, board: ready.board!.name, repo: ready.added.repo.name })}</span>
          {ready.added.initialised ? (
            <span className="setup-line">{t("firstTask.stepProjectInitialised")}</span>
          ) : ready.added.committed > 0 ? (
            <span className="setup-line">{t("firstTask.stepProjectCommitted", { n: ready.added.committed })}</span>
          ) : null}
          {ready.added.local && <span className="setup-line">{t("firstTask.stepProjectLocal")}</span>}
        </>
      ) : (
        <span className="setup-line">{t(busy === "preparing" ? "firstTask.stepProjectBusy" : "firstTask.stepProjectNote")}</span>
      )
    },
    {
      id: "task",
      label: "firstTask.stepTask",
      state: busy === "sending" ? "done" : linked ? "active" : "pending",
      body: (
        <>
          <span className="setup-line">{t("firstTask.stepTaskNote")}</span>
          {linked && (
            <span className="setup-action row repo-task-input">
              <input
                id="repoTaskText"
                className="input"
                autoFocus
                autoComplete="off"
                aria-label={t("firstTask.taskLabel")}
                placeholder={t("firstTask.taskPlaceholder")}
                value={task}
                disabled={busy === "sending"}
                onChange={(e) => setTask(e.target.value)}
                onKeyDown={(e) => {
                  if (isCommitKey(e)) void send();
                }}
              />
              <button type="button" className="btn btn-primary btn-sm" data-testid="repo-task-send" disabled={!task.trim() || !!busy} onClick={() => void send()}>
                {busy === "sending" ? t("firstTask.sending") : t("firstTask.send")}
              </button>
            </span>
          )}
        </>
      )
    },
    {
      id: "plan",
      label: "firstTask.stepPlan",
      state: sendFailed ? "failed" : busy === "sending" ? "active" : "pending",
      body: sendFailed ? why(sendFailed, retryButton(() => void send())) : <span className="setup-line">{t("firstTask.stepPlanNote")}</span>
    },
    { id: "start", label: "firstTask.stepStart", state: "pending", body: <span className="setup-line">{agents ? t("firstTask.stepStartNote", { agents }) : t("firstTask.stepStartNoAgent")}</span> },
    { id: "progress", label: "firstTask.stepProgress", state: "pending", body: <span className="setup-line">{t("firstTask.stepProgressNote")}</span> },
    { id: "deliver", label: "firstTask.stepDeliver", state: "pending", body: <span className="setup-line">{t("firstTask.stepDeliverNote")}</span> },
    { id: "merge", label: "firstTask.stepMerge", state: "pending", body: <span className="setup-line">{t("firstTask.stepMergeNote")}</span> }
  ];

  // An active step waits on the person unless something is under way.
  const icon = (state: StepState) =>
    state === "done" ? <Icon name="i-check" size={12} /> : state === "failed" ? <Icon name="i-warn" size={12} /> : state === "pending" ? <span className="setup-step-dot" /> : <Icon name={busy ? "i-sync" : "i-pen"} size={12} />;

  return (
    <div className="stack-3" data-testid="repo-task">
      <div className="stack-2">
        <h2 className="setup-section-title">{t("firstTask.title")}</h2>
        <p className="meta-txt">{t("firstTask.lede")}</p>
      </div>
      <ol className="setup-steps repo-task-steps">
        {steps.map((step) => (
          <li key={step.id} data-step={step.id} data-state={step.state}>
            {icon(step.state)}
            <div className="setup-step-body">
              <span className="setup-name">{t(step.label)}</span>
              {step.body}
            </div>
          </li>
        ))}
      </ol>
      <div>
        <button type="button" className="btn btn-ghost" data-testid="repo-task-back" disabled={busy === "preparing" || busy === "sending"} onClick={onBack}>
          {t("firstTask.back")}
        </button>
      </div>
    </div>
  );
}
