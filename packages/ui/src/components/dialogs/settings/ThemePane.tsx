import { useEffect, useState, type CSSProperties } from "react";
import { THEME_TYPOGRAPHY_NAMES, type CustomTheme, type ThemeAutomation, type ThemePreference, type ThemeTokenName, type ThemeTypographyName } from "@tomradex/domain";
import { Icon, type IconId } from "~/components/icons";
import { SectionHead } from "~/components/ui/atoms";
import { ThemeSwitch } from "~/components/ui/theme-switch";
import { STATUS } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { isCancelKey, isCommitKey } from "~/lib/keys";
import type { useSaveSettings, useSettings } from "~/lib/queries";
import { cssColorToHex, useTheme } from "~/lib/theme";
import { useToast } from "~/lib/toast";
import { ScopeTag } from "./ScopeTag";

/** Each preview re-declares the token block locally, so all built-in themes are
 *  visible at once — the clearest proof that one class swaps the lot. */
function ThemePreview({ customThemes }: { customThemes: CustomTheme[] }) {
  const { t } = useI18n();
  const modes: { id: string; cls: string; name: string; hex: string; style?: CSSProperties }[] = [
    { id: "sunrise", cls: "sunrise", name: t("theme.sunrise"), hex: "#f6f3f8" },
    { id: "daybreak", cls: "daybreak", name: t("theme.daybreak"), hex: "#120f24" },
    { id: "glass", cls: "glass", name: t("theme.glass"), hex: "#2b2826" },
    { id: "sakura", cls: "sakura", name: t("theme.sakura"), hex: "#fbf3f4" },
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

function TokenEditor({ token, value, onChange }: { token: ThemeTokenName; value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <div className="token-value">
    <input type="color" className="token-picker" aria-label={`Pick --${token}`} value={cssColorToHex(draft || value)}
      onChange={(event) => { setDraft(event.target.value); onChange(event.target.value); }} />
    <input className="field-input token-input" aria-label={`--${token}`} value={draft}
      onChange={(event) => setDraft(event.target.value)} onBlur={() => draft.trim() && onChange(draft.trim())} />
  </div>;
}

function FontEditor({ name, value, onChange }: { name: ThemeTypographyName; value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <label className="token-font-field"><span className="mono">--{name}</span>
    <input className="field-input" value={draft} onChange={event => setDraft(event.target.value)}
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
    <option value="sunrise">{t("theme.sunrise")}</option><option value="daybreak">{t("theme.daybreak")}</option><option value="glass">{t("theme.glass")}</option><option value="sakura">{t("theme.sakura")}</option><option value="dawn">{t("theme.dawn")}</option><option value="light">{t("theme.paper")}</option><option value="dark">{t("theme.ink")}</option><option value="matcha">{t("theme.matcha")}</option>
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
        onKeyDown={event => { if (isCommitKey(event)) { event.preventDefault(); commit(); } }} />
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

/** Kept by the dialog, not the pane, so a theme's open edit row survives a switch to another pane. */
export function useThemeEditor() {
  const [editingTheme, setEditingTheme] = useState<string | null>(null);
  const [themeDraft, setThemeDraft] = useState({ name: "", icon: "i-sliders" as CustomTheme["icon"] });
  const openThemeEditor = (theme: CustomTheme) => {
    if (editingTheme === theme.id) return;
    setThemeDraft({ name: theme.name, icon: theme.icon ?? "i-sliders" });
    setEditingTheme(theme.id);
  };
  return { editingTheme, setEditingTheme, themeDraft, setThemeDraft, openThemeEditor };
}

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

export function ThemePane({
  scope,
  settings,
  save,
  editor: { editingTheme, setEditingTheme, themeDraft, setThemeDraft, openThemeEditor }
}: {
  scope: "machine" | "user" | undefined;
  settings: ReturnType<typeof useSettings>;
  save: ReturnType<typeof useSaveSettings>;
  editor: ReturnType<typeof useThemeEditor>;
}) {
  const { t } = useI18n();
  const { preference, customThemes, automation, setAutomation, createCustomTheme, deleteCustomTheme } = useTheme();
  const toast = useToast();
  const selectedCustom = preference.startsWith("custom:") ? customThemes.find(theme => theme.id === preference) : undefined;
  const updateCustom = (change: (theme: CustomTheme) => CustomTheme) => {
    if (!settings.data || !selectedCustom) return;
    save.mutate({ ...settings.data, customThemes: customThemes.map(theme => theme.id === selectedCustom.id ? change(theme) : theme) });
  };
  const resolvedValue = (name: string) => selectedCustom?.tokens[name as ThemeTokenName] ?? selectedCustom?.fonts[name as ThemeTypographyName] ?? "";
  return (
    <>
      <SectionHead title={t("settingsDialog.appearanceLabel")} aside={<ScopeTag scope={scope} />}>
        {t("settingsDialog.appearanceLede")}
      </SectionHead>
      <div className="appearance-theme-heading"><h3 className="appearance-group-title">{t("settingsDialog.themeSelectionTitle")}</h3><div className="theme-selection-row"><ThemeSwitch selectedEditor={
        selectedCustom && editingTheme === selectedCustom.id && <div className="theme-custom-controls" role="group" aria-label={t("settingsDialog.editTheme")}
          onKeyDown={event => { if (isCancelKey(event)) { event.stopPropagation(); setEditingTheme(null); } }}>
          <ThemeIconMenu value={themeDraft.icon} onChange={icon => setThemeDraft(draft => ({ ...draft, icon }))} />
          <label className="token-theme-name"><input className="field-input" aria-label={t("settingsDialog.themeNameLabel")} value={themeDraft.name} maxLength={64}
            onChange={event => setThemeDraft(draft => ({ ...draft, name: event.target.value }))} /></label>
          <button type="button" className="btn" disabled={!themeDraft.name.trim() || save.isPending} onClick={() => {
            if (!settings.data) return;
            save.mutate({ ...settings.data, customThemes: customThemes.map(theme => theme.id === selectedCustom.id ? { ...theme, name: themeDraft.name.trim(), icon: themeDraft.icon } : theme) },
              { onSuccess: () => setEditingTheme(null) });
          }}>{t("common.save")}</button>
          <button type="button" className="icon-btn danger" aria-label={t("settingsDialog.deleteTheme")} title={t("settingsDialog.deleteTheme")} onClick={() => {
            // The edited colours are the loss; Undo brings the theme back whole.
            const undo = deleteCustomTheme(selectedCustom.id);
            setEditingTheme(null);
            toast({ body: t("settingsDialog.themeDeletedToast", { name: selectedCustom.name }), onUndo: undo });
          }}><Icon name="i-trash" size={14} /></button>
        </div>
      } /><div className="theme-selection-actions">
        {selectedCustom && <button type="button" className="icon-btn" aria-label={t("settingsDialog.editTheme")} title={t("settingsDialog.editTheme")} onClick={() => openThemeEditor(selectedCustom)}><Icon name="i-pen" size={14} /></button>}
        <button type="button" className="icon-btn" aria-label={t("settingsDialog.createTheme")} title={t("settingsDialog.createTheme")} onClick={() => createCustomTheme(openThemeEditor)}><Icon name="i-plus" size={14} /></button>
      </div></div></div>
      <ThemePreview customThemes={customThemes} />
      <ThemeAutomationPanel automation={automation} themes={customThemes} onChange={setAutomation} />

      {/* Built-in themes are read-only, so their tokens are nothing to edit: the tables come with a custom theme. */}
      {selectedCustom && (
        <>
          <hr className="rule" />
          <SectionHead title={t("settingsDialog.tokensLabel")}>{t("settingsDialog.customTokensLede")}</SectionHead>
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
                    <td><TokenEditor token={token} value={resolvedValue(token)}
                      onChange={value => updateCustom(theme => ({ ...theme, tokens: { ...theme.tokens, [token]: value } }))} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <hr className="rule" />
          <SectionHead title={t("settingsDialog.fontsLabel")}>{t("settingsDialog.fontsLede")}</SectionHead>
          <div className="panel token-fonts">
            {THEME_TYPOGRAPHY_NAMES.map(name => <FontEditor key={name} name={name} value={resolvedValue(name)}
              onChange={value => updateCustom(theme => ({ ...theme, fonts: { ...theme.fonts, [name]: value } }))} />)}
          </div>
        </>
      )}
    </>
  );
}
