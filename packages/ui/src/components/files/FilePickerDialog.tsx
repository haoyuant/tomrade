import { useState } from "react";
import type { FileEntry } from "@tomrade/files";
import { Icon } from "~/components/icons";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { useFilesTree } from "~/lib/files";
import { useI18n } from "~/lib/i18n";

/** Choose project files. What comes back are entries; the caller pins their latest versions together. */
export function FilePickerDialog({ projectId, open, onOpenChange, title, busy, onPick }: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void; title: string; busy?: boolean; onPick: (entries: FileEntry[]) => void }) {
  const { t } = useI18n();
  const tree = useFilesTree(projectId);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const needle = filter.trim().toLowerCase();
  const files = (tree.data ?? []).filter((e) => e.kind === "file" && (!needle || e.path.toLowerCase().includes(needle))).slice(0, 60);
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
            if (e.key === "Enter" && files[0]) toggle(files[0]);
          }}
        />
        <div className="stack-1 file-picker-list" style={{ maxHeight: 320, overflowY: "auto" }}>
          {files.map((entry) => (
            <button key={entry.path} type="button" className="menu-row" data-file={entry.path} role="checkbox" aria-checked={selected.has(entry.path)} disabled={busy} onClick={() => toggle(entry)}>
              <span className="chk">
                <Icon name="i-check" size={10} />
              </span>
              <span className="m-stack">
                <span className="m-name">{entry.name}</span>
                {entry.path !== entry.name && <span className="m-sub num">{entry.path}</span>}
              </span>
            </button>
          ))}
          {!files.length && !tree.isLoading && <p className="meta-txt dense">{tree.error ? tree.error.message : t("files.pickEmpty")}</p>}
        </div>
      </DialogBody>
      <DialogFoot>
        <span className="meta-txt" style={{ marginRight: "auto" }}>{t("files.pickSelected", { n: selected.size })}</span>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onOpenChange(false)}>{t("files.cancel")}</button>
        <button type="button" className="btn btn-primary file-picker-add" disabled={busy || !chosen.length} onClick={() => onPick(chosen)}>{t("files.addSelected", { n: chosen.length })}</button>
      </DialogFoot>
    </Dialog>
  );
}
