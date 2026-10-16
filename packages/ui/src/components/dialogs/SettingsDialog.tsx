import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { AgentSettings, EnginePick, EngineView, PlaybookSource } from "@tomradex/agent";
import { THEME_TYPOGRAPHY_NAMES, type ModelErrorKind, type AppSettings, type CustomTheme, type ThemeAutomation, type ThemePreference, type ThemeTokenName, type ThemeTypographyName } from "@tomradex/domain";
import type { ModelProfile, ModelsSettings } from "@tomradex/llm";
import { useQueryClient } from "@tanstack/react-query";
import { agentKeys, conducts, findEngine, useEngines, usePlaybooks } from "~/lib/agent";
import type { SettingsSectionView } from "@tomradex/settings";
import { Icon, type IconId } from "~/components/icons";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { LanguageSwitch } from "~/components/ui/language-switch";
import { ThemeSwitch } from "~/components/ui/theme-switch";
import { AboutPane } from "./AboutPane";
import { KeybindingsPane } from "./KeybindingsPane";
import { UsagePane } from "./UsagePane";
import { BackgroundPane } from "./BackgroundPane";
import { HubPane } from "./HubPane";
import { EngineTryRow } from "./EngineTryRow";
import { LocalCliSection } from "./LocalCliSection";
import { McpLinkSection } from "./McpLinkSection";
import { McpServersPane } from "./McpServersPane";
import { PetProfilesPanel } from "./PetProfilesPanel";
import { PluginsPanel } from "./PluginsPanel";
import { Eyebrow, LiveDot, Num, SectionHead, Tag } from "~/components/ui/atoms";
import { SchemaField, fieldsOf, problemOf, type JsonSchema } from "~/components/ui/schema-form";
import { STATUS } from "~/lib/domain";
import { useBackgroundStatus } from "~/lib/background";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useCacheDir, useHubInfo, useMcpUrl, usePlugins, useSaveSettings, useSettings, useSettingsSections, useStorageProviders } from "~/lib/queries";
import { cssColorToHex, useTheme } from "~/lib/theme";
import { engineStateLabel, engineStatus } from "~/lib/localCli";
import { openExternal, reveal } from "~/lib/shell";
import { invoke } from "~/lib/api";
import { readableError } from "~/lib/toast";
import { keyLabel } from "~/lib/keybindings";
import { PlainSecretNote } from "~/components/ui/PlainSecretNote";
import { useSettingsSheet } from "~/lib/settingsHost";

/** Each preview re-declares the token block locally, so all built-in themes are
 *  visible at once — the clearest proof that one class swaps the lot. */
function ThemePreview({ customThemes }: { customThemes: CustomTheme[] }) {
  const { t } = useI18n();
  const modes: { id: string; cls: string; name: string; hex: string; style?: CSSProperties }[] = [
    { id: "dawn", cls: "dawn", name: t("theme.dawn"), hex: "#f4ead7" },
    { id: "light", cls: "paper-preview", name: t("theme.paper"), hex: "#f5f4ed" },
    { id: "dark", cls: "dark", name: t("theme.ink"), hex: "#141413" },
    { id: "matcha", cls: "matcha", name: t("theme.matcha"), hex: "oklch .275 .022 142" },
    ...customThemes.map(theme => ({ id: theme.id, cls: theme.base, name: theme.name, hex: theme.tokens.bg, style: Object.fromEntries(Object.entries({ ...theme.tokens, ...theme.fonts }).map(([name, value]) => [`--${name}`, value])) as CSSProperties }))
  ];
  return (
    <div className="mode-grid" style={{ marginTop: "var(--space-5)" }}>
      {modes.map((m) => (
        <div className={`mode ${m.cls}`} key={m.id} style={m.style}>
          <div className="mode-top">
            <span className="mode-name">{m.name}</span>
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
const HAND_DRAWN = new Set(["keybindings", "theme", "themeAutomation", "customThemes", "language", "models", "agent", "mcpServers", "updates", "onboarding"]);

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

/**
 * A plugin's settings pane. A typed field saves when it is left, a pick at
 * once. A value that would be refused stays as typed, with the reason under
 * it, instead of springing back to what was stored.
 */
function PluginPane({ section, stored, onSave, children }: { section: SettingsSectionView; stored: unknown; onSave: (next: unknown) => Promise<unknown>; children?: ReactNode }) {
  const { t } = useI18n();
  const [value, setValue] = useState<unknown>(stored);
  const [problems, setProblems] = useState<Record<string, string>>({});
  // A field still being put right keeps what was typed; otherwise the pane follows the stored value.
  const unsettled = Object.keys(problems).length > 0;
  useEffect(() => {
    if (!unsettled) setValue(stored);
  }, [stored]); // eslint-disable-line react-hooks/exhaustive-deps
  const schema = section.schema as JsonSchema;
  const fields = fieldsOf(schema);
  const record = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const setProblem = (key: string, problem: string | null) =>
    setProblems((all) => {
      const { [key]: _, ...rest } = all;
      return problem ? { ...rest, [key]: problem } : rest;
    });

  const change = (name: string | null, next: unknown) => {
    setValue((current: unknown) => (name === null ? next : { ...record(current), [name]: next }));
    setProblem(name ?? "", null);
  };
  const commit = (name: string | null, field: JsonSchema, next: unknown) => {
    const key = name ?? "";
    const problem = problemOf(field, next, t);
    if (problem) return setProblem(key, problem);
    // other fields still wrong go out as stored, so one bad field cannot sink another's save
    const others = Object.fromEntries(Object.keys(problems).filter((k) => k !== key && k !== "").map((k) => [k, record(stored)[k]]));
    const payload = name === null ? next : { ...record(value), ...others, [name]: next };
    if (JSON.stringify(payload) === JSON.stringify(stored)) return setProblem(key, null);
    onSave(payload).then(
      () => setProblem(key, null),
      (err: unknown) => setProblem(key, t("common.notSaved", { reason: readableError(err) }))
    );
  };
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
              value={record(value)[name]}
              error={problems[name]}
              onChange={(v) => change(name, v)}
              onCommit={(v) => commit(name, field, v)}
            />
          ))
        ) : (
          <SchemaField id={section.id} name={section.id} schema={schema} value={value} error={problems[""]} onChange={(v) => change(null, v)} onCommit={(v) => commit(null, schema, v)} />
        )}
      </div>
      {children}
    </>
  );
}

/** What a plugin's pane shows beyond its schema, for the plugins whose settings are more than fields. */
const PANE_EXTRAS: Record<string, () => ReactNode> = {
  pet: () => <PetProfilesPanel />
};

function TokenEditor({ token, value, disabled, onChange }: { token: ThemeTokenName; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <div className="token-value">
    <input type="color" className="token-picker" aria-label={`Pick --${token}`} value={cssColorToHex(draft || value)} disabled={disabled}
      onChange={(event) => { setDraft(event.target.value); onChange(event.target.value); }} />
    <input className="field-input token-input" aria-label={`--${token}`} value={draft} disabled={disabled}
      onChange={(event) => setDraft(event.target.value)} onBlur={() => draft.trim() && onChange(draft.trim())} />
  </div>;
}

function FontEditor({ name, value, disabled, onChange }: { name: ThemeTypographyName; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <label className="token-font-field"><span className="mono">--{name}</span>
    <input className="field-input" value={draft} disabled={disabled} onChange={event => setDraft(event.target.value)}
      onBlur={() => draft.trim() && onChange(draft.trim())} />
  </label>;
}

const AUTOMATION_MODES: { value: ThemeAutomation["mode"]; label: MessageKey; icon: IconId }[] = [
  { value: "none", label: "settingsDialog.automationNone", icon: "i-stop" }, { value: "system", label: "settingsDialog.automationSystem", icon: "i-monitor" },
  { value: "schedule", label: "settingsDialog.automationSchedule", icon: "i-clock" }, { value: "shuffle", label: "settingsDialog.automationShuffle", icon: "i-branch" }
];
const CUSTOM_ICONS: CustomTheme["icon"][] = ["i-sun", "i-moon", "i-leaf", "i-tag", "i-bug", "i-board", "i-stack", "i-sliders"];
function ThemeChoices({ themes, value, onChange }: { themes: CustomTheme[]; value: Exclude<ThemePreference, "system">; onChange: (value: Exclude<ThemePreference, "system">) => void }) {
  const { t } = useI18n();
  return <select className="field-input" value={value} onChange={event => onChange(event.target.value as Exclude<ThemePreference, "system">)}>
    <option value="dawn">{t("theme.dawn")}</option><option value="light">{t("theme.paper")}</option><option value="dark">{t("theme.ink")}</option><option value="matcha">{t("theme.matcha")}</option>
    {themes.map(theme => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
  </select>;
}
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
function ScheduleTime({ value, label, onCommit }: { value: string; label: string; onCommit: (next: string) => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const valid = TIME.test(draft);
  // a time that is not one stays as typed, and says so, rather than being dropped on blur
  return <input type="text" inputMode="numeric" maxLength={5} placeholder="09:00" aria-label={label} aria-invalid={!valid}
    title={valid ? undefined : t("settingsDialog.scheduleTimeError")}
    className="field-input schedule-time" value={draft} onChange={event => setDraft(event.target.value)} onBlur={() => valid && draft !== value && onCommit(draft)} />;
}
function RefreshFrequency({ value, onCommit }: { value: number; onCommit: (next: number) => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const valid = /^[0-9]+$/.test(draft) && Number(draft) >= 1 && Number(draft) <= 10080;
  const commit = () => {
    if (!valid) return;
    const next = Number(draft);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return <label className="shuffle-config">
    <span className="automation-field-label">{t("settingsDialog.refreshFrequency")}</span>
    <span className="shuffle-frequency">
      <input type="text" inputMode="numeric" className="field-input" value={draft}
        aria-invalid={!valid} aria-describedby={!valid ? "refresh-frequency-error" : undefined}
        onChange={event => setDraft(event.target.value)} onBlur={commit}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); commit(); } }} />
      <span>{t("settingsDialog.minutesUnit")}</span>
    </span>
    {!valid && <span id="refresh-frequency-error" className="frequency-error" role="alert">{t("settingsDialog.refreshFrequencyError")}</span>}
  </label>;
}
function ThemeIconMenu({ value, onChange }: { value: CustomTheme["icon"]; onChange: (icon: CustomTheme["icon"]) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return <div className="theme-icon-menu">
    <button type="button" className="icon-btn" aria-label={t("settingsDialog.chooseThemeIcon")} aria-expanded={open} onClick={() => setOpen(!open)}><Icon name={value ?? "i-sliders"} size={14} /></button>
    {open && <div className="theme-icon-options" role="listbox" aria-label={t("settingsDialog.themeIcons")}>
      {CUSTOM_ICONS.map(icon => <button type="button" key={icon} className="icon-btn" aria-label={icon} aria-selected={(value ?? "i-sliders") === icon}
        onClick={() => { onChange(icon); setOpen(false); }}><Icon name={icon} size={14} /></button>)}
    </div>}
  </div>;
}
function ThemeAutomationPanel({ automation, themes, onChange }: { automation: ThemeAutomation; themes: CustomTheme[]; onChange: (next: ThemeAutomation) => void }) {
  const { t } = useI18n();
  return <div className="theme-automation">
    <div className="theme-automation-row"><h3 className="appearance-group-title">{t("settingsDialog.themeSwitchMode")}</h3><div className="theme-switch" role="group" aria-label={t("settingsDialog.themeSwitchMode")}>
      {AUTOMATION_MODES.map(mode => <button key={mode.value} type="button" className="theme-seg" aria-pressed={automation.mode === mode.value}
        onClick={() => onChange({ ...automation, mode: mode.value })}><Icon name={mode.icon} size={13} />{t(mode.label)}</button>)}
    </div></div>
    {automation.mode === "schedule" && <div className="automation-detail schedule-config">
      <div className="automation-detail-head"><div><span className="eyebrow">{t("settingsDialog.scheduleEyebrow")}</span><p>{t("settingsDialog.scheduleLede")}</p></div><label>{t("settingsDialog.scheduleDefault")} <ThemeChoices themes={themes} value={automation.defaultTheme} onChange={defaultTheme => onChange({ ...automation, defaultTheme })} /></label></div>
      <div className="schedule-columns"><span>{t("settingsDialog.scheduleFrom")}</span><span>{t("settingsDialog.scheduleUntil")}</span><span>{t("settingsDialog.scheduleTheme")}</span><span /></div>
      {automation.schedule.map((rule, index) => <div className="schedule-row" key={`${rule.start}-${index}`}>
        <ScheduleTime label={t("settingsDialog.scheduleStart")} value={rule.start} onCommit={start => onChange({ ...automation, schedule: automation.schedule.map((entry, i) => i === index ? { ...entry, start } : entry) })} />
        <ScheduleTime label={t("settingsDialog.scheduleEnd")} value={rule.end ?? "23:59"} onCommit={end => onChange({ ...automation, schedule: automation.schedule.map((entry, i) => i === index ? { ...entry, end } : entry) })} />
        <ThemeChoices themes={themes} value={rule.theme} onChange={theme => onChange({ ...automation, schedule: automation.schedule.map((entry, i) => i === index ? { ...entry, theme } : entry) })} />
        <button type="button" className="icon-btn" aria-label={t("settingsDialog.scheduleRemove")} onClick={() => onChange({ ...automation, schedule: automation.schedule.filter((_, i) => i !== index) })}><Icon name="i-trash" size={13} /></button>
      </div>)}
      {automation.schedule.length < 24 && <button type="button" className="btn schedule-add" onClick={() => onChange({ ...automation, schedule: [...automation.schedule, { start: "09:00", end: "17:00", theme: automation.defaultTheme }] })}><Icon name="i-plus" size={13} /> {t("settingsDialog.scheduleAdd")}</button>}
    </div>}
    {automation.mode === "shuffle" && <div className="automation-detail"><RefreshFrequency value={automation.shuffleMinutes}
      onCommit={shuffleMinutes => onChange({ ...automation, shuffleMinutes })} /></div>}
  </div>;
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
  pane,
  engine
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens on this pane. Empty leaves the sheet on whichever one it was left showing. */
  pane?: string;
  /** With the assistant pane: the engine row to unfold and bring into view. */
  engine?: string;
}) {
  const { t, tx, locale } = useI18n();
  const qc = useQueryClient();
  const settings = useSettings();
  const sections = useSettingsSections(locale);
  const save = useSaveSettings();
  const mcp = useMcpUrl();
  const cacheDir = useCacheDir();
  const hub = useHubInfo();
  const background = useBackgroundStatus();
  const providers = useStorageProviders();
  const { preference, customThemes, automation, setAutomation, createCustomTheme, deleteCustomTheme } = useTheme();
  const [active, setActive] = useState("appearance");
  // Set only by a pane that sends the person to find a plugin; any other way in opens the list unfiltered.
  const [pluginsQuery, setPluginsQuery] = useState<string>();
  const go = (id: string, query?: string) => {
    setPluginsQuery(query);
    setActive(id);
  };
  const [editingTheme, setEditingTheme] = useState<string | null>(null);
  const [themeDraft, setThemeDraft] = useState({ name: "", icon: "i-sliders" as CustomTheme["icon"] });
  const openThemeEditor = (theme: CustomTheme) => {
    if (editingTheme === theme.id) return;
    setThemeDraft({ name: theme.name, icon: theme.icon ?? "i-sliders" });
    setEditingTheme(theme.id);
  };

  // The palette sends you straight to a pane; ⌘, leaves you on the last one.
  useEffect(() => {
    if (open && pane) go(pane);
  }, [open, pane]);
  useSettingsSheet(open, go);
  // A destination's account is asked for where it is used — in a project's own
  // settings — so the section behind it is storage, not a screen. Whoever claims
  // one draws it; this dialog does not draw it twice.
  const claimed = new Set((providers.data ?? []).map((p) => p.settingsSection).filter(Boolean) as string[]);
  const pluginSections = (sections.data ?? []).filter((s) => !HAND_DRAWN.has(s.id) && !claimed.has(s.id));
  const scopeOf = (id: string) => sections.data?.find((s) => s.id === id)?.scope;
  const selectedCustom = preference.startsWith("custom:") ? customThemes.find(theme => theme.id === preference) : undefined;
  const updateCustom = (change: (theme: CustomTheme) => CustomTheme) => {
    if (!settings.data || !selectedCustom) return;
    save.mutate({ ...settings.data, customThemes: customThemes.map(theme => theme.id === selectedCustom.id ? change(theme) : theme) });
  };
  const resolvedValue = (name: string) => selectedCustom
    ? (selectedCustom.tokens[name as ThemeTokenName] ?? selectedCustom.fonts[name as ThemeTypographyName] ?? "")
    : (typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim());

  const TOKENS: [MessageKey, ThemeTokenName, MessageKey][] = [
    ["settingsDialog.tokenCanvas", "bg", "settingsDialog.tokenCanvasWhere"],
    ["settingsDialog.tokenSurface", "surface", "settingsDialog.tokenSurfaceWhere"],
    ["settingsDialog.tokenRaised", "surface-warm", "settingsDialog.tokenRaisedWhere"],
    ["settingsDialog.tokenPrimaryText", "fg", "settingsDialog.tokenPrimaryTextWhere"],
    ["settingsDialog.tokenSubtext", "muted", "settingsDialog.tokenSubtextWhere"],
    ["settingsDialog.tokenMetadata", "meta", "settingsDialog.tokenMetadataWhere"],
    ["settingsDialog.tokenBorder", "border", "settingsDialog.tokenBorderWhere"],
    ["settingsDialog.tokenAccent", "accent", "settingsDialog.tokenAccentWhere"],
    ["settingsDialog.tokenFg2", "fg-2", "settingsDialog.tokenFg2Where"],
    ["settingsDialog.tokenBorderSoft", "border-soft", "settingsDialog.tokenBorderSoftWhere"],
    ["settingsDialog.tokenAccentOn", "accent-on", "settingsDialog.tokenAccentOnWhere"],
    ["settingsDialog.tokenAccentLight", "accent-light", "settingsDialog.tokenAccentLightWhere"],
    ["settingsDialog.tokenAccentActive", "accent-active", "settingsDialog.tokenAccentActiveWhere"],
    ["settingsDialog.tokenSuccess", "success", "settingsDialog.tokenSuccessWhere"],
    ["settingsDialog.tokenWarn", "warn", "settingsDialog.tokenWarnWhere"],
    ["settingsDialog.tokenDanger", "danger", "settingsDialog.tokenDangerWhere"],
    ["settingsDialog.tokenTagFaint", "tag-bg-faint", "settingsDialog.tokenTagFaintWhere"],
    ["settingsDialog.tokenTagSoft", "tag-bg-soft", "settingsDialog.tokenTagSoftWhere"],
    ["settingsDialog.tokenTagBase", "tag-bg-base", "settingsDialog.tokenTagBaseWhere"],
    ["settingsDialog.tokenTagStrong", "tag-bg-strong", "settingsDialog.tokenTagStrongWhere"],
    ["settingsDialog.tokenTagFg", "tag-fg", "settingsDialog.tokenTagFgWhere"]
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
          <div className="appearance-theme-heading"><h3 className="appearance-group-title">{t("settingsDialog.themeSelectionTitle")}</h3><div className="theme-selection-row"><ThemeSwitch selectedEditor={
            selectedCustom && editingTheme === selectedCustom.id && <div className="theme-custom-controls" role="group" aria-label={t("settingsDialog.editTheme")}
              onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setEditingTheme(null); } }}>
              <ThemeIconMenu value={themeDraft.icon} onChange={icon => setThemeDraft(draft => ({ ...draft, icon }))} />
              <label className="token-theme-name"><input className="field-input" aria-label={t("settingsDialog.themeNameLabel")} value={themeDraft.name} maxLength={64}
                onChange={event => setThemeDraft(draft => ({ ...draft, name: event.target.value }))} /></label>
              <button type="button" className="btn" disabled={!themeDraft.name.trim() || save.isPending} onClick={() => {
                if (!settings.data) return;
                save.mutate({ ...settings.data, customThemes: customThemes.map(theme => theme.id === selectedCustom.id ? { ...theme, name: themeDraft.name.trim(), icon: themeDraft.icon } : theme) },
                  { onSuccess: () => setEditingTheme(null) });
              }}>{t("common.save")}</button>
              <button type="button" className="icon-btn danger" aria-label={t("settingsDialog.deleteTheme")} title={t("settingsDialog.deleteTheme")} onClick={() => { deleteCustomTheme(selectedCustom.id); setEditingTheme(null); }}><Icon name="i-trash" size={14} /></button>
            </div>
          } /><div className="theme-selection-actions">
            {selectedCustom && <button type="button" className="icon-btn" aria-label={t("settingsDialog.editTheme")} title={t("settingsDialog.editTheme")} onClick={() => openThemeEditor(selectedCustom)}><Icon name="i-pen" size={14} /></button>}
            <button type="button" className="icon-btn" aria-label={t("settingsDialog.createTheme")} title={t("settingsDialog.createTheme")} onClick={() => createCustomTheme(openThemeEditor)}><Icon name="i-plus" size={14} /></button>
          </div></div></div>
          <ThemePreview customThemes={customThemes} />
          <ThemeAutomationPanel automation={automation} themes={customThemes} onChange={setAutomation} />

          <hr className="rule" />
          <SectionHead title={t("settingsDialog.tokensLabel")}>
            {selectedCustom ? t("settingsDialog.customTokensLede") : t("settingsDialog.builtinTokensLede")}
          </SectionHead>
          <div className="panel" style={{ padding: "var(--space-2) var(--space-3)" }}>
            <table className="tok-table">
              <thead>
                <tr>
                  <th>{t("settingsDialog.colRole")}</th>
                  <th>{t("settingsDialog.colToken")}</th>
                  <th>{t("settingsDialog.colWhere")}</th>
                  <th>{t("settingsDialog.colValue")}</th>
                </tr>
              </thead>
              <tbody>
                {TOKENS.map(([roleKey, token, whereKey]) => (
                  <tr key={token}>
                    <td>{t(roleKey)}</td>
                    <td className="mono">--{token}</td>
                    <td>{t(whereKey)}</td>
                    <td><TokenEditor token={token} value={resolvedValue(token)} disabled={!selectedCustom}
                      onChange={value => updateCustom(theme => ({ ...theme, tokens: { ...theme.tokens, [token]: value } }))} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <hr className="rule" />
          <SectionHead title={t("settingsDialog.fontsLabel")}>{t("settingsDialog.fontsLede")}</SectionHead>
          <div className="panel token-fonts">
            {THEME_TYPOGRAPHY_NAMES.map(name => <FontEditor key={name} name={name} value={resolvedValue(name)} disabled={!selectedCustom}
              onChange={value => updateCustom(theme => ({ ...theme, fonts: { ...theme.fonts, [name]: value } }))} />)}
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
    // Only while the keybindings row runs: without it there is nowhere to keep a rebinding.
    ...(sections.data?.some((s) => s.id === "keybindings")
      ? [
          {
            id: "keybindings",
            label: t("shortcuts.title"),
            icon: "i-keyboard" as IconId,
            group: "app" as const,
            render: () => (settings.data ? <KeybindingsPane settings={settings.data} onSave={(next) => save.mutateAsync(next)} scopeTag={<ScopeTag scope={scopeOf("keybindings")} />} /> : null)
          }
        ]
      : []),
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
            onFindEngines={() => go("plugins", "engine")}
            focusEngine={open ? engine : undefined}
          />
        ) : null
    },
    { id: "usage", label: t("usage.label"), icon: "i-bars" as IconId, group: "app" as const, render: () => <UsagePane /> },
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
                {t("settingsDialog.mcpNote")}
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
                <li>{tx("settingsDialog.undoBullet", { cmdz: <Num>{keyLabel("undo")}</Num> })}</li>
              </ul>
            </div>
          </div>
        </>
      )
    },
    // Drawn only while the plugin that owns the section is loaded.
    ...(sections.data?.some((s) => s.id === "mcpServers")
      ? [{ id: "mcpServers", label: t("mcpServers.label"), icon: "i-plug" as IconId, group: "app" as const, render: () => <McpServersPane /> }]
      : []),
    // Only in the desktop app, while the background row runs.
    ...(background.data
      ? [{ id: "background", label: t("background.label"), icon: "i-moon" as IconId, group: "app" as const, render: () => <BackgroundPane scopeTag={<ScopeTag scope="machine" />} /> }]
      : []),
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
    { id: "about", label: t("about.label"), icon: "i-info", group: "app", render: () => <AboutPane /> },
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
            onSave={(next) => (settings.data ? save.mutateAsync({ ...settings.data, [section.id]: next }) : Promise.resolve())}
          >
            {PANE_EXTRAS[section.id]?.()}
          </PluginPane>
        )
      })
    ),
    { id: "plugins", label: t("settingsDialog.manageLabel"), icon: "i-plug", group: "plugins", render: () => <PluginsPanel query={pluginsQuery} onLeave={() => onOpenChange(false)} /> }
  ];

  // A plugin switched off takes its pane with it, so the menu falls back rather than emptying the body.
  const current = panes.find((p) => p.id === active) ?? panes[0];
  const rows = (group: Pane["group"]) =>
    panes
      .filter((p) => p.group === group)
      .map((p) => (
        <button key={p.id} type="button" className="side-row" aria-current={p.id === current.id} onClick={() => go(p.id)}>
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
        {/* Keyed so every pane opens at its top, not at the scroll offset of the one before. */}
        <DialogBody key={current.id}>{current.render()}</DialogBody>
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
const EMPTY_AGENT: AgentSettings = { defaultEngine: "tomrade", confirmWritesOver: 0, resumeAfterLimit: true, engines: {}, playbookChoices: {} };

/** Model profiles + role bindings + the default engine: the two halves of "who does the work". */
function AssistantPane({
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
  const [editing, setEditing] = useState<ModelProfile | null>(null);
  // removing a profile deletes its key too: asked once, in the row
  const [removing, setRemoving] = useState<string | null>(null);

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
              <span className="p-model num">{p.provider === "anthropic" ? "anthropic" : (p.baseURL ?? "")} · {p.model}</span>
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(p)}>
                {t("common.edit")}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setRemoving(p.id)}>
                {t("common.remove")}
              </button>
            </div>
          )
        )}
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
          {(engines.data ?? []).filter(conducts).map((e) => (
            <EngineRow
              key={e.id}
              engine={e}
              isDefault={findEngine(engines.data, agent.defaultEngine)?.id === e.id}
              focused={focusEngine === e.id}
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
        <p className="meta-txt" data-testid="more-engines">
          {enginesOff.length
            ? tx("settingsDialog.moreEnginesOff", { list: <span className="mono">{enginesOff.map((p) => p.id).join(", ")}</span> })
            : t("settingsDialog.moreEngines")}{" "}
          <button type="button" className="link-btn" onClick={onFindEngines}>
            {t("settingsDialog.moreEnginesLink")}
          </button>
        </p>
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
  onCommit: (key: string, value: string) => void;
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
  // a terminal-only CLI conducts no conversation to try
  const canTry = !engine.terminalOnly;
  const hasBody = hasPicks || !!engine.cli || canTry;
  const toggle = () => hasBody && setOpen((o) => !o);
  const status = engineStatus(engine);
  return (
    <div className="eng-row" ref={row} data-engine={engine.id}>
      <div className={`eng-head${hasBody ? " eng-head-toggle" : ""}`} onClick={toggle}>
        <label className="eng-pick" onClick={(e) => e.stopPropagation()}>
          {/* a terminal-only CLI conducts no conversation, so it cannot be the default */}
          <input type="radio" className="bs-radio" name="defaultEngine" checked={isDefault} onChange={onMakeDefault} disabled={engine.terminalOnly} />
          <span>{engine.title}</span>
          {engine.terminalOnly && <span className="meta-txt">{t("settingsDialog.terminalOnly")}</span>}
        </label>
        <span className={`meta-txt eng-state${status === "ready" || status === "other" ? "" : " is-warn"}`} title={engine.ok ? undefined : engine.reason}>
          {engine.cli ? engineStateLabel(engine, t, t("settingsDialog.engineUnavailable")) : engine.ok ? t("settingsDialog.engineReady") : (engine.reason ?? t("settingsDialog.engineUnavailable"))}
        </span>
        {hasBody && (
          <button type="button" className="btn btn-icon" aria-expanded={open} aria-label={t("settingsDialog.engineToggleAria", { title: engine.title })}>
            <Icon name={open ? "i-chevdown" : "i-chev"} size={12} />
          </button>
        )}
      </div>
      {open && engine.cli && (
        <div className="eng-body">
          <LocalCliSection engine={engine} cli={engine.cli} command={typeof options.command === "string" ? options.command : ""} onSaveCommand={(value) => onCommit("command", value)} />
        </div>
      )}
      {open && engine.mcpLink && (
        <div className="eng-body">
          <McpLinkSection engine={engine} />
        </div>
      )}
      {open && canTry && (
        <div className="eng-body">
          <EngineTryRow engine={engine} command={typeof options.command === "string" ? options.command : undefined} />
        </div>
      )}
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

/** Where each well-known provider hands out keys, by the host its profile talks to. */
const KEY_PAGES: Record<string, string> = {
  "api.deepseek.com": "https://platform.deepseek.com/api_keys",
  "api.anthropic.com": "https://console.anthropic.com/settings/keys",
  "api.openai.com": "https://platform.openai.com/api-keys",
  "api.moonshot.cn": "https://platform.moonshot.cn/console/api-keys",
  "openrouter.ai": "https://openrouter.ai/keys"
};

const hostOf = (p: ModelProfile): string => {
  if (p.provider === "anthropic" && !p.baseURL) return "api.anthropic.com";
  try {
    return new URL(p.baseURL ?? "").host;
  } catch {
    return p.baseURL ?? "";
  }
};

function ProfileForm({ profile, onSave, onCancel }: { profile: ModelProfile; onSave: (p: ModelProfile) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ModelProfile>(profile);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<{ kind: ModelErrorKind; detail: string } | null>(null);
  const set = (patch: Partial<ModelProfile>) => {
    setProblem(null);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const valid = draft.model.trim().length > 0 && (draft.provider !== "anthropic" || draft.apiKey.trim().length > 0);
  const host = hostOf(draft);
  const keyPage = KEY_PAGES[host];
  const candidate = (): ModelProfile => ({ ...draft, title: draft.title || draft.model });
  // A wrong key or address shows here, at save, not in the first conversation. A rate limit means the key works.
  const checkAndSave = async () => {
    setChecking(true);
    setProblem(null);
    try {
      const result = await invoke("llm.test", candidate());
      if (result.ok || result.kind === "rate") onSave(candidate());
      else setProblem(result);
    } catch {
      onSave(candidate());
    } finally {
      setChecking(false);
    }
  };
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
            <option value="openai-images">{t("agentPanel.imageApi")}</option>
          </select>
        </div>
      </div>
      <div className="grid-2">
        {draft.provider !== "anthropic" && (
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
        <PlainSecretNote />
        <span className="meta-txt">
          {t("settingsDialog.localEndpointNote")}
          {keyPage && (
            <>
              {" "}
              <button type="button" className="link-inline" onClick={() => openExternal(keyPage)}>
                {t("settingsDialog.getApiKey", { host })}
              </button>
            </>
          )}
        </span>
      </div>
      {problem && (
        <div className="profile-problem" role="alert">
          <p>{t(`settingsDialog.profileCheck_${problem.kind}` as MessageKey, { host: host || t("settingsDialog.theEndpoint"), model: draft.model })}</p>
          <details className="ai-error-details">
            <summary>{t("agentPanel.errorDetails")}</summary>
            <code>{problem.detail}</code>
          </details>
        </div>
      )}
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-secondary" disabled={!valid || checking} aria-busy={checking} onClick={() => void checkAndSave()}>
          {checking ? t("settingsDialog.profileChecking") : t("settingsDialog.saveProfile")}
        </button>
        {problem && (
          <button type="button" className="btn btn-ghost" onClick={() => onSave(candidate())}>
            {t("settingsDialog.profileSaveAnyway")}
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          {t("common.cancel")}
        </button>
      </div>
      {draft.provider !== "openai-images" && <fieldset className="field">
        <legend>{t("agentPanel.modelMediaInput")}</legend>
        <p className="meta-txt">{t("agentPanel.modelMediaHelp")}</p>
        {(["image", "pdf", ...(draft.provider === "openai-compatible" ? ["audio", "video"] : [])] as NonNullable<ModelProfile["inputModalities"]>).map(mode => {
          const selected = draft.inputModalities ?? (draft.provider === "anthropic" ? ["image", "pdf"] : []);
          return <label key={mode}><input type="checkbox" checked={selected.includes(mode)} onChange={event => set({ inputModalities: event.target.checked ? [...selected, mode] : selected.filter(value => value !== mode) })} /> {mode}</label>;
        })}
      </fieldset>}
      {draft.provider === "openai-compatible" && <fieldset className="field">
        <legend>{t("agentPanel.modelMediaOutput")}</legend>
        <p className="meta-txt">{t("agentPanel.modelMediaOutputHelp")}</p>
        {(["image", "audio"] as const).map(mode => <label key={mode}><input type="checkbox" checked={draft.outputModalities?.includes(mode) ?? false} onChange={event => set({ outputModalities: event.target.checked ? [mode] : [] })} /> {mode}</label>)}
      </fieldset>}
    </div>
  );
}
