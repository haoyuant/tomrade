import type { AgentSettings, PlaybookSource } from "@tomradex/agent";
import type { AppSettings } from "@tomradex/domain";
import { useQueryClient } from "@tanstack/react-query";
import { usePlaybooks } from "~/lib/agent";
import { SectionHead, Tag } from "~/components/ui/atoms";
import { useI18n } from "~/lib/i18n";
import { keys } from "~/lib/queries";
import { PlaybookImport } from "./PlaybookImport";
import { ScopeTag } from "./ScopeTag";

const EMPTY_AGENT: AgentSettings = { defaultEngine: "tomrade", confirmWritesOver: 0, resumeAfterLimit: true, maxRunMinutes: 15, engines: {}, playbookChoices: {} };

/** The playbooks every engine follows: which version wins per id, and bringing in new ones. */
export function PlaybooksPane({ settings, onSave, scope }: { settings: AppSettings; onSave: (next: AppSettings) => void; scope?: "machine" | "user" }) {
  const { t } = useI18n();
  const agent = (settings.agent as AgentSettings | undefined) ?? EMPTY_AGENT;
  return (
    <>
      <SectionHead title={t("playbooks.settingsTitle")} aside={<ScopeTag scope={scope} />}>
        {t("playbooks.settingsLede")}
      </SectionHead>
      <div className="panel stack-3">
        <PlaybooksBlock agent={agent} onSave={(next) => onSave({ ...settings, agent: next })} />
        <hr className="rule" />
        <PlaybookImport />
      </div>
    </>
  );
}

/** Every registered playbook by id; an id carried by several sources grows a picker for which version wins. */
function PlaybooksBlock({ agent, onSave }: { agent: AgentSettings; onSave: (next: AgentSettings) => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const playbooks = usePlaybooks();
  const sourceTag: Record<PlaybookSource, string> = {
    plugin: t("playbooks.tagPlugin"),
    user: t("playbooks.tagUser"),
    project: t("playbooks.tagProject")
  };
  const choose = (id: string, source: PlaybookSource) => {
    onSave({ ...agent, playbookChoices: { ...agent.playbookChoices, [id]: source } });
    void qc.invalidateQueries({ queryKey: keys.agent.playbooksAll });
  };
  if (!playbooks.data?.length) return <p className="meta-txt">{t("playbooks.settingsEmpty")}</p>;
  return (
    <>
      {playbooks.data.map((entry) => (
        <div className="profile-row" key={entry.id}>
          <span className="p-title">{entry.title}</span>
          <span className="p-model num">{entry.id}</span>
          {entry.origin && (
            <span className="meta-txt num" title={entry.origin.source ? t("playbooks.importedFrom", { source: entry.origin.source }) : undefined}>
              {t("playbooks.versionTag", { n: entry.origin.version })}
            </span>
          )}
          {entry.shadows.length ? (
            <select
              className="input"
              style={{ maxWidth: 220 }}
              aria-label={t("playbooks.versionLabel")}
              value={entry.source}
              onChange={(e) => choose(entry.id, e.target.value as PlaybookSource)}
            >
              {[entry.source, ...entry.shadows].map((source) => (
                <option key={source} value={source}>
                  {sourceTag[source]}
                </option>
              ))}
            </select>
          ) : (
            <Tag tone="neutral">{sourceTag[entry.source]}</Tag>
          )}
        </div>
      ))}
    </>
  );
}

