import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { Eyebrow } from "~/components/ui/atoms";
import { useCreateProject, useDbPath } from "~/lib/queries";

/** Prefix preview mirrors keyPrefixFor() in the domain: first three letters, uppercased. */
const previewPrefix = (name: string) => name.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) || "ISS";

export function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
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
    <Dialog open={open} onOpenChange={onOpenChange} label="New project">
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
              Issues will be keyed <span className="num">{key}-1</span>, <span className="num">{key}-2</span>, …
            </span>
          )}
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="npDesc">Description</label>
            <input id="npDesc" className="input" placeholder="What this workspace is for" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="npPrefix">Issue key prefix</label>
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
            <span className="meta-txt">Derived from the name if left blank, and fixed once the project exists.</span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="npFile">Stored on this machine</label>
          <input id="npFile" className="input num" readOnly value={dbPath.data ?? ""} />
          <span className="meta-txt">
            Every project lives in this file to begin with. Give it a destination — a folder, or a git repository — in its own settings, and it
            publishes a copy of itself there as text.
          </span>
        </div>
        <div>
          <Eyebrow>Created with the project</Eyebrow>
          <ul className="dash" style={{ marginTop: "var(--space-2)" }}>
            <li>
              A <span className="num">Main</span> board, with the view every board is guaranteed to have
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
