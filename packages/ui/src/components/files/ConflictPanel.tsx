import type { ConflictChoice, FileConflict } from "@tomrade/files";
import { Icon } from "~/components/icons";
import { Eyebrow } from "~/components/ui/atoms";
import { useI18n, type MessageKey } from "~/lib/i18n";

const KIND: Record<FileConflict["kind"], MessageKey> = {
  content: "files.kindContent",
  "add-add": "files.kindAddAdd",
  "modify-delete": "files.kindModifyDelete",
  "delete-modify": "files.kindDeleteModify"
};

function Side({ label, text }: { label: string; text: string | null }) {
  const { t } = useI18n();
  return (
    <div className="conflict-side">
      <Eyebrow>{label}</Eyebrow>
      {text === null ? <p className="meta-txt">{t("files.deletedSide")}</p> : <pre className="text-view">{text}</pre>}
    </div>
  );
}

/**
 * Both sides changed a file and git could not settle it. The panel shows each
 * side whole and takes one decision; nothing is chosen for the person.
 */
export function ConflictPanel({ conflict, busy, onChoose }: { conflict: FileConflict; busy: boolean; onChoose: (choice: ConflictChoice) => void }) {
  const { t } = useI18n();
  const twoSided = conflict.kind === "content" || conflict.kind === "add-add";
  return (
    <div className="conflict-panel stack-3" data-testid="conflict-panel">
      <div className="dangerbar">
        <Icon className="b-mark" name="i-warn" size={15} />
        <p style={{ fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--fg-2)" }}>
          {t(KIND[conflict.kind])}
          {conflict.binary ? ` ${t("files.binaryConflict")}` : ""}
        </p>
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button type="button" className="btn btn-secondary conflict-mine" disabled={busy} onClick={() => onChoose("ours")}>
          {t("files.keepMine")}
        </button>
        <button type="button" className="btn btn-secondary conflict-theirs" disabled={busy} onClick={() => onChoose("theirs")}>
          {t("files.keepTheirs")}
        </button>
        {twoSided && (
          <button type="button" className="btn btn-ghost conflict-both" disabled={busy} onClick={() => onChoose("both")}>
            {t("files.keepBoth")}
          </button>
        )}
      </div>
      {!conflict.binary && (
        <div className="conflict-grid">
          <Side label={t("files.mine")} text={conflict.ours} />
          <Side label={t("files.theirs")} text={conflict.theirs} />
        </div>
      )}
    </div>
  );
}
