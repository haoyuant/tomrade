import { useState } from "react";
import type { SkillPreview } from "@tomradex/agent";
import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { keys, useProjects } from "~/lib/queries";
import { reportError } from "~/lib/toast";

type Found = SkillPreview & { problem?: string };

/** Brings an existing SKILL.md folder in as a playbook: look first, then pick what to take and where it goes. */
export function PlaybookImport() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const projects = (useProjects().data ?? []).filter((p) => !p.archived);
  const [source, setSource] = useState("");
  // "user", or the id of the project the playbooks travel with
  const [into, setInto] = useState("user");
  const [found, setFound] = useState<Found[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const look = async () => {
    setBusy(true);
    setDone(null);
    try {
      const skills = await invoke("agent.previewPlaybookImport", source.trim());
      setFound(skills);
      setPicked(new Set(skills.filter((s) => !s.problem).map((s) => s.id)));
    } catch (error) {
      setFound(null);
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const result = await invoke("agent.importPlaybooks", {
        source: source.trim(),
        scope: into === "user" ? "user" : "project",
        projectId: into === "user" ? undefined : into,
        pick: [...picked]
      });
      await qc.invalidateQueries({ queryKey: keys.agent.playbooksAll });
      setDone(t("playbooks.importDone", { n: result.imported.length }));
      setFound(null);
      setSource("");
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) =>
    setPicked((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="stack-3" data-testid="playbook-import">
      <span className="p-title">{t("playbooks.importTitle")}</span>
      <span className="meta-txt">{t("playbooks.importLede")}</span>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (source.trim() && !busy) void look();
        }}
      >
        <input
          className="input"
          style={{ flex: 1 }}
          value={source}
          placeholder={t("playbooks.importPlaceholder")}
          aria-label={t("playbooks.importTitle")}
          onChange={(e) => {
            setSource(e.target.value);
            setFound(null);
          }}
        />
        <button type="submit" className="btn btn-ghost" disabled={!source.trim() || busy}>
          {t("playbooks.importFind")}
        </button>
      </form>
      {found && (
        <>
          {found.map((skill) => (
            <label className="profile-row" key={skill.id}>
              <input type="checkbox" checked={picked.has(skill.id)} disabled={!!skill.problem} onChange={() => toggle(skill.id)} />
              <span className="p-title">{skill.title}</span>
              <span className="p-model">{skill.problem ?? skill.when}</span>
              <span className="meta-txt num">{t("playbooks.importFiles", { n: skill.files.length })}</span>
            </label>
          ))}
          <div className="row">
            <span className="meta-txt">{t("playbooks.importInto")}</span>
            <select className="input" style={{ maxWidth: 260 }} aria-label={t("playbooks.importInto")} value={into} onChange={(e) => setInto(e.target.value)}>
              <option value="user">{t("playbooks.importScopeUser")}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {t("playbooks.importScopeProject", { name: p.name })}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-primary" disabled={!picked.size || busy} onClick={() => void save()}>
              {t("playbooks.importRun", { n: picked.size })}
            </button>
          </div>
        </>
      )}
      {done && <span className="meta-txt">{done}</span>}
    </div>
  );
}
