import { useRef, useState } from "react";
import type { RepoStateView } from "@tomrade/code-link";
import type { Board, Repo } from "@tomrade/domain";
import type { CheckoutView } from "@tomrade/repos";
import { Icon } from "~/components/icons";
import { Eyebrow } from "~/components/ui/atoms";
import { useRemoteIdentity, useRepoStates } from "~/lib/codeLink";
import { useI18n } from "~/lib/i18n";
import {
  useBoards,
  useClearCheckout,
  useCloneRepo,
  useCreateRepo,
  useRemoveRepo,
  useRepoCheckouts,
  useRepos,
  useSetCheckout,
  useSetRunInCheckout,
  useUpdateRepo
} from "~/lib/queries";
import { pickDirectory } from "~/lib/shell";
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

/** Two spellings of one repository read the same, so a checkout keyed by URL is found from any of them. */
const normalizeRemote = (remote: string): string => remote.trim().replace(/\/\/[^@/]*@/, "//").replace(/\/+$/, "").replace(/\.git$/, "");

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
  const toast = useToast();
  const [url, setUrl] = useState("");

  const add = () => {
    const remote = url.trim();
    if (!remote || create.isPending) return;
    create.mutate(
      { remote },
      {
        onSuccess: (repo) => {
          setUrl("");
          toast({ body: t("repositories.addedToast", { name: repo.name }) });
        },
        onError: (error) => toast({ body: message(error) })
      }
    );
  };

  const byRemote = new Map((checkouts.data ?? []).map((c) => [c.remote, c]));

  return (
    <div className="repos-block" id="psRepos">
      <Eyebrow>{t("repositories.label")}</Eyebrow>
      <p className="meta-txt dense" style={{ marginTop: 6 }}>
        {t("repositories.note")}
      </p>
      <div className="stack-2" style={{ marginTop: "var(--space-2)" }}>
        {(repos.data ?? []).length === 0 && <p className="meta-txt dense repos-none">{t("repositories.none")}</p>}
        {(repos.data ?? []).map((repo) => (
          <RepoRow
            key={repo.id}
            repo={repo}
            projectId={projectId}
            boards={(boards.data ?? []).filter((b) => b.repoId === repo.id)}
            checkout={byRemote.get(normalizeRemote(repo.remote)) ?? null}
            remoteState={(states.data ?? []).find((state) => state.repoId === repo.id) ?? null}
          />
        ))}
      </div>
      <div className="row repos-add" style={{ gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
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
      </div>
    </div>
  );
}

function RepoRow({ repo, projectId, boards, checkout, remoteState }: { repo: Repo; projectId: string; boards: Board[]; checkout: CheckoutView | null; remoteState: RepoStateView | null }) {
  const { t } = useI18n();
  const toast = useToast();
  const update = useUpdateRepo(projectId);
  const remove = useRemoveRepo(projectId);
  const setCheckout = useSetCheckout();
  const clearCheckout = useClearCheckout();
  const setRun = useSetRunInCheckout();
  const clone = useCloneRepo();
  const identity = useRemoteIdentity(repo.remote, !!checkout?.checkout);
  const [picking, setPicking] = useState(false);
  const busy = update.isPending || remove.isPending || setCheckout.isPending || clearCheckout.isPending || setRun.isPending || clone.isPending;
  const fail = (error: unknown) => toast({ body: message(error) });

  const choose = async () => {
    setPicking(true);
    const dir = await pickDirectory(t("repositories.pickTitle", { name: repo.name }), t("repositories.pickButton"));
    setPicking(false);
    if (!dir) return;
    setCheckout.mutate({ remote: repo.remote, dir }, { onSuccess: (view) => toast({ body: t("repositories.checkoutSetToast", { name: repo.name, dir: view.checkout ?? dir }) }), onError: fail });
  };

  const cloneNow = () =>
    clone.mutate({ remote: repo.remote, branch: repo.defaultBranch }, { onSuccess: (view) => toast({ body: t("repositories.clonedToast", { name: repo.name, dir: view.checkout ?? "" }) }), onError: fail });

  return (
    <div className="panel repo-row stack-2" data-repo={repo.id} style={{ padding: "var(--space-3)" }}>
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
      <p className="meta-txt dense repo-used">{boards.length ? t("repositories.usedBy", { names: boards.map((b) => b.name).join(", ") }) : t("repositories.usedByNone")}</p>
      {checkout?.checkout && remoteState && (
        <div className="cfg-row repo-remote-state" style={{ marginTop: 0 }} title={remoteState.remoteDetail ?? undefined}>
          <Icon name={remoteState.remote === "ok" ? "i-check" : remoteState.remote === "unreachable" ? "i-warn" : "i-clock"} size={14} style={{ color: remoteState.remote === "unreachable" ? "var(--danger)" : remoteState.remote === "ok" ? "var(--accent)" : "var(--meta)" }} />
          <span className="cfg-name">
            {remoteState.remote === "ok" ? t("repositories.remoteOk") : remoteState.remote === "unreachable" ? t("repositories.remoteUnreachable") : t("repositories.remoteUnknown")}
          </span>
          {remoteState.remoteDetail && <span className="meta-txt num" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{remoteState.remoteDetail}</span>}
        </div>
      )}
      {checkout?.checkout && identity.data?.host && (
        <p className="meta-txt dense repo-identity" title={identity.data.host}>
          {identity.data.login ? t("repositories.remoteIdentity", { login: identity.data.login }) : t("repositories.noCredential", { host: identity.data.host })}
        </p>
      )}
      <div className="cfg-row repo-checkout" style={{ marginTop: 0 }}>
        <Icon name={checkout?.checkout ? "i-check" : "i-warn"} size={14} style={{ color: checkout?.checkout ? "var(--accent)" : "var(--danger)" }} />
        <span className="cfg-name num" style={{ fontFamily: "var(--font-mono)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={checkout?.checkout ?? ""}>
          {checkout?.checkout ?? t("repositories.notSet")}
        </span>
        <button type="button" className="btn btn-ghost repo-choose" disabled={busy || picking} onClick={() => void choose()}>
          {picking ? t("repositories.choosing") : t("repositories.choose")}
        </button>
        {!checkout?.checkout && (
          <button type="button" className="btn btn-ghost repo-clone" disabled={busy} onClick={cloneNow}>
            {clone.isPending ? t("repositories.cloning") : t("repositories.cloneForMe")}
          </button>
        )}
        {checkout?.checkout && (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => clearCheckout.mutate(repo.remote, { onError: fail })}>
            {t("repositories.clear")}
          </button>
        )}
      </div>
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
    </div>
  );
}
