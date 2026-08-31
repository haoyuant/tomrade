import { useEffect, useState, type ReactNode } from "react";
import type { LlmSettings } from "@tomrade/domain";
import type { SettingsSectionView } from "@tomrade/settings";
import { Icon, type IconId } from "~/components/icons";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { LanguageSwitch } from "~/components/ui/language-switch";
import { ThemeSwitch } from "~/components/ui/theme-switch";
import { PluginsPanel } from "./PluginsPanel";
import { Eyebrow, LiveDot, Num, SectionHead, Tag } from "~/components/ui/atoms";
import { SchemaField, fieldsOf, type JsonSchema } from "~/components/ui/schema-form";
import { STATUS } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useDbPath, useMcpUrl, useSaveSettings, useSettings, useSettingsSections, useStorageProviders } from "~/lib/queries";

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
const HAND_DRAWN = new Set(["theme", "language", "llm"]);

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
      <SectionHead title={section.title}>{section.description}</SectionHead>
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
  const settings = useSettings();
  const sections = useSettingsSections();
  const save = useSaveSettings();
  const mcp = useMcpUrl();
  const dbPath = useDbPath();
  const providers = useStorageProviders();
  const [llm, setLlm] = useState<LlmSettings | null | undefined>(undefined);
  const [active, setActive] = useState("appearance");

  useEffect(() => {
    if (settings.data && llm === undefined) setLlm(settings.data.llm ?? null);
  }, [settings.data, llm]);

  // The palette sends you straight to a pane; ⌘, leaves you on the last one.
  useEffect(() => {
    if (open && pane) setActive(pane);
  }, [open, pane]);

  const commit = (patch: Partial<LlmSettings>) => {
    if (!settings.data || !llm) return;
    const next = { ...llm, ...patch };
    setLlm(next);
    save.mutate({ ...settings.data, llm: next });
  };
  // A destination's account is asked for where it is used — in a project's own
  // settings — so the section behind it is storage, not a screen. Whoever claims
  // one draws it; this dialog does not draw it twice.
  const claimed = new Set((providers.data ?? []).map((p) => p.settingsSection).filter(Boolean) as string[]);
  const pluginSections = (sections.data ?? []).filter((s) => !HAND_DRAWN.has(s.id) && !claimed.has(s.id));

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
          <SectionHead title={t("settingsDialog.appearanceLabel")}>{t("settingsDialog.appearanceLede")}</SectionHead>
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
          <SectionHead title={t("settingsDialog.languageLabel")}>{t("settingsDialog.languageLede")}</SectionHead>
          <div className="row" style={{ gap: "var(--space-3)", flexWrap: "wrap" }}>
            <LanguageSwitch />
            <p className="meta-txt">{t("settingsDialog.languageApplies")}</p>
          </div>
        </>
      )
    },
    ...(llm
      ? [
          {
            id: "assistant",
            label: t("settingsDialog.assistantLabel"),
            icon: "i-panel" as IconId,
            group: "app" as const,
            render: () => (
              <>
                <SectionHead title={t("settingsDialog.assistantLabel")}>{t("settingsDialog.assistantLede")}</SectionHead>
                <div className="panel stack-3">
                  <div className="grid-2">
                    <div className="field">
                      <label htmlFor="stBase">{t("settingsDialog.baseUrlLabel")}</label>
                      <input id="stBase" className="input num" value={llm.baseURL ?? ""} onChange={(e) => commit({ baseURL: e.target.value })} />
                    </div>
                    <div className="field">
                      <label htmlFor="stModel">{t("settingsDialog.modelLabel")}</label>
                      <input id="stModel" className="input num" value={llm.model ?? ""} onChange={(e) => commit({ model: e.target.value })} />
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="stKey">{t("settingsDialog.apiKeyLabel")}</label>
                    <input id="stKey" className="input num" type="password" value={llm.apiKey ?? ""} onChange={(e) => commit({ apiKey: e.target.value })} />
                    <span className="meta-txt">{t("settingsDialog.apiKeyNote")}</span>
                  </div>
                </div>
              </>
            )
          }
        ]
      : []),
    {
      id: "agents",
      label: t("settingsDialog.agentsLabel"),
      icon: "i-lock",
      group: "app",
      render: () => (
        <>
          <SectionHead title={t("settingsDialog.agentsLabel")}>{t("settingsDialog.agentsLede")}</SectionHead>
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
      id: "data",
      label: t("settingsDialog.dataLabel"),
      icon: "i-archive",
      group: "app",
      render: () => (
        <>
          <SectionHead title={t("settingsDialog.dataLabel")}>{t("settingsDialog.dataLede")}</SectionHead>
          <div className="panel">
            <div className="field">
              <label htmlFor="stDb">{t("settingsDialog.dbFileLabel")}</label>
              <input id="stDb" className="input num" readOnly value={dbPath.data ?? ""} />
              <span className="meta-txt">{t("settingsDialog.dbFileNote")}</span>
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
