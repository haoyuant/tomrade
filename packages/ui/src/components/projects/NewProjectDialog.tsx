import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { Eyebrow } from "~/components/ui/atoms";
import { useCreateProject, useDbPath } from "~/lib/queries";

/** Prefix preview mirrors keyPrefixFor() in core: first three letters, uppercased. */
const previewPrefix = (name: string) => name.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) || "ISS";

export function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const create = useCreateProject();
  const dbPath = useDbPath();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState(false);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return setError(true);
    create.mutate(
      { name: trimmed, description: description.trim() || null },
      {
        onSuccess: (project) => {
          onOpenChange(false);
          setName("");
          setDescription("");
          void navigate({ to: "/p/$projectId", params: { projectId: project.id } });
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label="New project" className="modal">
      <DialogHead title="New project" />
      <DialogBody className="stack-4">
        <div className="field">
          <label htmlFor="npName">Project name</label>
          <input
            id="npName"
            autoFocus
            className="input"
            autoComplete="off"
            placeholder="e.g. Tomrade Docs"
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
              A project needs a name.
            </span>
          ) : (
            <span className="meta-txt">
              Issues will be keyed <span className="num">{previewPrefix(name)}-1</span>, <span className="num">{previewPrefix(name)}-2</span>, …
            </span>
          )}
        </div>
        <div className="field">
          <label htmlFor="npDesc">Description</label>
          <input id="npDesc" className="input" placeholder="What this workspace is for" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="npFile">Database file</label>
          <input id="npFile" className="input num" readOnly value={dbPath.data ?? ""} />
          <span className="meta-txt">One SQLite file holds every project. Nothing leaves this machine.</span>
        </div>
        <div>
          <Eyebrow>Created with the project</Eyebrow>
          <ul className="dash" style={{ marginTop: "var(--space-2)" }}>
            <li>
              An <span className="num">All work</span> board, with the view every board is guaranteed to have
            </li>
            <li>
              Two cross-board scopes: <span className="num">Recently updated</span> and <span className="num">Epics</span>
            </li>
          </ul>
        </div>
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={submit}>
          Create project
        </button>
      </DialogFoot>
    </Dialog>
  );
}
