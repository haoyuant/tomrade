import { useEffect, useState, type ReactNode } from "react";
import type { AgentSettings, EnginePick, EngineView, PlaybookSource } from "@tomrade/agent";
import type { AppSettings } from "@tomrade/domain";
import type { ModelProfile, ModelsSettings } from "@tomrade/llm";
import { useQueryClient } from "@tanstack/react-query";
import { agentKeys, useEngines, usePlaybooks } from "~/lib/agent";
import type { SettingsSectionView } from "@tomrade/settings";
import { Icon, type IconId } from "~/components/icons";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { LanguageSwitch } from "~/components/ui/language-switch";
import { ThemeSwitch } from "~/components/ui/theme-switch";
import { HubPane } from "./HubPane";
import { PluginsPanel } from "./PluginsPanel";
import { Eyebrow, LiveDot, Num, SectionHead, Tag } from "~/components/ui/atoms";
import { SchemaField, fieldsOf, type JsonSchema } from "~/components/ui/schema-form";
import { STATUS } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useCacheDir, useHubInfo, useMcpUrl, useSaveSettings, useSettings, useSettingsSections, useStorageProviders } from "~/lib/queries";
import { reveal } from "~/lib/shell";

/** Each preview re-declares the token block locally, so all three themes are
 *  visible at once — the clearest proof that one class swaps the lot. */
function ThemePreview() {
  const { t } = useI18n();
  const modes = [
    { cls: "", nameKey: "theme.paper" as const, hex: "#f5f4ed" },
    { cls: "dark", nameKey: "theme.ink" as const, hex: "#141413" },
    { cls: "matcha", nameKey: "theme.matcha" as const, hex: "oklch .275 .022 142" }
  ];
  return (
    <div className="mode-grid" style={{ marginTop: "var(--space-5)" }}>
      {modes.map((m) => (
        <div className={`mode ${m.cls}`} key={m.nameKey}>
          <div className="mode-top">
            <span className="mode-name">{t(m.nameKey)}</span>
            <span className="mode-hex num">{m.hex}</span>
          </div>
          <div className="mini-col">
            <span className="mini-num">02</span>
            <span className="mini-lbl">{STATUS.doing.label}</span>
          </div>
          <div className="mini-card">
            <span />
            <span>
              <span className="mini-m">TOM-31</span>
              <br />
              <span className="mini-t">{t("settingsDialog.previewIssueA")}</span>
            </span>
          </div>
          <div className="mini-card">
            <span style={{ display: "flex", justifyContent: "center" }}>
              <span className="prov-tick" style={{ height: 12 }} />
            </span>
            <span>
              <span className="mini-m">TOM-142</span>
              <br />
              <span className="mini-t">{t("settingsDialog.previewIssueB")}</span>
            </span>
          </div>
          <div className="swatches">
            {["--surface", "--surface-warm", "--muted", "--accent"].map((tok) => (
              <span key={tok} className="sw" style={{ background: `var(${tok})` }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Sections the dialog lays out by hand; every other registered section gets a pane drawn from its schema. */
const HAND_DRAWN = new Set(["theme", "language", "models", "agent"]);

/** Whether a section stays on this machine or follows the Hub folder — said on every card, so nobody has to guess. */
function ScopeTag({ scope }: { scope: "machine" | "user" | undefined }) {
  const { t } = useI18n();
  if (!scope) return null;
  return (
    <Tag tone="faint" title={scope === "user" ? t("settingsDialog.scopeUser") : t("settingsDialog.scopeMachine")}>
      <span className="scope-tag" data-scope={scope}>
        {scope === "user" ? t("settingsDialog.scopeUser") : t("settingsDialog.scopeMachine")}
      </span>
    </Tag>
  );
}

/** A plugin's settings pane. Edits commit as they are made and fall back to the stored value if refused. */
function PluginPane({ section, stored, onCommit }: { section: SettingsSectionView; stored: unknown; onCommit: (next: unknown, revert: () => void) => void }) {
  const [value, setValue] = useState<unknown>(stored);
  useEffect(() => setValue(stored), [stored]);
  const schema = section.schema as JsonSchema;
  const commit = (next: unknown) => {
    setValue(next);
    onCommit(next, () => setValue(stored));
  };
  const fields = fieldsOf(schema);
  return (
    <>
      <SectionHead title={section.title} aside={<ScopeTag scope={section.scope} />}>
        {section.description}
      </SectionHead>
      <div className="panel stack-3">
        {fields ? (
          fields.map(([name, field]) => (
            <SchemaField
              key={name}
              id={section.id}
              name={name}
              schema={field}
              value={(value as Record<string, unknown> | undefined)?.[name]}
              onChange={(v) => commit({ ...(value as Record<string, unknown>), [name]: v })}
            />
          ))
        ) : (
          <SchemaField id={section.id} name={section.id} schema={schema} value={value} onChange={commit} />
        )}
      </div>
    </>
  );
}

/** A row in the side menu and the pane it reveals are one and the same thing. */
interface Pane {
  id: string;
  label: string;
  icon: IconId;
  group: "app" | "plugins";
  render: () => ReactNode;
}

export function SettingsDialog({
  open,
  onOpenChange,
  pane
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens on this pane. Empty leaves the sheet on whichever one it was left showing. */
  pane?: string;
}) {
  const { t, tx } = useI18n();
  const qc = useQueryClient();
  const settings = useSettings();
  const sections = useSettingsSections();
  const save = useSaveSettings();
  const mcp = useMcpUrl();
  const cacheDir = useCacheDir();
  const hub = useHubInfo();
  const providers = useStorageProviders();
  const [active, setActive] = useState("appearance");

  // The palette sends you straight to a pane; ⌘, leaves you on the last one.
  useEffect(() => {
    if (open && pane) setActive(pane);
  }, [open, pane]);
  // A destination's account is asked for where it is used — in a project's own
  // settings — so the section behind it is storage, not a screen. Whoever claims
  // one draws it; this dialog does not draw it twice.
  const claimed = new Set((providers.data ?? []).map((p) => p.settingsSection).filter(Boolean) as string[]);
  const pluginSections = (sections.data ?? []).filter((s) => !HAND_DRAWN.has(s.id) && !claimed.has(s.id));
  const scopeOf = (id: string) => sections.data?.find((s) => s.id === id)?.scope;

  const TOKENS: [MessageKey, string, MessageKey][] = [
    ["settingsDialog.tokenCanvas", "--bg", "settingsDialog.tokenCanvasWhere"],
    ["settingsDialog.tokenSurface", "--surface", "settingsDialog.tokenSurfaceWhere"],
    ["settingsDialog.tokenRaised", "--surface-warm", "settingsDialog.tokenRaisedWhere"],
    ["settingsDialog.tokenPrimaryText", "--fg", "settingsDialog.tokenPrimaryTextWhere"],
    ["settingsDialog.tokenSubtext", "--muted", "settingsDialog.tokenSubtextWhere"],
    ["settingsDialog.tokenMetadata", "--meta", "settingsDialog.tokenMetadataWhere"],
    ["settingsDialog.tokenBorder", "--border", "settingsDialog.tokenBorderWhere"],
    ["settingsDialog.tokenAccent", "--accent", "settingsDialog.tokenAccentWhere"]
  ];

  const panes: Pane[] = [
    {
      id: "appearance",
      label: t("settingsDialog.appearanceLabel"),
      icon: "i-sun",
      group: "app",
      render: () => (
        <>
          <SectionHead title={t("settingsDialog.appearanceLabel")} aside={<ScopeTag scope={scopeOf("theme")} />}>
            {t("settingsDialog.appearanceLede")}
          </SectionHead>
          <div className="row" style={{ gap: "var(--space-3)", flexWrap: "wrap" }}>
            <ThemeSwitch />
            <p className="meta-txt">{t("settingsDialog.appearanceApplies")}</p>
          </div>
          <ThemePreview />

          <hr className="rule" />
          <SectionHead title={t("settingsDialog.tokensLabel")}>{t("settingsDialog.tokensLede")}</SectionHead>
          <div className="panel" style={{ padding: "var(--space-2) var(--space-3)" }}>
            <table className="tok-table">
              <thead>
                <tr>
                  <th>{t("settingsDialog.colRole")}</th>
                  <th>{t("settingsDialog.colToken")}</th>
                  <th>{t("settingsDialog.colWhere")}</th>
                </tr>
              </thead>
              <tbody>
                {TOKENS.map(([roleKey, token, whereKey]) => (
                  <tr key={token}>
                    <td>
                      <span className="chip" style={{ background: `var(${token})` }} />
                      {t(roleKey)}
                    </td>
                    <td className="mono">{token}</td>
                    <td>{t(whereKey)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )
    },
    {
      id: "language",
      label: t("settingsDialog.languageLabel"),
      icon: "i-globe",
      group: "app",
      render: () => (
        <>
          <SectionHead title={t("settingsDialog.languageLabel")} aside={<ScopeTag scope={scopeOf("language")} />}>
            {t("settingsDialog.languageLede")}
          </SectionHead>
          <div className="row" style={{ gap: "var(--space-3)", flexWrap: "wrap" }}>
            <LanguageSwitch />
            <p className="meta-txt">{t("settingsDialog.languageApplies")}</p>
          </div>
        </>
      )
    },
    {
      id: "assistant",
      label: t("settingsDialog.assistantLabel"),
      icon: "i-panel" as IconId,
      group: "app" as const,
      render: () =>
        settings.data ? (
          <AssistantPane
            scope={scopeOf("agent")}
            settings={settings.data}
            // A profile or an engine override can change what an engine's row shows (readiness, its Model
            // choices) — stale beyond useEngines' own staleTime otherwise, so a save here refreshes it right away.
            onSave={(next) => save.mutate(next, { onSuccess: () => qc.invalidateQueries({ queryKey: agentKeys.engines }) })}
          />
        ) : null
    },
    {
      id: "agents",
      label: t("settingsDialog.agentsLabel"),
      icon: "i-lock",
      group: "app",
      render: () => (
        <>
          <SectionHead title={t("settingsDialog.agentsLabel")} aside={<ScopeTag scope="machine" />}>
            {t("settingsDialog.agentsLede")}
          </SectionHead>
          <div className="grid-2">
            <div className="panel">
              <div className="row" style={{ gap: 7, marginBottom: "var(--space-3)" }}>
                <LiveDot />
                <Eyebrow>{t("settingsDialog.mcpListening")}</Eyebrow>
              </div>
              <p className="num" style={{ fontSize: 14, color: "var(--fg-2)" }}>
                {mcp.data ?? t("settingsDialog.notRunning")}
              </p>
              <p className="meta-txt dense" style={{ marginTop: "var(--space-3)" }}>
                {tx("settingsDialog.mcpNote", { baseVersion: <Num>baseVersion</Num> })}
              </p>
            </div>
            <div className="panel">
              <div className="row" style={{ gap: 7, marginBottom: "var(--space-3)" }}>
                <Icon name="i-lock" size={14} style={{ color: "var(--meta)" }} />
                <Eyebrow>{t("settingsDialog.humanProtected")}</Eyebrow>
              </div>
              <ul className="dash">
                <li>{t("settingsDialog.lockedFieldsBullet")}</li>
                <li>{t("settingsDialog.oplogBullet")}</li>
                <li>{tx("settingsDialog.undoBullet", { cmdz: <Num>⌘Z</Num> })}</li>
              </ul>
            </div>
          </div>
        </>
      )
    },
    {
      id: "hub",
      label: t("settingsDialog.hubLabel"),
      icon: "i-home",
      group: "app",
      render: () => <HubPane />
    },
    {
      id: "data",
      label: t("settingsDialog.dataLabel"),
      icon: "i-archive",
      group: "app",
      render: () => (
        <>
          <SectionHead title={t("settingsDialog.dataLabel")} aside={<ScopeTag scope="machine" />}>
            {t(hub.data?.cloudEnabled ? "settingsDialog.cloudDataLede" : "settingsDialog.dataLede")}
          </SectionHead>
          <div className="panel stack-3">
            <div className="field">
              <label htmlFor="stHub">{t(hub.data?.cloudEnabled ? "settingsDialog.projectsDirLabel" : "settingsDialog.hubDirLabel")}</label>
              <div className="row" style={{ gap: "var(--space-2)" }}>
                <input id="stHub" className="input num" style={{ flex: 1 }} readOnly value={(hub.data?.cloudEnabled ? hub.data.projectsDir : hub.data?.dir) ?? ""} />
                {(hub.data?.cloudEnabled ? hub.data.projectsDir : hub.data?.dir) && (
                  <button type="button" className="btn btn-ghost" onClick={() => reveal((hub.data?.cloudEnabled ? hub.data.projectsDir : hub.data!.dir)!)}>
                    {t("settingsDialog.reveal")}
                  </button>
                )}
              </div>
              <span className="meta-txt">{t(hub.data?.cloudEnabled ? "settingsDialog.projectsDirNote" : "settingsDialog.hubDirNote")}</span>
            </div>
            <div className="field">
              <label htmlFor="stDb">{t("settingsDialog.cacheDirLabel")}</label>
              <input id="stDb" className="input num" readOnly value={cacheDir.data ?? ""} />
              <span className="meta-txt">{t("settingsDialog.cacheDirNote")}</span>
            </div>
          </div>
        </>
      )
    },
    ...pluginSections.map(
      (section): Pane => ({
        id: section.id,
        label: section.title,
        icon: "i-plug",
        group: "plugins",
        render: () => (
          <PluginPane
            section={section}
            stored={settings.data?.[section.id]}
            onCommit={(next, revert) => settings.data && save.mutate({ ...settings.data, [section.id]: next }, { onError: revert })}
          />
        )
      })
    ),
    { id: "plugins", label: t("settingsDialog.manageLabel"), icon: "i-plug", group: "plugins", render: () => <PluginsPanel /> }
  ];

  // A plugin switched off takes its pane with it, so the menu falls back rather than emptying the body.
  const current = panes.find((p) => p.id === active) ?? panes[0];
  const rows = (group: Pane["group"]) =>
    panes
      .filter((p) => p.group === group)
      .map((p) => (
        <button key={p.id} type="button" className="side-row" aria-current={p.id === current.id} onClick={() => setActive(p.id)}>
          <Icon className="ico" name={p.icon} size={14} />
          <span className="side-name">{p.label}</span>
        </button>
      ));

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={t("settingsDialog.dialogLabel")} className="sheet-settings">
      <DialogHead title={t("settingsDialog.dialogLabel")} aside={<Tag tone="neutral">{t("settingsDialog.localMachine")}</Tag>} />
      <div className="dlg-split">
        <nav className="dlg-nav" aria-label={t("settingsDialog.navAriaLabel")}>
          <div className="side-group">
            <Eyebrow className="side-label">{t("settingsDialog.groupApp")}</Eyebrow>
            {rows("app")}
          </div>
          <div className="side-group">
            <Eyebrow className="side-label">{t("settingsDialog.groupPlugins")}</Eyebrow>
            {rows("plugins")}
          </div>
        </nav>
        <DialogBody>{current.render()}</DialogBody>
      </div>
      <DialogFoot>
        <button type="button" className="btn btn-secondary" onClick={() => onOpenChange(false)}>
          {t("common.done")}
        </button>
      </DialogFoot>
    </Dialog>
  );
}

const PRESETS = [
  { titleKey: "settingsDialog.presetDeepseek" as const, provider: "openai-compatible" as const, baseURL: "https://api.deepseek.com", model: "deepseek-chat" },
  { titleKey: "settingsDialog.presetAnthropic" as const, provider: "anthropic" as const, baseURL: "", model: "claude-sonnet-5" },
  { titleKey: "settingsDialog.presetOpenai" as const, provider: "openai-compatible" as const, baseURL: "https://api.openai.com/v1", model: "" },
  { titleKey: "settingsDialog.presetKimi" as const, provider: "openai-compatible" as const, baseURL: "https://api.moonshot.cn/v1", model: "" },
  { titleKey: "settingsDialog.presetOpenrouter" as const, provider: "openai-compatible" as const, baseURL: "https://openrouter.ai/api/v1", model: "" },
  { titleKey: "settingsDialog.presetOllama" as const, provider: "openai-compatible" as const, baseURL: "http://127.0.0.1:11434/v1", model: "" },
  { titleKey: "settingsDialog.presetCustom" as const, provider: "openai-compatible" as const, baseURL: "", model: "" }
];

const EMPTY_MODELS: ModelsSettings = { profiles: [], roles: { worker: "" } };
const EMPTY_AGENT: AgentSettings = { defaultEngine: "loop", confirmWritesOver: 0, engines: {}, playbookChoices: {} };

/** Model profiles + role bindings + the default engine: the two halves of "who does the work". */
function AssistantPane({ settings, onSave, scope }: { settings: AppSettings; onSave: (next: AppSettings) => void; scope?: "machine" | "user" }) {
  const { t } = useI18n();
  const engines = useEngines();
  const models = (settings.models as ModelsSettings | undefined) ?? EMPTY_MODELS;
  const agent = (settings.agent as AgentSettings | undefined) ?? EMPTY_AGENT;
  const [editing, setEditing] = useState<ModelProfile | null>(null);

  const saveModels = (next: ModelsSettings) => onSave({ ...settings, models: next });
  const saveAgent = (next: AgentSettings) => onSave({ ...settings, agent: next });

  const upsert = (profile: ModelProfile) => {
    const rest = models.profiles.filter((p) => p.id !== profile.id);
    saveModels({ profiles: [...rest, profile], roles: { worker: models.roles.worker || profile.id } });
    setEditing(null);
  };

  const remove = (id: string) => {
    const profiles = models.profiles.filter((p) => p.id !== id);
    const fallback = profiles[0]?.id ?? "";
    saveModels({ profiles, roles: { worker: models.roles.worker === id ? fallback : models.roles.worker } });
  };

  return (
    <>
      <SectionHead title={t("settingsDialog.modelsTitle")} aside={<ScopeTag scope={scope} />}>
        {t("settingsDialog.modelsLede")}
      </SectionHead>
      <div className="panel stack-3">
        {models.profiles.length === 0 && <p className="meta-txt">{t("settingsDialog.noProfileYet")}</p>}
        {models.profiles.map((p) => (
          <div className="profile-row" key={p.id}>
            <span className="p-title">{p.title || p.model}</span>
            <span className="p-model num">{p.provider === "anthropic" ? "anthropic" : (p.baseURL ?? "")} · {p.model}</span>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(p)}>
              {t("common.edit")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => remove(p.id)}>
              {t("common.remove")}
            </button>
          </div>
        ))}
        {editing ? (
          <ProfileForm profile={editing} onCancel={() => setEditing(null)} onSave={upsert} />
        ) : (
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {PRESETS.map((preset) => {
              const title = t(preset.titleKey);
              return (
                <button
                  key={preset.titleKey}
                  type="button"
                  className="chip-opt"
                  onClick={() =>
                    setEditing({
                      id: `p${Date.now().toString(36)}`,
                      title: preset.titleKey === "settingsDialog.presetCustom" ? "" : title,
                      provider: preset.provider,
                      baseURL: preset.baseURL || undefined,
                      apiKey: "",
                      model: preset.model
                    })
                  }
                >
                  + {title}
                </button>
              );
            })}
          </div>
        )}
        {models.profiles.length > 0 && (
          <div className="field">
            <label htmlFor="role-worker">{t("settingsDialog.workerRoleLabel")}</label>
            <select
              id="role-worker"
              className="input"
              value={models.roles.worker || models.profiles[0]?.id || ""}
              onChange={(e) => saveModels({ ...models, roles: { worker: e.target.value } })}
            >
              {models.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title || p.model}
                </option>
              ))}
            </select>
            <span className="meta-txt">{t("settingsDialog.workerRoleHelp")}</span>
          </div>
        )}
      </div>

      <hr className="rule" />
      <SectionHead title={t("settingsDialog.enginesTitle")}>{t("settingsDialog.enginesLede")}</SectionHead>
      <div className="panel stack-3">
        <div className="eng-list" role="radiogroup" aria-label={t("settingsDialog.defaultEngineLabel")}>
          {(engines.data ?? []).map((e) => (
            <EngineRow
              key={e.id}
              engine={e}
              isDefault={agent.defaultEngine === e.id}
              onMakeDefault={() => saveAgent({ ...agent, defaultEngine: e.id })}
              options={(agent.engines[e.id] ?? {}) as Record<string, unknown>}
              onCommit={(key, value) => {
                const opts = (agent.engines[e.id] ?? {}) as Record<string, unknown>;
                const next = { ...opts };
                if (value.trim()) next[key] = value.trim();
                else delete next[key];
                saveAgent({ ...agent, engines: { ...agent.engines, [e.id]: next } });
              }}
            />
          ))}
        </div>
        <p className="meta-txt">{t("settingsDialog.engineListNote")}</p>
        <div className="field">
          <label htmlFor="stConfirm">{t("settingsDialog.confirmWritesLabel")}</label>
          <input
            id="stConfirm"
            className="input num"
            type="number"
            min={0}
            style={{ maxWidth: 120 }}
            value={agent.confirmWritesOver}
            onChange={(e) => saveAgent({ ...agent, confirmWritesOver: Math.max(0, Number(e.target.value) || 0) })}
          />
          <span className="meta-txt">{t("settingsDialog.confirmWritesNote")}</span>
        </div>
      </div>

      <hr className="rule" />
      <SectionHead title={t("playbooks.settingsTitle")}>{t("playbooks.settingsLede")}</SectionHead>
      <div className="panel stack-3">
        <PlaybooksBlock agent={agent} onSave={saveAgent} />
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
    void qc.invalidateQueries({ queryKey: ["agent", "playbooks"] });
  };
  if (!playbooks.data?.length) return <p className="meta-txt">{t("playbooks.settingsEmpty")}</p>;
  return (
    <>
      {playbooks.data.map((entry) => (
        <div className="profile-row" key={entry.id}>
          <span className="p-title">{entry.title}</span>
          <span className="p-model num">{entry.id}</span>
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

/** One activated engine: the radio makes it the conductor of new threads; the chevron unfolds its knobs. */
function EngineRow({
  engine,
  isDefault,
  onMakeDefault,
  options,
  onCommit
}: {
  engine: EngineView;
  isDefault: boolean;
  onMakeDefault: () => void;
  options: Record<string, unknown>;
  onCommit: (key: string, value: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(isDefault);
  const hasPicks = !!engine.picks?.length;
  const toggle = () => hasPicks && setOpen((o) => !o);
  return (
    <div className="eng-row">
      <div className={`eng-head${hasPicks ? " eng-head-toggle" : ""}`} onClick={toggle}>
        <label className="eng-pick" onClick={(e) => e.stopPropagation()}>
          <input type="radio" className="bs-radio" name="defaultEngine" checked={isDefault} onChange={onMakeDefault} />
          <span>{engine.title}</span>
        </label>
        <span className="meta-txt eng-state">{engine.ok ? t("settingsDialog.engineReady") : (engine.reason ?? t("settingsDialog.engineUnavailable"))}</span>
        {hasPicks && (
          <button type="button" className="btn btn-icon" aria-expanded={open} aria-label={t("settingsDialog.engineToggleAria", { title: engine.title })}>
            <Icon name={open ? "i-chevdown" : "i-chev"} size={12} />
          </button>
        )}
      </div>
      {open && hasPicks && (
        <div className="eng-body grid-2">
          {(engine.picks ?? []).map((pick) => (
            <EnginePickField
              key={pick.key}
              engine={engine}
              pick={pick}
              value={typeof options[pick.key] === "string" ? (options[pick.key] as string) : ""}
              onCommit={(value) => onCommit(pick.key, value)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const CUSTOM_PICK = "__custom__";

/** One engine quick-pick knob, drawn as a select. A native `<input list>` datalist filters its
 *  suggestions to those matching the current text, which hid the other presets once one was
 *  already chosen — so a free-text pick instead gets a "Custom…" entry that reveals a plain
 *  text input, keeping every preset reachable while any value the CLI knows still works. */
function EnginePickField({ engine, pick, value, onCommit }: { engine: EngineView; pick: EnginePick; value: string; onCommit: (value: string) => void }) {
  const { t } = useI18n();
  const isPreset = (v: string) => v === "" || pick.choices.some((c) => c.value === v);
  const [draft, setDraft] = useState(value);
  const [custom, setCustom] = useState(!isPreset(value));
  useEffect(() => {
    setDraft(value);
    setCustom(!isPreset(value));
  }, [value]);
  const commit = (next: string) => {
    setDraft(next);
    onCommit(next);
  };
  const onSelect = (v: string) => {
    if (v === CUSTOM_PICK) {
      setCustom(true);
      return;
    }
    setCustom(false);
    commit(v);
  };
  const title = pick.key === "model" || pick.key === "profile" ? t("settingsDialog.modelLabel") : pick.key === "effort" ? t("settingsDialog.effortLabel") : pick.title;
  const id = `engPick-${engine.id}-${pick.key}`;
  return (
    <div className="field">
      <label htmlFor={id}>{title}</label>
      <select id={id} className="input" value={custom ? CUSTOM_PICK : draft} onChange={(e) => onSelect(e.target.value)}>
        <option value="">{t("settingsDialog.pickDefaultOption")}</option>
        {pick.choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label ?? c.value}
          </option>
        ))}
        {pick.freeText && <option value={CUSTOM_PICK}>{t("settingsDialog.pickCustomOption")}</option>}
      </select>
      {pick.key === "profile" && <span className="meta-txt">{t("settingsDialog.engineProfileNote")}</span>}
      {pick.freeText && (
        <>
          {custom && <input id={`${id}-custom`} className="input num" value={draft} onChange={(e) => commit(e.target.value)} />}
          <span className="meta-txt">{t("settingsDialog.engineModelNote")}</span>
        </>
      )}
    </div>
  );
}

function ProfileForm({ profile, onSave, onCancel }: { profile: ModelProfile; onSave: (p: ModelProfile) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ModelProfile>(profile);
  const set = (patch: Partial<ModelProfile>) => setDraft((d) => ({ ...d, ...patch }));
  const valid = draft.model.trim().length > 0 && (draft.provider !== "anthropic" || draft.apiKey.trim().length > 0);
  return (
    <div className="panel stack-3" style={{ background: "var(--bg)" }}>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="pfTitle">{t("settingsDialog.profileNameLabel")}</label>
          <input id="pfTitle" className="input" value={draft.title} placeholder={draft.model || t("settingsDialog.myModelPlaceholder")} onChange={(e) => set({ title: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="pfProvider">{t("settingsDialog.profileProviderLabel")}</label>
          <select id="pfProvider" className="input" value={draft.provider} onChange={(e) => set({ provider: e.target.value as ModelProfile["provider"] })}>
            <option value="openai-compatible">{t("settingsDialog.providerOpenaiCompatible")}</option>
            <option value="anthropic">{t("settingsDialog.providerAnthropic")}</option>
          </select>
        </div>
      </div>
      <div className="grid-2">
        {draft.provider === "openai-compatible" && (
          <div className="field">
            <label htmlFor="pfBase">{t("settingsDialog.baseUrlLabel")}</label>
            <input id="pfBase" className="input num" value={draft.baseURL ?? ""} onChange={(e) => set({ baseURL: e.target.value })} />
          </div>
        )}
        <div className="field">
          <label htmlFor="pfModel">{t("settingsDialog.modelLabel")}</label>
          <input id="pfModel" className="input num" value={draft.model} onChange={(e) => set({ model: e.target.value })} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="pfKey">{t("settingsDialog.apiKeyLabel")}</label>
        <input id="pfKey" className="input num" type="password" value={draft.apiKey} onChange={(e) => set({ apiKey: e.target.value })} />
        <span className="meta-txt">{t("settingsDialog.localEndpointNote")}</span>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-secondary" disabled={!valid} onClick={() => onSave({ ...draft, title: draft.title || draft.model })}>
          {t("settingsDialog.saveProfile")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}
