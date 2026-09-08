import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Icon } from "~/components/icons";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { Eyebrow } from "~/components/ui/atoms";
import { useI18n } from "~/lib/i18n";
import { useCreateProject, useHubInfo } from "~/lib/queries";
import { pickDirectory } from "~/lib/shell";
import { useToast } from "~/lib/toast";

/** Prefix preview mirrors keyPrefixFor() in the domain: first three letters, uppercased. */
const previewPrefix = (name: string) => name.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) || "ISS";

/** Mirrors the storage layer's slug: lowercase, runs of anything else become one dash. */
export const slugOf = (name: string) =>
  name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";

const joinPath = (base: string, ...parts: string[]) => {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return [base.replace(/[\\/]+$/, ""), ...parts].join(sep);
};

export function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, tx } = useI18n();
  const create = useCreateProject();
  const hub = useHubInfo();
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  /** Blank means "derive it from the name" — and it is fixed from here on. */
  const [prefix, setPrefix] = useState("");
  /** Null while the folder follows the name; once chosen or typed, it is the user's. */
  const [dirEdit, setDirEdit] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState(false);

  const key = prefix || previewPrefix(name);
  const suggested = hub.data?.dir ? joinPath(hub.data.dir, "projects", slugOf(name || "project")) : "";
  const dir = dirEdit ?? suggested;

  useEffect(() => {
    if (!open) setDirEdit(null);
  }, [open]);

  const choose = async () => {
    setPicking(true);
    const chosen = await pickDirectory(t("newProjectDialog.pickFolderTitle"), t("newProjectDialog.pickFolderButton"));
    setPicking(false);
    if (chosen) setDirEdit(chosen);
  };

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return setError(true);
    create.mutate(
      { input: { name: trimmed, description: description.trim() || null, keyPrefix: prefix || undefined }, dir: dir.trim() || undefined },
      {
        onSuccess: (project) => {
          onOpenChange(false);
          setName("");
          setDescription("");
          setPrefix("");
          setDirEdit(null);
          void navigate({ to: "/p/$projectId", params: { projectId: project.id } });
        },
        onError: (err) => toast({ body: err instanceof Error ? err.message : String(err) })
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
          <label htmlFor="npDir">{t("newProjectDialog.folderLabel")}</label>
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <input
              id="npDir"
              className="input num"
              style={{ flex: 1 }}
              autoComplete="off"
              spellCheck={false}
              placeholder={hub.data?.dir ? "" : t("newProjectDialog.folderPlaceholderNoHub")}
              value={dir}
              onChange={(e) => setDirEdit(e.target.value)}
            />
            <button type="button" className="btn btn-secondary" disabled={picking} onClick={() => void choose()}>
              <Icon name="i-search" size={13} />
              {picking ? t("newProjectDialog.choosing") : t("newProjectDialog.choose")}
            </button>
          </div>
          <span className="meta-txt">{t("newProjectDialog.folderNote")}</span>
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
        <button type="button" className="btn btn-primary" disabled={create.isPending} onClick={submit}>
          {t("newProjectDialog.createProject")}
        </button>
      </DialogFoot>
    </Dialog>
  );
}
