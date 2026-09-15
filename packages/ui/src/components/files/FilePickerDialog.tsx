import { useState } from "react";
import type { FileEntry } from "@tomrade/files";
import { Icon } from "~/components/icons";
import { Dialog, DialogBody, DialogHead } from "~/components/ui/dialog";
import { useFilesTree } from "~/lib/files";
import { useI18n } from "~/lib/i18n";

/** Choose one file of the project. What comes back is an entry; the caller pins its latest version. */
export function FilePickerDialog({ projectId, open, onOpenChange, title, busy, onPick }: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void; title: string; busy?: boolean; onPick: (entry: FileEntry) => void }) {
  const { t } = useI18n();
  const tree = useFilesTree(projectId);
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const files = (tree.data ?? []).filter((e) => e.kind === "file" && (!needle || e.path.toLowerCase().includes(needle))).slice(0, 60);
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
            if (e.key === "Enter" && files[0]) onPick(files[0]);
          }}
        />
        <div className="stack-1 file-picker-list" style={{ maxHeight: 320, overflowY: "auto" }}>
          {files.map((entry) => (
            <button key={entry.path} type="button" className="menu-row" data-file={entry.path} disabled={busy} onClick={() => onPick(entry)}>
              <span className="m-mark">
                <Icon name="i-file" size={13} />
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
    </Dialog>
  );
}
