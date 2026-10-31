import { useEffect, useRef, useState } from "react";
import type { AgentSettings, EnginePick, EngineStepLimit, EngineView, PlaybookSource } from "@tomradex/agent";
import type { AppSettings } from "@tomradex/domain";
import type { ModelProfile, ModelsSettings, ProviderView } from "@tomradex/llm";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { conducts, findEngine, useEngines, usePlaybooks } from "~/lib/agent";
import { Icon } from "~/components/icons";
import { ProviderInstallProblem } from "~/components/setup/QuickModelSetup";
import { Fold, FoldChevron, FoldChevronSpace, SectionHead, Tag } from "~/components/ui/atoms";
import { Collapse } from "~/components/ui/collapse";
import { invoke } from "~/lib/api";
import { detectedHere, failedTry, pickFallbackName, pickTitleOf } from "~/lib/engines";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { isCommitKey } from "~/lib/keys";
import { engineStateLabel, engineStatus } from "~/lib/localCli";
import { keys, usePlugins } from "~/lib/queries";
import { useInstallProvider, useModelProviders, useProviderPlugins, useProviders } from "~/lib/setup";
import { EngineTryRow } from "../EngineTryRow";
import { GitNotice } from "~/components/setup/GitNotice";
import { LocalCliSection } from "../LocalCliSection";
import { RegistryAgents } from "./RegistryAgents";
import { McpLinkSection } from "../McpLinkSection";
import { ProfileForm, SearchRouteLine, providerOf } from "./ModelProfiles";
import { PickSelect } from "~/components/ui/pick-select";
import { ScopeTag } from "./ScopeTag";

// The app's own presets keep their translated names; a provider's other presets show the title it gives.
const PRESET_TITLES: Record<string, MessageKey> = {
  deepseek: "settingsDialog.presetDeepseek",
  anthropic: "settingsDialog.presetAnthropic",
  openai: "settingsDialog.presetOpenai",
  kimi: "settingsDialog.presetKimi",
  gemini: "settingsDialog.presetGemini",
  openrouter: "settingsDialog.presetOpenrouter",
  ollama: "settingsDialog.presetOllama"
};

const EMPTY_MODELS: ModelsSettings = { profiles: [], roles: { worker: "" } };
// LENT_WORKER in @tomradex/llm: roles.worker naming a signed-in local agent
const LENT_WORKER = "lent:";
const EMPTY_AGENT: AgentSettings = { defaultEngine: "tomrade", confirmWritesOver: 0, resumeAfterLimit: true, maxRunMinutes: 15, engines: {}, playbookChoices: {} };
// a conversation's run ceiling, in minutes; 240 matches a ticket's
const RUN_LIMITS = [5, 10, 15, 30, 60, 120, 240];

/** Model profiles + role bindings + the default engine: the two halves of "who does the work". */
export function AssistantPane({
  settings,
  onSave,
  onFindEngines,
  focusEngine,
  scope
}: {
  settings: AppSettings;
  onSave: (next: AppSettings) => void;
  onFindEngines: () => void;
  focusEngine?: string;
  scope?: "machine" | "user";
}) {
  const { t, tx } = useI18n();
  const engines = useEngines();
  // An engine whose plugin is off is missing from the list above, not greyed out in it.
  const enginesOff = (usePlugins().data?.plugins ?? []).filter((p) => p.implements.includes("engine") && p.state === "disabled");
  const models = (settings.models as ModelsSettings | undefined) ?? EMPTY_MODELS;
  const agent = (settings.agent as AgentSettings | undefined) ?? EMPTY_AGENT;
  const runMinutes = agent.maxRunMinutes ?? EMPTY_AGENT.maxRunMinutes;
  const [editing, setEditing] = useState<ModelProfile | null>(null);
  const { data: kinds } = useModelProviders();
  const { data: presets } = useProviders();
  const plugins = useProviderPlugins().data ?? [];
  const startProfile = (preset: Pick<ProviderView, "provider" | "baseURL" | "model">, title: string) =>
    setEditing({ id: `p${Date.now().toString(36)}`, title, provider: preset.provider, baseURL: preset.baseURL || undefined, apiKey: "", model: preset.model });
  // a provider plugin installed from here opens its first preset's form once it has registered it
  const offer = useInstallProvider((preset) => startProfile(preset, preset.title));
  // removing a profile deletes its key too: asked once, in the row
  const [removing, setRemoving] = useState<string | null>(null);
  // The agents on this machine make the list; the rest wait behind one line, which opens for an engine someone was sent to set up.
  const defaultId = findEngine(engines.data, agent.defaultEngine)?.id;
  const conducting = (engines.data ?? []).filter(conducts);
  const here = conducting.filter((e) => detectedHere(e) || e.id === defaultId);
  const elsewhere = conducting.filter((e) => !here.includes(e));
  const [othersOpen, setOthersOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const focusedElsewhere = !!focusEngine && elsewhere.some((e) => e.id === focusEngine);
  useEffect(() => {
    if (focusedElsewhere) setOthersOpen(true);
  }, [focusedElsewhere]);

  const saveModels = (next: ModelsSettings) => onSave({ ...settings, models: next });
  const saveAgent = (next: AgentSettings) => onSave({ ...settings, agent: next });

  const upsert = (profile: ModelProfile) => {
    const rest = models.profiles.filter((p) => p.id !== profile.id);
    saveModels({ profiles: [...rest, profile], roles: models.roles });
    setEditing(null);
  };

  const remove = (id: string) => {
    const profiles = models.profiles.filter((p) => p.id !== id);
    saveModels({ profiles, roles: { worker: models.roles.worker === id ? "" : models.roles.worker } });
  };

  const row = (e: EngineView) => (
    <EngineRow
      key={e.id}
      engine={e}
      isDefault={defaultId === e.id}
      focused={focusEngine === e.id}
      onMakeDefault={() => saveAgent({ ...agent, defaultEngine: e.id })}
      options={(agent.engines[e.id] ?? {}) as Record<string, unknown>}
      onCommit={(key, value) => {
        const opts = (agent.engines[e.id] ?? {}) as Record<string, unknown>;
        const next = { ...opts };
        if (typeof value === "number") next[key] = value;
        else if (value?.trim()) next[key] = value.trim();
        else delete next[key];
        saveAgent({ ...agent, engines: { ...agent.engines, [e.id]: next } });
      }}
    />
  );

  return (
    <>
      <SectionHead title={t("settingsDialog.modelsTitle")} aside={<ScopeTag scope={scope} />}>
        {t("settingsDialog.modelsLede")}
      </SectionHead>
      <div className="panel stack-3">
        {models.profiles.length === 0 && <p className="meta-txt">{t("settingsDialog.noProfileYet")}</p>}
        {models.profiles.map((p) =>
          removing === p.id ? (
            <div className="profile-row profile-remove" key={p.id} role="alert">
              <span className="p-title" style={{ flex: 1 }}>{t("settingsDialog.removeProfileConfirm", { name: p.title || p.model })}</span>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  remove(p.id);
                  setRemoving(null);
                }}
              >
                {t("common.remove")}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setRemoving(null)}>
                {t("common.cancel")}
              </button>
            </div>
          ) : (
            <div className="profile-row" key={p.id}>
              <span className="p-title">{p.title || p.model}</span>
              <span className="p-model num">{providerOf(kinds, p.provider).baseURL.editable ? (p.baseURL ?? "") : (p.baseURL || p.provider)} · {p.model}</span>
              {!editing && (
                <>
                  <button type="button" className="btn btn-ghost" onClick={() => setEditing(p)}>
                    {t("common.edit")}
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setRemoving(p.id)}>
                    {t("common.remove")}
                  </button>
                </>
              )}
            </div>
          )
        )}
        {editing ? (
          <ProfileForm profile={editing} onCancel={() => setEditing(null)} onSave={upsert} />
        ) : (
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {[...(presets ?? []), { id: "custom", title: "", provider: "openai-compatible", baseURL: "", model: "" }].map((preset) => {
              const title = preset.id === "custom" ? t("settingsDialog.presetCustom") : PRESET_TITLES[preset.id] ? t(PRESET_TITLES[preset.id]) : preset.title;
              return (
                <button key={preset.id} type="button" className="chip-opt" onClick={() => startProfile(preset, preset.id === "custom" ? "" : title)}>
                  + {title}
                </button>
              );
            })}
            {plugins.map((plugin) => (
              <button
                key={plugin.id}
                type="button"
                className="chip-opt"
                data-plugin={plugin.id}
                title={t("setup.officialPlugin")}
                disabled={!!offer.busy}
                aria-busy={offer.busy === plugin.id}
                onClick={() => offer.install(plugin)}
              >
                <Icon name="i-plug" size={11} /> {offer.busy === plugin.id ? t("setup.installingProvider") : `+ ${plugin.title}`}
              </button>
            ))}
          </div>
        )}
        {!editing && plugins.map((plugin) => <ProviderInstallProblem key={plugin.id} plugin={plugin} offer={offer} />)}
        {models.profiles.length > 0 && <SearchRouteLine profiles={models.profiles} />}
      </div>

      <hr className="rule" />
      <SectionHead title={t("settingsDialog.enginesTitle")}>{t("settingsDialog.enginesLede")}</SectionHead>
      <div className="panel stack-3">
        <div className="eng-list" role="radiogroup" aria-label={t("settingsDialog.defaultEngineLabel")}>
          {here.map(row)}
        </div>
        {elsewhere.length > 0 && (
          <Fold id="other-agents" title={t("settingsDialog.otherAgentsTitle", { count: elsewhere.length })} open={othersOpen} onToggle={() => setOthersOpen((o) => !o)}>
            <p className="meta-txt">{t("settingsDialog.otherAgentsNote")}</p>
            <div className="eng-list" role="radiogroup" aria-label={t("settingsDialog.otherAgentsTitle", { count: elsewhere.length })}>
              {elsewhere.map(row)}
            </div>
          </Fold>
        )}
        <GitNotice />
        <p className="meta-txt">{t("settingsDialog.engineListNote")}</p>
        <p className="meta-txt" data-testid="more-engines">
          {enginesOff.length
            ? tx("settingsDialog.moreEnginesOff", { list: <span>{enginesOff.map((p) => p.title ?? p.id).join(", ")}</span> })
            : t("settingsDialog.moreEngines")}{" "}
          <button type="button" className="link-btn" onClick={onFindEngines}>
            {t("settingsDialog.moreEnginesLink")}
          </button>
        </p>
        <RegistryAgents />
        <div className="field">
          <div className="cfg-row">
            <span className="cfg-name">{t("settingsDialog.resumeAfterLimitLabel")}</span>
            <button
              type="button"
              className="switch"
              role="switch"
              data-testid="resume-after-limit"
              aria-checked={agent.resumeAfterLimit !== false}
              aria-label={t("settingsDialog.resumeAfterLimitLabel")}
              onClick={() => saveAgent({ ...agent, resumeAfterLimit: agent.resumeAfterLimit === false })}
            />
          </div>
          <span className="meta-txt">{t("settingsDialog.resumeAfterLimitNote")}</span>
        </div>
        <div className="field">
          <div className="cfg-row">
            <label className="cfg-name" htmlFor="run-limit">{t("settingsDialog.runLimitLabel")}</label>
            <select
              id="run-limit"
              className="input"
              style={{ width: "auto" }}
              data-testid="run-limit"
              value={runMinutes}
              onChange={(e) => saveAgent({ ...agent, maxRunMinutes: Number(e.target.value) })}
            >
              {[...new Set([...RUN_LIMITS, runMinutes])].sort((a, b) => a - b).map((n) => (
                <option key={n} value={n}>
                  {t("settingsDialog.runLimitMinutes", { n })}
                </option>
              ))}
            </select>
          </div>
          <span className="meta-txt">{t("settingsDialog.runLimitNote")}</span>
        </div>
      </div>

      <hr className="rule" />
      <Fold id="assistant-advanced" title={t("common.advanced")} open={advancedOpen} onToggle={() => setAdvancedOpen((o) => !o)}>
        <WorkerRole models={models} onSave={saveModels} />
        <SectionHead title={t("playbooks.settingsTitle")}>{t("playbooks.settingsLede")}</SectionHead>
        <div className="panel stack-3">
          <PlaybooksBlock agent={agent} onSave={saveAgent} />
        </div>
      </Fold>
    </>
  );
}

/** Which model answers the tools' own calls: a profile, or an agent signed in on this machine. Nothing to pick from, nothing to show. */
function WorkerRole({ models, onSave }: { models: ModelsSettings; onSave: (next: ModelsSettings) => void }) {
  const { t } = useI18n();
  // An agent's first sign-in check can take a model call; look again until each has answered.
  const lenders = useQuery({ queryKey: keys.llm.lenders, queryFn: () => invoke("llm.lenders"), staleTime: 15_000,
    refetchInterval: (query) => (query.state.data?.some((l) => l.ready === null) ? 1500 : false) }).data ?? [];
  const worker = useQuery({ queryKey: keys.llm.workerFor(models.roles.worker), queryFn: () => invoke("llm.worker"), staleTime: 15_000 }).data;
  if (models.profiles.length === 0 && lenders.length === 0) return null;
  return (
    <div className="panel stack-3" style={{ marginBottom: "var(--space-5)" }}>
      <div className="field">
        <label htmlFor="role-worker">{t("settingsDialog.workerRoleLabel")}</label>
        <select
          id="role-worker"
          className="input"
          value={models.roles.worker}
          onChange={(e) => onSave({ ...models, roles: { worker: e.target.value } })}
        >
          <option value="">{t("settingsDialog.workerAuto")}</option>
          {models.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title || p.model}
            </option>
          ))}
          {lenders.map((l) => (
            <option key={l.id} value={`${LENT_WORKER}${l.id}`}>
              {t(l.ready === null ? "settingsDialog.workerLentChecking" : l.ready ? "settingsDialog.workerLent" : "settingsDialog.workerLentNotReady", { name: l.title })}
            </option>
          ))}
        </select>
        <span className="meta-txt">{t("settingsDialog.workerRoleHelp")}</span>
        {worker && !worker.ok && worker.reason && (
          <span className="meta-txt" role="alert" data-testid="worker-problem">
            {worker.reason}
          </span>
        )}
      </div>
    </div>
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
  focused,
  onMakeDefault,
  options,
  onCommit
}: {
  engine: EngineView;
  isDefault: boolean;
  focused: boolean;
  onMakeDefault: () => void;
  options: Record<string, unknown>;
  /** null (or an empty string) puts the option back to its default. */
  onCommit: (key: string, value: string | number | null) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(isDefault || focused);
  const row = useRef<HTMLDivElement>(null);
  // Sent here to set this engine up: unfold it where it can be seen.
  useEffect(() => {
    if (!focused) return;
    setOpen(true);
    requestAnimationFrame(() => row.current?.scrollIntoView({ block: "nearest" }));
  }, [focused]);
  const hasPicks = !!engine.picks?.length;
  const stepLimit = engine.stepLimit;
  // a terminal-only CLI conducts no conversation to try
  const canTry = !engine.terminalOnly;
  const hasBody = hasPicks || !!stepLimit || !!engine.cli || canTry;
  const toggle = () => hasBody && setOpen((o) => !o);
  const status = engineStatus(engine);
  const failed = failedTry(engine);
  return (
    <div className="eng-row" ref={row} data-engine={engine.id}>
      <div className={`eng-head${hasBody ? " eng-head-toggle" : ""}`} onClick={toggle}>
        {hasBody ? <FoldChevron open={open} label={t("settingsDialog.engineToggleAria", { title: engine.title })} onToggle={toggle} /> : <FoldChevronSpace />}
        <label className="eng-pick" onClick={(e) => e.stopPropagation()}>
          {/* a terminal-only CLI conducts no conversation, so it cannot be the default */}
          <input type="radio" className="bs-radio" name="defaultEngine" checked={isDefault} onChange={onMakeDefault} disabled={engine.terminalOnly} />
          <span>{engine.title}</span>
          {engine.terminalOnly && <span className="meta-txt">{t("settingsDialog.terminalOnly")}</span>}
        </label>
        <span className={`meta-txt eng-state${status === "ready" || status === "other" ? "" : " is-warn"}${failed ? " is-warn" : ""}`} title={failed?.error ?? (engine.ok ? undefined : engine.reason)}>
          {engine.cli || failed ? engineStateLabel(engine, t, t("settingsDialog.engineUnavailable")) : engine.ok ? t("settingsDialog.engineReady") : (engine.reason ?? t("settingsDialog.engineUnavailable"))}
        </span>
      </div>
      {/* Folded or not: a signed-in agent missing from chat and Start would otherwise look broken. */}
      {engine.terminalOnly && (
        <div className="eng-body meta-txt" data-terminal-only-note>
          {t("settingsDialog.terminalOnlyNote", { title: engine.title })}
        </div>
      )}
      <Collapse open={open && !!engine.cli} className="eng-body">
        {engine.cli && <LocalCliSection engine={engine} cli={engine.cli} command={typeof options.command === "string" ? options.command : ""} onSaveCommand={(value) => onCommit("command", value)} />}
      </Collapse>
      <Collapse open={open && !!engine.mcpLink} className="eng-body">
        <McpLinkSection engine={engine} />
      </Collapse>
      <Collapse open={open && canTry} className="eng-body">
        <EngineTryRow engine={engine} command={typeof options.command === "string" ? options.command : undefined} />
      </Collapse>
      <Collapse open={open && (hasPicks || !!stepLimit)} className="eng-body grid-2">
        {(engine.picks ?? []).map((pick) => (
          <EnginePickField
            key={pick.key}
            engine={engine}
            pick={pick}
            value={typeof options[pick.key] === "string" ? (options[pick.key] as string) : ""}
            onCommit={(value) => onCommit(pick.key, value)}
          />
        ))}
        {stepLimit && (
          <StepLimitField
            key={String(options[stepLimit.key])}
            engine={engine}
            limit={stepLimit}
            value={typeof options[stepLimit.key] === "number" ? (options[stepLimit.key] as number) : undefined}
            onCommit={(value) => onCommit(stepLimit.key, value)}
          />
        )}
      </Collapse>
    </div>
  );
}

/** The most steps one turn takes: a whole number in the engine's range, saved once the field is left; empty goes back to the default. */
function StepLimitField({ engine, limit, value, onCommit }: { engine: EngineView; limit: EngineStepLimit; value: number | undefined; onCommit: (value: number | null) => void }) {
  const { t } = useI18n();
  // keyed by the saved value, so a save from elsewhere starts it over
  const shown = String(value ?? limit.default);
  const [draft, setDraft] = useState(shown);
  const id = `engSteps-${engine.id}`;
  const typed = draft.trim();
  const n = Number(typed);
  const bad = typed !== "" && (!Number.isInteger(n) || n < limit.min || n > limit.max);
  const commit = () => {
    if (bad || typed === shown) return;
    if (typed === "") {
      setDraft(String(limit.default));
      if (value !== undefined) onCommit(null);
    } else onCommit(n);
  };
  return (
    <div className="field">
      <label htmlFor={id}>{t("settingsDialog.stepLimitLabel")}</label>
      <input
        id={id}
        className="input num"
        type="number"
        min={limit.min}
        max={limit.max}
        step={1}
        data-testid={`step-limit-${engine.id}`}
        value={draft}
        aria-invalid={bad}
        aria-describedby={bad ? `${id}-error` : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (isCommitKey(e)) commit();
        }}
      />
      {bad && (
        <span id={`${id}-error`} className="field-error" role="alert">
          {t("settingsDialog.stepLimitRange", { min: limit.min, max: limit.max })}
        </span>
      )}
      <span className="meta-txt">{t("settingsDialog.stepLimitNote", { min: limit.min, max: limit.max, default: limit.default })}</span>
    </div>
  );
}


/** One engine quick-pick knob: the shared select, its "Default" naming what the engine runs with on its own once it has said. */
function EnginePickField({ engine, pick, value, onCommit }: { engine: EngineView; pick: EnginePick; value: string; onCommit: (value: string) => void }) {
  const { t } = useI18n();
  const id = `engPick-${engine.id}-${pick.key}`;
  const stands = pickFallbackName(t, pick);
  return (
    <div className="field">
      <label htmlFor={id}>{pickTitleOf(t, pick)}</label>
      <PickSelect id={id} pick={pick} value={value} onChange={onCommit} className="input" defaultLabel={stands ? t("agentPanel.pickDefaultKnown", { value: stands }) : t("settingsDialog.pickDefaultOption")} />
      {pick.key === "profile" && <span className="meta-txt">{t("settingsDialog.engineProfileNote")}</span>}
      {pick.freeText && <span className="meta-txt">{t("settingsDialog.engineModelNote")}</span>}
    </div>
  );
}
