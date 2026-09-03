import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { Eyebrow } from "~/components/ui/atoms";
import { useI18n } from "~/lib/i18n";
import { useCreateProject, useDbPath } from "~/lib/queries";

/** Prefix preview mirrors keyPrefixFor() in the domain: first three letters, uppercased. */
const previewPrefix = (name: string) => name.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) || "ISS";

export function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, tx } = useI18n();
  const create = useCreateProject();
  const dbPath = useDbPath();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  /** Blank means "derive it from the name" — and it is fixed from here on. */
  const [prefix, setPrefix] = useState("");
  const [error, setError] = useState(false);

  const key = prefix || previewPrefix(name);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return setError(true);
    create.mutate(
      { name: trimmed, description: description.trim() || null, keyPrefix: prefix || undefined },
      {
        onSuccess: (project) => {
          onOpenChange(false);
          setName("");
          setDescription("");
          setPrefix("");
          void navigate({ to: "/p/$projectId", params: { projectId: project.id } });
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={t("newProjectDialog.dialogLabel")}>
      <DialogHead title={t("newProjectDialog.dialogLabel")} />
      <DialogBody className="stack-4">
        <div className="field">
          <label htmlFor="npName">{t("newProjectDialog.projectNameLabel")}</label>
          <input
            id="npName"
            autoFocus
            className="input"
            autoComplete="off"
            placeholder={t("newProjectDialog.namePlaceholder")}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          {error ? (
            <span className="meta-txt" style={{ color: "var(--danger)" }}>
              {t("newProjectDialog.nameRequiredError")}
            </span>
          ) : (
            <span className="meta-txt">
              {tx("newProjectDialog.issueKeyPreview", { a: <span className="num">{key}-1</span>, b: <span className="num">{key}-2</span> })}
            </span>
          )}
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="npDesc">{t("newProjectDialog.descriptionLabel")}</label>
            <input
              id="npDesc"
              className="input"
              placeholder={t("newProjectDialog.descriptionPlaceholder")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="npPrefix">{t("newProjectDialog.issueKeyPrefixLabel")}</label>
            <input
              id="npPrefix"
              className="input num"
              placeholder={previewPrefix(name)}
              maxLength={6}
              value={prefix}
              // Sanitised here rather than refused later: the repository upper-cases
              // whatever it is handed and the key it makes is permanent.
              onChange={(e) => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
            />
            <span className="meta-txt">{t("newProjectDialog.prefixNote")}</span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="npFile">{t("newProjectDialog.storedOnMachineLabel")}</label>
          <input id="npFile" className="input num" readOnly value={dbPath.data ?? ""} />
          <span className="meta-txt">{t("newProjectDialog.storedNote")}</span>
        </div>
        <div>
          <Eyebrow>{t("newProjectDialog.createdWithProject")}</Eyebrow>
          <ul className="dash" style={{ marginTop: "var(--space-2)" }}>
            <li>{tx("newProjectDialog.mainBoardBullet", { main: <span className="num">Main</span> })}</li>
            <li>
              {tx("newProjectDialog.defaultViewsBullet", {
                views: <span className="num">Board · Table · Epics · Dependencies</span>
              })}
            </li>
          </ul>
        </div>
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-ghost" onClick={() => onOpenChange(false)}>
          {t("newProjectDialog.cancel")}
        </button>
        <button type="button" className="btn btn-primary" onClick={submit}>
          {t("newProjectDialog.createProject")}
        </button>
      </DialogFoot>
    </Dialog>
  );
}
