import { useCallback, useState } from "react";
import type { ChangedFile, ChangeScope } from "@tomradex/code-link";
import { Icon } from "~/components/icons";
import { Dialog, DialogHead } from "~/components/ui/dialog";
import { scopeOf, scopeValue, useChanges, type ChangesSource } from "~/lib/changes";
import { intlTag } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { DiffView } from "./DiffView";

const BRANCH: ChangeScope = { kind: "branch" };

/**
 * A ticket's changes with what chooses them: the code link when it has several, and the scope (its branch against
 * the base, the working tree where one is here, or one commit). The diff itself is `DiffView`'s.
 */
export function TicketChanges({ source, viewedKey, onNotice }: { source: ChangesSource; viewedKey: string; onNotice: (text: string) => void }) {
  const { t, locale } = useI18n();
  const [linkId, setLinkId] = useState<string>();
  const [scope, setScope] = useState<ChangeScope>(BRANCH);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const read = useChanges(source, { linkId, scope, ignoreWhitespace });
  const changes = read.data;
  // What is shown says which scope it is of: an ask this machine cannot answer comes back as the branch.
  const shownScope = changes?.scope ?? scope;
  const shownLink = changes?.linkId;

  const onLoadFile = useCallback(
    (path: string, opts?: { full?: boolean }) => source.file({ linkId: shownLink, scope: shownScope, ignoreWhitespace, path, full: opts?.full }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, shownLink, scopeValue(shownScope), ignoreWhitespace]
  );

  const open = (file: ChangedFile) =>
    source.open({ linkId: shownLink, path: file.path }).then(
      (where) => onNotice(where === null ? t("diff.openMissing") : where === "system" ? t("diff.openedSystem") : t("diff.openedEditor", { editor: where === "cursor" ? "Cursor" : "VS Code" })),
      () => onNotice(t("diff.openMissing"))
    );

  const day = (at: number) => new Date(at).toLocaleDateString(intlTag(locale), { month: "short", day: "numeric" });
  const toolbar = changes ? (
    <>
      {changes.links.length > 1 && (
        <select className="input diff__pick" aria-label={t("diff.linkLabel")} data-testid="changes-link" value={changes.linkId} onChange={(e) => { setLinkId(e.target.value); setScope(BRANCH); }}>
          {changes.links.map((l) => (
            <option key={l.id} value={l.id}>
              {l.repoName ? `${l.repoName} · ${l.branch}` : l.branch}
            </option>
          ))}
        </select>
      )}
      <select className="input diff__pick" aria-label={t("diff.scopeLabel")} data-testid="changes-scope" value={scopeValue(shownScope)} onChange={(e) => setScope(scopeOf(e.target.value))}>
        <option value="branch">{t("diff.scopeBranch")}</option>
        {changes.scopes.includes("uncommitted") && <option value="uncommitted">{t("diff.scopeUncommitted")}</option>}
        {changes.commits.length > 0 && (
          <optgroup label={t("diff.scopeCommits", { count: changes.commits.length })}>
            {changes.commits.map((c) => (
              <option key={c.sha} value={`commit:${c.sha}`}>
                {`${c.sha.slice(0, 7)} ${c.subject} · ${day(c.at)}`}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </>
  ) : null;

  return (
    <DiffView
      changes={changes}
      loading={read.isFetching}
      ignoreWhitespace={ignoreWhitespace}
      onIgnoreWhitespace={setIgnoreWhitespace}
      onLoadFile={onLoadFile}
      viewedKey={viewedKey}
      toolbar={toolbar}
      fileActions={
        changes?.root
          ? (file) =>
              file.status === "deleted" ? null : (
                <button type="button" className="btn btn-icon" data-testid="changes-open" aria-label={t("diff.openInEditor")} title={t("diff.openInEditor")} onClick={() => void open(file)}>
                  <Icon name="i-popout" size={14} />
                </button>
              )
          : undefined
      }
    />
  );
}

/** A ticket's changes in a sheet wide enough to read a diff side by side. */
export function ChangesDialog({ open, onOpenChange, title, source, viewedKey, onNotice }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; source: ChangesSource; viewedKey: string; onNotice: (text: string) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={title} className="sheet-changes" resizable="changes" movable>
      <DialogHead title={title} />
      <div className="changes-sheet" data-testid="changes-sheet">
        <TicketChanges source={source} viewedKey={viewedKey} onNotice={onNotice} />
      </div>
    </Dialog>
  );
}
