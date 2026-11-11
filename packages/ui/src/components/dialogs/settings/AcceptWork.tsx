import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AcceptPolicy, Ceiling, DispatchDecision } from "@tomradex/dispatch";
import type { DeviceView } from "@tomradex/hub-cloud";
import { invoke, subscribe } from "~/lib/api";
import { agoLabel } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useProjects, useSaveSettings, useSettings, useSettingsSections } from "~/lib/queries";

const CEILINGS: Ceiling[] = ["read", "ask", "edits", "full"];
const DEFAULTS: AcceptPolicy = { accept: false, allProjects: true, projects: [], ceiling: "edits", maxConcurrent: 1, onlyWhenIdle: false, onlyOnPower: false };
const decisionsKey = ["dispatch", "decisions"] as const;

/**
 * Whether this computer takes tickets from the account's other computers, and within which limits. Off until
 * the person turns it on, and said plainly what that means: an agent runs here and changes code here.
 * Below it, the requests this computer took or turned away, with who asked.
 */
export function AcceptWork({ devices }: { devices: DeviceView[] }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const sections = useSettingsSections(locale);
  const settings = useSettings();
  const save = useSaveSettings();
  const projects = useProjects();
  const loaded = sections.data?.some((s) => s.id === "dispatch") ?? false;
  const decisions = useQuery({ queryKey: decisionsKey, queryFn: () => invoke("dispatch.decisions", 5), enabled: loaded });
  useEffect(() => subscribe("dispatch.changed", () => void qc.invalidateQueries({ queryKey: decisionsKey })), [qc]);
  if (!loaded || !settings.data) return null;
  const policy: AcceptPolicy = { ...DEFAULTS, ...((settings.data as Record<string, unknown>).dispatch as Partial<AcceptPolicy> | undefined) };
  const set = (patch: Partial<AcceptPolicy>) => save.mutate({ ...settings.data, dispatch: { ...policy, ...patch } } as typeof settings.data);
  const toggleProject = (id: string) => set({ projects: policy.projects.includes(id) ? policy.projects.filter((p) => p !== id) : [...policy.projects, id] });
  const nameOf = (id: string) => devices.find((d) => d.id === id)?.name ?? id;
  return (
    <div className="panel accept-work" data-testid="accept-work">
      <div className="accept-row">
        <div>
          <div className="accept-name">{t("devices.acceptTitle")}</div>
          <p className="meta-txt">{t("devices.acceptLede")}</p>
        </div>
        <button type="button" className="switch" role="switch" aria-checked={policy.accept} aria-label={t("devices.acceptTitle")} data-testid="accept-switch" disabled={save.isPending} onClick={() => set({ accept: !policy.accept })} />
      </div>
      {policy.accept && (
        <>
          <p className="accept-warning" role="note" data-testid="accept-warning">{t("devices.acceptWarning")}</p>
          <div className="accept-row">
            <div className="accept-name">{t("devices.acceptProjects")}</div>
            <select className="input" aria-label={t("devices.acceptProjects")} value={policy.allProjects ? "all" : "listed"} onChange={(e) => set({ allProjects: e.target.value === "all" })}>
              <option value="all">{t("devices.acceptProjectsAll")}</option>
              <option value="listed">{t("devices.acceptProjectsListed")}</option>
            </select>
          </div>
          {!policy.allProjects && (
            <div className="accept-projects" data-testid="accept-projects">
              {(projects.data ?? []).filter((p) => !p.archived).map((project) => (
                <label key={project.id} className="accept-project">
                  <input type="checkbox" checked={policy.projects.includes(project.id)} onChange={() => toggleProject(project.id)} />
                  <span>{project.name}</span>
                </label>
              ))}
            </div>
          )}
          <div className="accept-row">
            <div>
              <div className="accept-name">{t("devices.acceptCeiling")}</div>
              <p className="meta-txt">{t(`devices.ceilingHint_${policy.ceiling}` as MessageKey)}</p>
            </div>
            <select className="input" aria-label={t("devices.acceptCeiling")} data-testid="accept-ceiling" value={policy.ceiling} onChange={(e) => set({ ceiling: e.target.value as Ceiling })}>
              {CEILINGS.map((ceiling) => <option key={ceiling} value={ceiling}>{t(`devices.ceiling_${ceiling}` as MessageKey)}</option>)}
            </select>
          </div>
          <div className="accept-row">
            <div className="accept-name">{t("devices.acceptConcurrent")}</div>
            <select className="input" aria-label={t("devices.acceptConcurrent")} value={policy.maxConcurrent} onChange={(e) => set({ maxConcurrent: Number(e.target.value) })}>
              {[1, 2, 3, 4, 6, 8].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <label className="accept-check"><input type="checkbox" checked={policy.onlyWhenIdle} onChange={() => set({ onlyWhenIdle: !policy.onlyWhenIdle })} /><span>{t("devices.acceptIdle")}</span></label>
          <label className="accept-check"><input type="checkbox" checked={policy.onlyOnPower} onChange={() => set({ onlyOnPower: !policy.onlyOnPower })} /><span>{t("devices.acceptPower")}</span></label>
        </>
      )}
      {!!decisions.data?.length && (
        <div className="accept-log" data-testid="accept-log">
          <p className="device-work-head">{t("devices.acceptLog")}</p>
          {decisions.data.map((d: DispatchDecision, i) => (
            <div key={`${d.at}:${d.key}:${i}`} className="device-session">
              <span className="card-id">{d.key}</span>
              <span className="device-ticket">{d.accepted ? t("devices.acceptTook", { name: nameOf(d.from) }) : t("devices.acceptRefused", { name: nameOf(d.from), reason: t(`devices.refusal_${d.reason ?? "off"}` as MessageKey) })}</span>
              <span className="meta-txt">{agoLabel(d.at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
