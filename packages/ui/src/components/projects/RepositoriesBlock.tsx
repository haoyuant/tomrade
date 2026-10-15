import { useEffect, useRef, useState } from "react";
import type { MergeCheckView, RepoStateView } from "@tomradex/code-link";
import type { Board, Repo } from "@tomradex/domain";
import type { CheckoutView, FolderRepo } from "@tomradex/repos";
import { Icon } from "~/components/icons";
import { Eyebrow } from "~/components/ui/atoms";
import { useAllowMerge, useGithubCredential, useGithubCredentialAccount, useMergeChecks, useRemoteIdentity, useRepoStates, useSetRepoPolicy } from "~/lib/codeLink";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { normalizeRemote } from "~/lib/remotes";
import {
  useAddRepoFromFolder,
  useBoards,
  useClearCheckout,
  useCloneRepoInto,
  useCreateRepo,
  useRemoveRepo,
  useRepoCheckouts,
  useRepos,
  useSelectCheckout,
  useSetRunInCheckout,
  useUpdateBoard,
  useUpdateRepo
} from "~/lib/queries";
import { pickDirectory, reveal } from "~/lib/shell";
import { useToast } from "~/lib/toast";
import { message } from "./destination";

/** Enter or blur commits, Escape restores — the one-line rename the Fields sheet uses. */
function RenameInput({ value, ariaLabel, className, placeholder, onSave }: { value: string; ariaLabel: string; className?: string; placeholder?: string; onSave: (next: string) => void }) {
  const settled = useRef(false);
  const commit = (el: HTMLInputElement) => {
    if (settled.current) return;
    settled.current = true;
    const next = el.value.trim();
    if (next && next !== value) onSave(next);
    else el.value = value;
  };
  return (
    <input
      key={value}
      className={className ?? "input"}
      aria-label={ariaLabel}
      placeholder={placeholder}
      defaultValue={value}
      onFocus={() => {
        settled.current = false;
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          e.currentTarget.value = value;
          settled.current = true;
          e.currentTarget.blur();
        }
        if (e.key === "Enter") commit(e.currentTarget);
      }}
      onBlur={(e) => commit(e.currentTarget)}
    />
  );
}

/** Pick a folder and add the repository in it: by its origin, or as a local repository when it has none. */
export function useChooseRepoFolder(projectId: string) {
  const { t } = useI18n();
  const toast = useToast();
  const add = useAddRepoFromFolder(projectId);
  const [picking, setPicking] = useState(false);
  const choose = async (): Promise<FolderRepo | null> => {
    setPicking(true);
    const dir = await pickDirectory(t("repositories.addFolderTitle"), t("repositories.pickButton"));
    setPicking(false);
    if (!dir) return null;
    try {
      const added = await add.mutateAsync(dir);
      const key = added.existing ? "repositories.checkoutSetToast" : added.local ? "repositories.addedLocalToast" : "repositories.addedToast";
      toast({ body: t(key, { name: added.repo.name, dir: added.view.checkout ?? dir }) });
      return added;
    } catch (error) {
      toast({ body: message(error) });
      return null;
    }
  };
  return { choose, busy: picking || add.isPending };
}

/**
 * The code a project's workstreams stand for. The URL is a project row and
 * travels; the checkout is this machine's alone and is verified against the
 * folder's own origin before it is believed.
 */
export function RepositoriesBlock({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const repos = useRepos(projectId);
  const boards = useBoards(projectId);
  const checkouts = useRepoCheckouts();
  const states = useRepoStates(projectId);
  const create = useCreateRepo(projectId);
  const folder = useChooseRepoFolder(projectId);
  const updateBoard = useUpdateBoard(projectId);
  const toast = useToast();
  const [url, setUrl] = useState("");

  // A new repository serves the one workstream that has none, when there is exactly one: said, and changed below it.
  const autoLink = (repo: Repo) => {
    const unlinked = (boards.data ?? []).filter((b) => !b.repoId);
    if (unlinked.length !== 1) return;
    const board = unlinked[0]!;
    updateBoard.mutate({ id: board.id, patch: { repoId: repo.id, repoPath: "" } }, { onSuccess: () => toast({ body: t("repositories.linkedToast", { repo: repo.name, board: board.name }) }) });
  };

  const add = () => {
    const remote = url.trim();
    if (!remote || create.isPending) return;
    create.mutate(
      { remote },
      {
        onSuccess: (repo) => {
          setUrl("");
          toast({ body: t("repositories.addedToast", { name: repo.name }) });
          autoLink(repo);
        },
        onError: (error) => toast({ body: message(error) })
      }
    );
  };

  const byRemote = new Map((checkouts.data ?? []).map((c) => [c.remote, c]));

  return (
    <div className="repos-block project-settings-copy" id="psRepos">
      <Eyebrow>{t("repositories.label")}</Eyebrow>
      <p className="meta-txt dense">
        {t("repositories.note")}
      </p>
      <div className="project-settings-fields">
        {(repos.data ?? []).length === 0 && <p className="meta-txt dense repos-none">{t("repositories.none")}</p>}
        {(repos.data ?? []).map((repo) => (
          <RepoRow
            key={repo.id}
            repo={repo}
            projectId={projectId}
            boards={boards.data ?? []}
            checkout={byRemote.get(normalizeRemote(repo.remote)) ?? null}
            remoteState={(states.data ?? []).find((state) => state.repoId === repo.id) ?? null}
          />
        ))}
      </div>
      <div className="row repos-add" style={{ gap: "var(--space-2)" }}>
        <input
          className="input num"
          style={{ flex: 1 }}
          aria-label={t("repositories.addAria")}
          placeholder={t("repositories.addPlaceholder")}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <button type="button" className="btn btn-ghost" disabled={!url.trim() || create.isPending} onClick={add}>
          <Icon name="i-plus" size={13} /> {t("repositories.add")}
        </button>
        <button type="button" className="btn btn-ghost repos-add-folder" disabled={folder.busy} onClick={() => void folder.choose().then((added) => added && !added.existing && autoLink(added.repo))}>
          <Icon name="i-folder" size={13} /> {folder.busy ? t("repositories.choosing") : t("repositories.addFolder")}
        </button>
      </div>
    </div>
  );
}

function RepoRow({ repo, projectId, boards, checkout, remoteState }: { repo: Repo; projectId: string; boards: Board[]; checkout: CheckoutView | null; remoteState: RepoStateView | null }) {
  const { t } = useI18n();
  const toast = useToast();
  const update = useUpdateRepo(projectId);
  const updateBoard = useUpdateBoard(projectId);
  const repoNames = useRepos(projectId).data ?? [];
  const remove = useRemoveRepo(projectId);
  const selectCheckout = useSelectCheckout();
  const clearCheckout = useClearCheckout();
  const setRun = useSetRunInCheckout();
  const clone = useCloneRepoInto();
  const identity = useRemoteIdentity(repo.remote, !!checkout?.checkout);
  const account = useGithubCredentialAccount(projectId, repo.id, !!checkout?.checkout && remoteState?.remote === "unreachable");
  const useCredential = useGithubCredential(projectId, repo.remote);
  const [picking, setPicking] = useState(false);
  const [cloneTarget, setCloneTarget] = useState<{ parent: string; dir: string; origin?: string } | null>(null);
  useEffect(() => {
    if (checkout?.checkout) setCloneTarget(null);
  }, [checkout?.checkout]);
  const busy = update.isPending || remove.isPending || selectCheckout.isPending || clearCheckout.isPending || setRun.isPending || clone.isPending || useCredential.isPending;
  const fail = (error: unknown) => toast({ body: message(error) });

  const choose = async () => {
    setPicking(true);
    const dir = await pickDirectory(t("repositories.pickTitle", { name: repo.name }), t("repositories.pickButton"));
    setPicking(false);
    if (!dir) return;
    selectCheckout.mutate(
      { remote: repo.remote, dir },
      {
        onSuccess: (selection) => {
          if (selection.state === "clone") {
            setCloneTarget({ parent: selection.parent, dir: selection.dir, origin: selection.origin });
            return;
          }
          setCloneTarget(null);
          toast({ body: t("repositories.checkoutSetToast", { name: repo.name, dir: selection.view.checkout ?? dir }) });
        },
        onError: (error) => {
          setCloneTarget(null);
          fail(error);
        }
      }
    );
  };

  const cloneNow = () =>
    cloneTarget && clone.mutate(
      { remote: repo.remote, branch: repo.defaultBranch, parent: cloneTarget.parent },
      {
        onSuccess: (view) => {
          setCloneTarget(null);
          toast({ body: t("repositories.clonedToast", { name: repo.name, dir: view.checkout ?? "" }) });
        },
        onError: fail
      }
    );

  return (
    <div className="panel repo-row project-settings-copy" data-repo={repo.id} style={{ padding: "var(--space-3)" }}>
      <div className="row" style={{ gap: "var(--space-2)", alignItems: "center" }}>
        <Icon name="i-plug" size={14} style={{ color: "var(--accent)", flexShrink: 0 }} />
        <span className="repo-name" style={{ fontFamily: "var(--font-display)", fontSize: 14, flexShrink: 0 }}>
          {repo.name}
        </span>
        <span className="meta-txt num repo-remote" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={repo.remote}>
          {repo.remote}
        </span>
        <RenameInput
          value={repo.defaultBranch}
          ariaLabel={t("repositories.branchAria", { name: repo.name })}
          className="input num repo-branch"
          onSave={(defaultBranch) => update.mutate({ id: repo.id, patch: { defaultBranch } }, { onError: fail })}
        />
        <button
          type="button"
          className="btn btn-icon repo-remove"
          title={t("repositories.removeTitle", { name: repo.name })}
          aria-label={t("repositories.removeTitle", { name: repo.name })}
          disabled={busy}
          onClick={() => remove.mutate(repo.id, { onSuccess: () => toast({ body: t("repositories.removedToast", { name: repo.name }) }), onError: fail })}
        >
          <Icon name="i-close" size={13} />
        </button>
      </div>
      {/* which workstreams' tickets are coded here: one click each way, a workstream on another repository moves over */}
      <div className="repo-workstreams" data-testid="repo-workstreams">
        <span className="meta-txt">{t("repositories.workstreamsLabel")}</span>
        {boards.map((b) => {
          const on = b.repoId === repo.id;
          const other = !on && b.repoId ? repoNames.find((r) => r.id === b.repoId)?.name : undefined;
          return (
            <button
              key={b.id}
              type="button"
              className={on ? "chip-opt sel" : "chip-opt"}
              aria-pressed={on}
              data-board={b.id}
              title={other ? t("repositories.workstreamElsewhere", { name: other }) : undefined}
              disabled={updateBoard.isPending}
              onClick={() => updateBoard.mutate({ id: b.id, patch: on ? { repoId: null, repoPath: "" } : { repoId: repo.id, repoPath: "" } }, { onError: fail })}
            >
              {on ? "✓ " : ""}
              {b.name}
            </button>
          );
        })}
      </div>
      {!boards.some((b) => b.repoId === repo.id) && <p className="meta-txt dense repo-used">{t("repositories.workstreamsHint")}</p>}
      {checkout?.checkout && remoteState && (
        <div className="cfg-row repo-remote-state" style={{ marginTop: 0 }} title={remoteState.remoteDetail ?? undefined}>
          <Icon
            name={remoteState.remote === "ok" ? "i-check" : remoteState.remote === "unreachable" ? "i-warn" : remoteState.remote === "none" ? "i-folder" : "i-clock"}
            size={14}
            style={{ color: remoteState.remote === "unreachable" ? "var(--danger)" : remoteState.remote === "ok" ? "var(--accent)" : "var(--meta)" }}
          />
          <span className="repo-remote-copy">
            <span className="cfg-name">
              {remoteState.remote === "ok"
                ? t("repositories.remoteOk")
                : remoteState.remote === "unreachable"
                  ? t("repositories.remoteUnreachable")
                  : remoteState.remote === "none"
                    ? t("repositories.remoteNone")
                    : t("repositories.remoteUnknown")}
            </span>
            {remoteState.remoteDetail && <span className="meta-txt num repo-remote-detail">{remoteState.remoteDetail}</span>}
            {remoteState.remote === "none" && <span className="meta-txt repo-remote-detail">{t("repositories.remoteNoneNote", { branch: repo.defaultBranch })}</span>}
          </span>
        </div>
      )}
      {checkout?.checkout && identity.data?.host && (
        <p className="meta-txt dense repo-identity" title={identity.data.host}>
          {identity.data.login
            ? t("repositories.remoteIdentity", { login: identity.data.login })
            : identity.data.tomrade
              ? t("repositories.tomradeAccountMissing")
              : t("repositories.noCredential", { host: identity.data.host })}
        </p>
      )}
      {checkout?.checkout && remoteState?.remote === "unreachable" && account.data && (
        <button
          type="button"
          className="btn btn-secondary repo-use-credential"
          disabled={busy}
          onClick={() => useCredential.mutate(repo.id, {
            onSuccess: (state) => toast({ body: t(state.remote === "ok" ? "repositories.credentialConnected" : "repositories.credentialStillUnreachable") }),
            onError: fail
          })}
        >
          {useCredential.isPending ? t("repositories.credentialChecking") : t("repositories.useGithubCredential", { account: account.data })}
        </button>
      )}
      <div className="cfg-row repo-checkout" style={{ marginTop: 0 }}>
        <Icon name={checkout?.checkout ? "i-check" : "i-warn"} size={14} style={{ color: checkout?.checkout ? "var(--accent)" : "var(--danger)" }} />
        <span className="cfg-name num" style={{ fontFamily: "var(--font-mono)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={checkout?.checkout ?? ""}>
          {checkout?.checkout ?? t("repositories.notSet")}
        </span>
        <button type="button" className="btn btn-ghost repo-choose" disabled={busy || picking} onClick={() => void choose()}>
          {picking ? t("repositories.choosing") : t("repositories.choose")}
        </button>
        {checkout?.checkout && (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => clearCheckout.mutate(repo.remote, { onError: fail })}>
            {t("repositories.clear")}
          </button>
        )}
      </div>
      {!checkout?.checkout && cloneTarget && (
        <div className="cfg-row repo-clone-offer" style={{ marginTop: 0 }}>
          <Icon name="i-folder" size={14} style={{ color: "var(--meta)" }} />
          <span className="repo-remote-copy">
            <span className="cfg-name">{cloneTarget.origin ? t("repositories.cloneOfferOther", { name: repo.name, origin: cloneTarget.origin }) : t("repositories.cloneOffer", { name: repo.name })}</span>
            <span className="meta-txt num repo-clone-target" title={cloneTarget.dir}>{cloneTarget.dir}</span>
          </span>
          <button type="button" className="btn btn-secondary repo-clone" disabled={busy} onClick={cloneNow}>
            {clone.isPending ? t("repositories.cloning") : t("repositories.cloneIntoFolder")}
          </button>
        </div>
      )}
      {checkout?.checkout && (
        <div className="cfg-row" style={{ marginTop: 0 }}>
          <Icon name="i-pen" size={14} style={{ color: checkout.runInCheckout ? "var(--accent)" : "var(--meta)" }} />
          <span className="cfg-name">{t("repositories.runInCheckout")}</span>
          <button
            type="button"
            className="switch repo-run-in"
            role="switch"
            aria-checked={checkout.runInCheckout}
            aria-label={t("repositories.runInCheckout")}
            disabled={busy}
            onClick={() => setRun.mutate({ remote: repo.remote, on: !checkout.runInCheckout }, { onError: fail })}
          />
        </div>
      )}
      {checkout?.checkout && <p className="meta-txt dense">{t("repositories.runInCheckoutNote")}</p>}
      {remoteState?.remote !== "none" && <AgentMerge projectId={projectId} repoId={repo.id} on={remoteState?.agentMerge ?? false} />}
    </div>
  );
}

/** The repository's merge policy, and what each agent's own settings say about it — with the one rule that would let it. */
function AgentMerge({ projectId, repoId, on }: { projectId: string; repoId: string; on: boolean }) {
  const { t } = useI18n();
  const policy = useSetRepoPolicy(projectId);
  const checks = useMergeChecks(projectId, repoId, on);
  const toast = useToast();
  return (
    <>
      <div className="cfg-row" style={{ marginTop: 0 }}>
        <Icon name="i-merge" size={14} style={{ color: on ? "var(--accent)" : "var(--meta)" }} />
        <span className="cfg-name">{t("repositories.agentMerge")}</span>
        <button
          type="button"
          className="switch repo-agent-merge"
          role="switch"
          aria-checked={on}
          aria-label={t("repositories.agentMerge")}
          disabled={policy.isPending}
          onClick={() => policy.mutate({ repoId, patch: { agentMerge: !on } }, { onError: (error) => toast({ body: message(error) }) })}
        />
      </div>
      <p className="meta-txt dense">{t("repositories.agentMergeNote")}</p>
      {on && checks.isLoading && <p className="meta-txt dense repo-merge-checking">{t("repositories.mergeChecking")}</p>}
      {on && checks.data?.length === 0 && <p className="meta-txt dense">{t("repositories.mergeNoEngines")}</p>}
      {on && checks.data?.map((view) => <MergeCheckRow key={view.engine} projectId={projectId} repoId={repoId} view={view} />)}
    </>
  );
}

function MergeCheckRow({ projectId, repoId, view }: { projectId: string; repoId: string; view: MergeCheckView }) {
  const { t } = useI18n();
  const toast = useToast();
  const allow = useAllowMerge(projectId, repoId);
  const check = view.check;
  const vars = { engine: view.title, rule: check?.rule?.rule ?? check?.fix?.rule ?? "", file: check?.rule?.file ?? check?.fix?.file ?? "" };
  const state = check?.state ?? "unknown";
  return (
    <div className="cfg-row repo-merge-check" data-engine={view.engine} data-state={state} style={{ marginTop: 0 }}>
      <Icon
        name={state === "allowed" ? "i-check" : state === "blocked" ? "i-warn" : "i-clock"}
        size={14}
        style={{ color: state === "allowed" ? "var(--accent)" : state === "blocked" ? "var(--danger)" : "var(--meta)" }}
      />
      <span className="repo-remote-copy">
        <span className="cfg-name">{check ? t(`repositories.mergeWhy_${check.why}` as MessageKey, vars) : t("repositories.mergeUnknown", vars)}</span>
      </span>
      {check?.rule && (
        <button type="button" className="btn btn-ghost" onClick={() => reveal(check.rule!.file)}>
          {t("repositories.mergeShowFile")}
        </button>
      )}
      {check?.fix && (
        <button
          type="button"
          className="btn btn-secondary repo-merge-fix"
          disabled={allow.isPending}
          onClick={() =>
            allow.mutate(view.engine, {
              onSuccess: (next) => {
                const fix = { engine: view.title, rule: check.fix!.rule, file: check.fix!.file };
                toast({ body: t(next.check?.state === "allowed" ? "repositories.mergeFixedToast" : "repositories.mergeStillBlockedToast", fix) });
              },
              onError: (error) => toast({ body: message(error) })
            })
          }
        >
          {allow.isPending ? t("repositories.mergeFixing") : t("repositories.mergeFix", { rule: check.fix.rule, file: check.fix.file })}
        </button>
      )}
    </div>
  );
}
