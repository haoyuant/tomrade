import { useState } from "react";
import type { StartResult } from "@tomradex/code-link";
import { useChooseRepoFolder } from "~/components/projects/RepositoriesBlock";
import { findEngine, useEngines } from "~/lib/agent";
import { useI18n } from "~/lib/i18n";
import { usePatchItem, useCloneRepoInto, useItems, useRepos, useSelectCheckout, useSetPluginEnabled, useUpdateBoard } from "~/lib/queries";
import { pickDirectory } from "~/lib/shell";
import { errorSpec, useToast } from "~/lib/toast";

export type StartFailure = Extract<StartResult, { ok: false }>;

/** What stopped the start, said in the person's language from the details the failure carries. */
export function useGateWords() {
  const { t } = useI18n();
  const engines = useEngines();
  return (f: StartFailure, itemKey: string): { lead: string; detail?: string } => {
    const board = f.board?.name ?? "";
    const repo = f.repo?.name ?? "";
    switch (f.gate) {
      case "workstream":
        return { lead: f.message.includes("no longer has") ? t("codeLink.gateWorkstreamGone", { board }) : t("codeLink.gateWorkstream", { board }) };
      case "checkout":
        if (f.placed) return { lead: t(f.placed.problem === "missing" ? "codeLink.gateCheckoutMissing" : "codeLink.gateCheckoutNotGit", { repo, dir: f.placed.dir }) };
        return { lead: t("codeLink.gateCheckout", { repo }) };
      case "remote":
        return { lead: t("codeLink.gateRemote", { repo }), detail: f.message };
      case "engine": {
        const title = findEngine(engines.data, f.engine)?.title ?? f.engine;
        return title ? { lead: t("codeLink.gateEngine", { engine: title }), detail: f.message } : { lead: f.message };
      }
      case "mcp":
        return { lead: t("codeLink.gateMcp") };
      case "locked":
        return { lead: t("codeLink.gateLocked", { key: itemKey }) };
      case "workdir": {
        const cause = f.cause;
        if (cause?.code === "no-board") return { lead: t("codeLink.gateWorkdirNoBoard") };
        if (cause?.code === "no-board-repo") return { lead: t("codeLink.gateWorkstream", { board }) };
        if (cause?.code === "unknown-repo") return { lead: t("codeLink.gateWorkdirUnknownRepo", { board, repo: cause.repoId ?? "?" }) };
        if (cause?.code === "no-hub") return { lead: t("codeLink.gateWorkdirNoHub") };
        if (cause?.code === "folder-outside") return { lead: t("codeLink.gateWorkdirFolderOutside", { board, folder: cause.folder ?? "", checkout: cause.checkout ?? "" }) };
        if (cause?.code === "branch-in-use" && cause.branch && cause.heldAt) return { lead: t(cause.releasable ? "codeLink.gateWorkdirBranchReleasable" : "codeLink.gateWorkdirBranchInUse", { branch: cause.branch, at: cause.heldAt }) };
        return { lead: t("codeLink.gateWorkdir"), detail: f.message };
      }
      case "readiness":
        return f.bootstrapKey ? { lead: t("codeLink.gateReadiness", { repo, bootstrap: f.bootstrapKey, key: itemKey }) } : { lead: f.message };
      case "blocked":
        return f.blockers?.length ? { lead: t("codeLink.gateBlocked", { key: itemKey, list: f.blockers.join(", ") }) } : { lead: f.message };
      default:
        return { lead: f.message };
    }
  };
}

/**
 * The fix for what stopped a start, right where it was reported: connect the
 * workstream to a repository, point at the checkout, set up the agent, switch
 * the MCP server on, unlock the ticket. A fix that lands starts again.
 */
export function StartGateFix({
  projectId,
  itemId,
  failure,
  onRetry,
  onLeave,
  onOpenRepositories,
  onOpenIssue,
  onOpenEngine,
  onStartFirst
}: {
  projectId: string;
  itemId: string;
  failure: StartFailure;
  /** Start again, past whatever was just fixed. */
  onRetry: (allowBlocked?: boolean, releaseBranch?: boolean) => void;
  /** The fix is somewhere else: close the dialog first. */
  onLeave: () => void;
  onOpenRepositories?: () => void;
  onOpenIssue?: (idOrKey: string) => void;
  onOpenEngine: (engineId?: string) => void;
  /** Start the ticket that stands in the way (a bootstrap) with this dialog's choices; this ticket follows it. */
  onStartFirst?: (key: string) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const repos = useRepos(projectId);
  const items = useItems(projectId);
  const updateBoard = useUpdateBoard(projectId);
  const folder = useChooseRepoFolder(projectId);
  const selectCheckout = useSelectCheckout();
  const clone = useCloneRepoInto();
  const setPlugin = useSetPluginEnabled();
  const patch = usePatchItem(projectId);
  const [repoId, setRepoId] = useState<string>("");
  const [cloneInto, setCloneInto] = useState<{ parent: string; dir: string } | null>(null);
  const fail = (err: unknown) => toast(errorSpec(err));
  const leave = (go: () => void) => () => {
    onLeave();
    go();
  };
  const repositories = onOpenRepositories && (
    <button type="button" className="btn btn-ghost" onClick={leave(onOpenRepositories)}>
      {t("codeLink.gateRepositories")}
    </button>
  );

  switch (failure.gate) {
    case "workstream": {
      const board = failure.board;
      const list = repos.data ?? [];
      const chosen = repoId || list[0]?.id || "";
      const connect = (id: string) => board && updateBoard.mutate({ id: board.id, patch: { repoId: id } }, { onSuccess: () => onRetry(), onError: fail });
      return (
        <div className="gate-fix" data-testid="gate-fix-workstream">
          {list.length > 0 && board && (
            <div className="row" style={{ gap: "var(--space-2)", alignItems: "center" }}>
              <select className="select" aria-label={t("codeLink.gateRepoPick")} value={chosen} onChange={(e) => setRepoId(e.target.value)} data-testid="gate-repo">
                {list.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <button type="button" className="btn btn-primary" data-testid="gate-connect" disabled={!chosen || updateBoard.isPending} onClick={() => connect(chosen)}>
                {t("codeLink.gateConnect", { board: board.name })}
              </button>
            </div>
          )}
          <div className="row" style={{ gap: "var(--space-2)", flexWrap: "wrap" }}>
            {board && (
              <button
                type="button"
                className="btn btn-ghost"
                data-testid="gate-add-folder"
                disabled={folder.busy}
                onClick={() => void folder.choose().then((added) => added && connect(added.repo.id))}
              >
                {t(list.length ? "codeLink.gateAddOtherFolder" : "codeLink.gateAddFolder")}
              </button>
            )}
            {repositories}
          </div>
        </div>
      );
    }
    case "checkout": {
      const remote = failure.remote;
      const repoName = failure.repo?.name ?? "";
      const choose = async () => {
        if (!remote) return;
        const dir = await pickDirectory(t("repositories.pickTitle", { name: repoName }), t("repositories.pickButton"));
        if (!dir) return;
        selectCheckout.mutate(
          { remote, dir },
          {
            onSuccess: (selection) => (selection.state === "clone" ? setCloneInto({ parent: selection.parent, dir: selection.dir }) : onRetry()),
            onError: fail
          }
        );
      };
      const repo = (repos.data ?? []).find((r) => r.id === failure.repo?.id);
      return (
        <div className="gate-fix" data-testid="gate-fix-checkout">
          <div className="row" style={{ gap: "var(--space-2)", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-primary" data-testid="gate-choose-checkout" disabled={selectCheckout.isPending} onClick={() => void choose()}>
              {t("codeLink.gateChooseCheckout")}
            </button>
            {/* The same pick: a folder without the checkout is offered as where to clone it. */}
            {!cloneInto && (
              <button type="button" className="btn btn-ghost" data-testid="gate-clone-checkout" disabled={selectCheckout.isPending} onClick={() => void choose()}>
                {t("codeLink.gateCloneCheckout")}
              </button>
            )}
            {repositories}
          </div>
          {cloneInto && repo && (
            <div className="row" style={{ gap: "var(--space-2)", alignItems: "center" }}>
              <span className="meta-txt num" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }} title={cloneInto.dir}>
                {t("codeLink.gateCloneInto", { dir: cloneInto.dir })}
              </span>
              <button
                type="button"
                className="btn btn-secondary"
                data-testid="gate-clone"
                disabled={clone.isPending}
                onClick={() => clone.mutate({ remote: repo.remote, branch: repo.defaultBranch, parent: cloneInto.parent }, { onSuccess: () => onRetry(), onError: fail })}
              >
                {clone.isPending ? t("repositories.cloning") : t("repositories.cloneIntoFolder")}
              </button>
            </div>
          )}
        </div>
      );
    }
    case "workdir":
      if (failure.cause?.code === "branch-in-use" && failure.cause.releasable)
        return (
          <div className="gate-fix">
            <button type="button" className="btn btn-primary" data-testid="gate-free-branch" onClick={() => onRetry(undefined, true)}>
              {t("codeLink.gateFreeBranch")}
            </button>
          </div>
        );
      return repositories ? <div className="gate-fix">{repositories}</div> : null;
    case "remote":
      return repositories ? <div className="gate-fix">{repositories}</div> : null;
    case "engine":
      return (
        <div className="gate-fix">
          <button type="button" className="btn btn-primary" data-testid="gate-engine" onClick={leave(() => onOpenEngine(failure.engine))}>
            {t("codeLink.gateSetUpEngine")}
          </button>
        </div>
      );
    case "mcp":
      return (
        <div className="gate-fix">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="gate-mcp"
            disabled={setPlugin.isPending}
            onClick={() => setPlugin.mutate({ id: "mcp", enabled: true }, { onSuccess: () => setTimeout(() => onRetry(), 500), onError: fail })}
          >
            {t("codeLink.gateTurnOnMcp")}
          </button>
        </div>
      );
    case "locked": {
      const item = items.data?.find((i) => i.id === itemId);
      return item ? (
        <div className="gate-fix">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="gate-unlock"
            disabled={patch.isPending}
            onClick={() => patch.mutate({ id: item.id, patch: { humanLocked: false }, baseVersion: item.version }, { onSuccess: () => onRetry(), onError: fail })}
          >
            {t("codeLink.gateUnlock")}
          </button>
        </div>
      ) : null;
    }
    case "blocked":
      return (
        <div className="gate-fix">
          <button type="button" className="btn btn-primary" onClick={() => onRetry(true)}>
            {t("codeLink.startAnyway")}
          </button>
        </div>
      );
    case "readiness":
      return failure.bootstrapKey && (onStartFirst || onOpenIssue) ? (
        <div className="gate-fix" data-testid="gate-fix-readiness">
          {onStartFirst && (
            <button type="button" className="btn btn-primary" onClick={() => onStartFirst(failure.bootstrapKey!)}>
              {t("codeLink.gateStartBootstrapFirst", { key: failure.bootstrapKey })}
            </button>
          )}
          {onOpenIssue && (
            <button type="button" className={onStartFirst ? "btn btn-ghost" : "btn btn-primary"} onClick={leave(() => onOpenIssue(failure.bootstrapKey!))}>
              {t("codeLink.gateOpenBootstrap", { key: failure.bootstrapKey })}
            </button>
          )}
        </div>
      ) : null;
    default:
      return null;
  }
}
