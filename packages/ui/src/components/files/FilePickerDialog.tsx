import { useState } from "react";
import type { FileEntry } from "@tomradex/files";
import { Icon } from "~/components/icons";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { useFilesTree } from "~/lib/files";
import { useI18n } from "~/lib/i18n";
import { pickFiles } from "~/lib/shell";
import { readableError } from "~/lib/toast";
import { isCommitKey } from "~/lib/keys";

/**
 * Choose project files. What comes back are entries; the caller pins their
 * latest versions together. With a `landing` folder, the files already there
 * come first and new ones can be brought in from this machine to land in it.
 */
export function FilePickerDialog({ projectId, open, onOpenChange, title, busy, onPick, landing, onImport }: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void; title: string; busy?: boolean; onPick: (entries: FileEntry[]) => void; landing?: string | null; onImport?: (sources: string[]) => void }) {
  const { t } = useI18n();
  const tree = useFilesTree(projectId);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const needle = filter.trim().toLowerCase();
  const lands = (entry: FileEntry) => !!landing && entry.path.startsWith(`${landing}/`);
  const files = (tree.data ?? [])
    .filter((e) => e.kind === "file" && (!needle || e.path.toLowerCase().includes(needle)))
    .sort((a, b) => Number(lands(b)) - Number(lands(a)))
    .slice(0, 60);
  const importFromDisk = async () => {
    const chosen = await pickFiles(t("files.pickFilesTitle"), t("files.pickFilesButton"), "files");
    if (chosen?.length) onImport?.(chosen);
  };
  const chosen = (tree.data ?? []).filter(entry => selected.has(entry.path));
  const toggle = (entry: FileEntry) => setSelected(current => {
    const next = new Set(current);
    if (next.has(entry.path)) next.delete(entry.path);
    else next.add(entry.path);
    return next;
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={title}>
      <DialogHead title={title} />
      <DialogBody className="stack-3">
        <input
          className="input"
          autoFocus
          data-testid="file-picker-filter"
          placeholder={t("files.pickFilter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (isCommitKey(e) && files[0]) toggle(files[0]);
          }}
        />
        <div className="stack-1 file-picker-list" style={{ maxHeight: 320, overflowY: "auto" }}>
          {files.map((entry) => (
            <button key={entry.path} type="button" className="menu-row" data-file={entry.path} role="checkbox" aria-checked={selected.has(entry.path)} disabled={busy} onClick={() => toggle(entry)}>
              <span className="menu-row__check">
                <Icon name="i-check" size={10} />
              </span>
              <span className="m-stack">
                <span className="m-name">{entry.name}</span>
                {entry.path !== entry.name && <span className="m-sub num">{entry.path}</span>}
              </span>
            </button>
          ))}
          {!files.length && !tree.isLoading && <p className="meta-txt dense">{tree.error ? readableError(tree.error) : t("files.pickEmpty")}</p>}
        </div>
        {landing && onImport && (
          <div className="row file-picker-landing" data-landing={landing}>
            <span className="meta-txt dense" style={{ marginRight: "auto" }}>{t("files.pickLanding", { dir: landing })}</span>
            <button type="button" className="btn btn-ghost file-picker-import" disabled={busy} onClick={() => void importFromDisk()}>
              <Icon name="i-file" size={13} />
              {t("files.pickFromDisk")}
            </button>
          </div>
        )}
      </DialogBody>
      <DialogFoot>
        <span className="meta-txt" style={{ marginRight: "auto" }}>{t("files.pickSelected", { n: selected.size })}</span>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onOpenChange(false)}>{t("files.cancel")}</button>
        <button type="button" className="btn btn-primary file-picker-add" disabled={busy || !chosen.length} onClick={() => onPick(chosen)}>{t("files.addSelected", { n: chosen.length })}</button>
      </DialogFoot>
    </Dialog>
  );
}
