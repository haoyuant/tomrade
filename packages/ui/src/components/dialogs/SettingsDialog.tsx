import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { SettingsSectionView } from "@tomradex/settings";
import { useQueryClient } from "@tanstack/react-query";
import { Icon, type IconId } from "~/components/icons";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { LanguageSwitch } from "~/components/ui/language-switch";
import { AboutPane } from "./AboutPane";
import { KeybindingsPane } from "./KeybindingsPane";
import { UsagePane } from "./UsagePane";
import { BackgroundPane } from "./BackgroundPane";
import { HubPane } from "./HubPane";
import { McpServersPane } from "./McpServersPane";
import { ImPane } from "./ImPane";
import { PluginsPanel } from "./PluginsPanel";
import { AgentAccessSection } from "./settings/AgentAccessSection";
import { AssistantPane } from "./settings/AssistantPane";
import { PANE_EXTRAS, PluginPane } from "./settings/PluginPane";
import { ScopeTag } from "./settings/ScopeTag";
import { AppIconSection } from "./settings/AppIconSection";
import { ThemePane, useThemeEditor } from "./settings/ThemePane";
import { WebSearchPane } from "./settings/WebSearchPane";
import { Eyebrow, SectionHead, Tag } from "~/components/ui/atoms";
import { useBackgroundStatus } from "~/lib/background";
import { useI18n } from "~/lib/i18n";
import { reportAction } from "~/lib/analytics";
import { keys, useSaveSettings, useSettings, useSettingsSections, useStorageProviders } from "~/lib/queries";
import { useSettingsSheet } from "~/lib/settingsHost";
import { useWebSearchProviders } from "~/lib/web-search";
import { reportError } from "~/lib/toast";

/** Sections the dialog lays out by hand; every other registered section gets a pane drawn from its schema. */
// closedWindow is per project, drawn in each project's settings.
const HAND_DRAWN = new Set(["keybindings", "theme", "themeAutomation", "customThemes", "language", "models", "agent", "mcpServers", "im", "updates", "onboarding", "closedWindow"]);

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
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const settings = useSettings();
  const sections = useSettingsSections(locale);
  const save = useSaveSettings({ reportErrors: false });
  const background = useBackgroundStatus();
  const providers = useStorageProviders();
  const searchProviders = useWebSearchProviders();
  const [active, setActive] = useState("appearance");
  // Set only by a pane that sends the person to find a plugin; any other way in opens the list unfiltered.
  const [pluginsQuery, setPluginsQuery] = useState<string>();
  const go = (id: string, query?: string) => {
    setPluginsQuery(query);
    setActive(id);
  };
  const themeEditor = useThemeEditor();

  // The palette sends you straight to a pane; ⌘, leaves you on the last one.
  useEffect(() => {
    if (open && pane) go(pane);
    if (open) reportAction("settings", "open", pane || "appearance");
  }, [open, pane]);
  useSettingsSheet(open, go);
  // A destination's account is asked for where it is used — in a project's own
  // settings — so the section behind it is storage, not a screen. Whoever claims
  // one draws it; this dialog does not draw it twice.
  const claimed = new Set((providers.data ?? []).map((p) => p.settingsSection).filter(Boolean) as string[]);
  // A web search provider's own section is drawn on the Web search pane, not as a pane of its own.
  const searchSections = (sections.data ?? []).filter((s) => searchProviders.data?.some((p) => p.settings === s.id));
  const inWebSearch = new Set(searchSections.map((s) => s.id));
  const pluginSections = (sections.data ?? []).filter((s) => !HAND_DRAWN.has(s.id) && !claimed.has(s.id) && !inWebSearch.has(s.id));
  const scopeOf = (id: string) => sections.data?.find((s) => s.id === id)?.scope;
  const pluginPane = (section: SettingsSectionView) => (
    <PluginPane
      key={section.id}
      section={section}
      stored={settings.data?.[section.id]}
      onSave={(next) => (settings.data ? save.mutateAsync({ ...settings.data, [section.id]: next }) : Promise.resolve())}
    >
      {PANE_EXTRAS[section.id]?.()}
    </PluginPane>
  );

  const panes: Pane[] = [
    {
      id: "appearance",
      label: t("settingsDialog.appearanceLabel"),
      icon: "i-sun",
      group: "app",
      render: () => (
        <>
          <ThemePane scope={scopeOf("theme")} settings={settings} save={save} editor={themeEditor} lead={<AppIconSection />} onLeave={() => onOpenChange(false)} />
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
            onSave={(next) => save.mutate(next, { onSuccess: () => qc.invalidateQueries({ queryKey: keys.agent.engines }), onError: reportError })}
            onFindEngines={() => go("plugins", "engine")}
            focusEngine={open ? engine : undefined}
          />
        ) : null
    },
    { id: "usage", label: t("usage.label"), icon: "i-bars" as IconId, group: "app" as const, render: () => <UsagePane /> },
    // Drawn only while the plugin that owns the section is loaded. One pane for MCP both ways:
    // Tomrade's own server, which agents reach, above the servers Tomrade reaches.
    ...(sections.data?.some((s) => s.id === "mcpServers")
      ? [{ id: "mcpServers", label: t("mcpServers.label"), icon: "i-plug" as IconId, group: "app" as const, render: () => <><AgentAccessSection /><hr className="rule" /><McpServersPane /></> }]
      : []),
    // While web search runs: its providers, and the settings of those that keep their own.
    ...(searchProviders.data
      ? [
          {
            id: "webSearch",
            label: t("webSearch.label"),
            icon: "i-globe" as IconId,
            group: "app" as const,
            render: () => (
              <WebSearchPane providers={searchProviders.data ?? []} drawn={inWebSearch} onGo={go}>
                {searchSections.map((section) => (
                  <Fragment key={section.id}>
                    <hr className="rule" />
                    {pluginPane(section)}
                  </Fragment>
                ))}
              </WebSearchPane>
            )
          }
        ]
      : []),
    ...(sections.data?.some((s) => s.id === "im")
      ? [{ id: "im", label: t("imSettings.label"), icon: "i-send" as IconId, group: "app" as const, render: () => <ImPane scopeTag={<ScopeTag scope="machine" />} /> }]
      : []),
    // Only in the desktop app, while the background row runs.
    ...(background.data
      ? [{ id: "background", label: t("background.label"), icon: "i-moon" as IconId, group: "app" as const, render: () => <BackgroundPane scopeTag={<ScopeTag scope="machine" />} /> }]
      : []),
    // Where everything lives: the Hub folder, its remote, and the cache under it.
    {
      id: "hub",
      label: t("settingsDialog.hubLabel"),
      icon: "i-home",
      group: "app",
      render: () => <HubPane />
    },
    { id: "about", label: t("about.label"), icon: "i-info", group: "app", render: () => <AboutPane /> },
    ...pluginSections.map(
      (section): Pane => ({
        id: section.id,
        label: section.title,
        icon: "i-plug",
        group: "plugins",
        render: () => pluginPane(section)
      })
    ),
    { id: "plugins", label: t("settingsDialog.manageLabel"), icon: "i-plug", group: "plugins", render: () => <PluginsPanel query={pluginsQuery} onLeave={() => onOpenChange(false)} /> }
  ];

  // A plugin switched off takes its pane with it, so the menu falls back rather than emptying the body.
  // Asked for a provider's own section (the search-unavailable card names one): the pane that draws it.
  const current = panes.find((p) => p.id === (inWebSearch.has(active) ? "webSearch" : active)) ?? panes[0];
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
    <Dialog open={open} onOpenChange={onOpenChange} label={t("settingsDialog.dialogLabel")} className="sheet-settings" resizable="settings" movable>
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
