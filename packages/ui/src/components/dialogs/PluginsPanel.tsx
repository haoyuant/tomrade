import { useState } from "react";
import type { ModuleView, PluginView } from "@tomrade/plugins";
import { Icon } from "~/components/icons";
import { SectionHead, Tag } from "~/components/ui/atoms";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useAddFolder, useInstallFile, useUpdates } from "~/lib/plugins";
import { usePlugins, useSetPluginEnabled } from "~/lib/queries";
import { pickDirectory, pickFiles } from "~/lib/shell";
import { useToast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import { BrowseTab } from "./plugins/BrowseTab";
import { ExtensionRow } from "./plugins/ExtensionRow";
import { MineTab } from "./plugins/MineTab";
import { UpdatesTab } from "./plugins/UpdatesTab";
import { messageOf } from "./plugins/parts";

const TONE: Record<PluginView["state"], "faint" | "neutral" | "strong"> = {
  active: "strong",
  pending: "neutral",
  failed: "neutral",
  disabled: "faint"
};

const LABEL_KEY: Record<PluginView["state"], MessageKey> = {
  active: "pluginsPanel.stateRunning",
  pending: "pluginsPanel.stateWaiting",
  failed: "pluginsPanel.stateFailed",
  disabled: "pluginsPanel.stateOff"
};

/** The one line under a row that says what it is doing, or why it is not. */
function useDetailOf(plugin: PluginView): string {
  const { t } = useI18n();
  if (plugin.state === "failed" && plugin.error) return plugin.error;
  if (plugin.state === "pending") return t("pluginsPanel.waitingFor", { list: plugin.waitingFor?.join(", ") ?? t("pluginsPanel.waitingForFallback") });
  const parts: string[] = [];
  if (plugin.provides.length) parts.push(t("pluginsPanel.provides", { list: plugin.provides.join(", ") }));
  if (plugin.injects.length) parts.push(t("pluginsPanel.needs", { list: plugin.injects.join(", ") }));
  return parts.length ? parts.join(" · ") : t("pluginsPanel.addsNothing");
}

function ModuleTable({ modules }: { modules: ModuleView[] }) {
  const { t } = useI18n();
  return (
    <div className="panel" style={{ padding: "var(--space-2) var(--space-3)" }}>
      <table className="tok-table">
        <thead>
          <tr>
            <th>{t("pluginsPanel.colModule")}</th>
            <th>{t("pluginsPanel.colProvidedBy")}</th>
            <th>{t("pluginsPanel.colKind")}</th>
          </tr>
        </thead>
        <tbody>
          {modules.map((module) => (
            <tr key={module.id}>
              <td>
                {/* svg is display:block by default here, so the mark and the name share a flex row. */}
                <span className="row" style={{ gap: 7 }}>
                  {module.providers.length ? (
                    <Icon name="i-check" size={13} style={{ color: "var(--accent)" }} aria-label="filled" />
                  ) : (
                    <Icon name="i-warn" size={13} style={{ color: "var(--danger)" }} aria-label="unfilled" />
                  )}
                  {module.title}
                </span>
              </td>
              <td className="mono">{module.providers.join(", ") || t("pluginsPanel.nothing")}</td>
              <td>{module.required ? t("pluginsPanel.required") : t("pluginsPanel.optional")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PluginRow({
  plugin,
  error,
  busy,
  onToggle
}: {
  plugin: PluginView;
  error?: string;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const { t } = useI18n();
  const detail = useDetailOf(plugin);
  const on = plugin.state !== "disabled";
  const locked = plugin.holds.length > 0;
  // Stated once in the lede above, so the row carries only which modules it
  // holds; the sentence lives on the control that will not move.
  const why = locked ? t("pluginsPanel.holdsWhy", { list: plugin.holds.join(", ") }) : undefined;
  return (
    <>
      <div className={cn("cfg-row", !on && "off")} data-id={plugin.id}>
        <Icon
          name={locked ? "i-lock" : "i-plug"}
          size={15}
          style={{ color: plugin.state === "failed" ? "var(--danger)" : on ? "var(--accent)" : "var(--meta)" }}
        />
        <div className="cfg-name">
          {plugin.id} <span className="meta-txt mono">{plugin.name}</span>
          <div className="meta-txt dense">{detail}</div>
        </div>
        {locked && (
          <Tag tone="faint" title={why}>
            {t("pluginsPanel.holdsTag", { list: plugin.holds.join(", ") })}
          </Tag>
        )}
        <Tag tone={TONE[plugin.state]}>{t(LABEL_KEY[plugin.state])}</Tag>
        <button
          type="button"
          className="switch"
          role="switch"
          aria-checked={on}
          aria-label={t("pluginsPanel.enableAria", { id: plugin.id })}
          disabled={locked || busy}
          title={why}
          onClick={() => onToggle(!on)}
        />
      </div>
      {error && (
        <p className="meta-txt dense" style={{ margin: "5px 0 0 var(--space-3)", color: "var(--danger)" }}>
          {error}
        </p>
      )}
    </>
  );
}

type Tab = "installed" | "browse" | "updates" | "mine";

/**
 * Plugins: what is installed and what it may reach, the Community store, the
 * updates waiting, and the plugins an agent is writing with the person.
 *
 * A pane of Settings rather than a sheet of its own: everything here is reached
 * from the same menu as the cards these plugins draw, so a second overlay on
 * top of the first bought nothing.
 */
export function PluginsPanel({ onLeave }: { onLeave?: () => void }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("installed");
  const updates = useUpdates();
  const pendingUpdates = updates.data?.length ?? 0;
  const TABS: [Tab, MessageKey][] = [
    ["installed", "plugins.tabInstalled"],
    ["browse", "plugins.tabBrowse"],
    ["updates", "plugins.tabUpdates"],
    ["mine", "plugins.tabMine"]
  ];
  return (
    <>
      <div className="seg plug-tabs" role="tablist" aria-label={t("settingsDialog.manageLabel")} style={{ marginBottom: "var(--space-4)" }}>
        {TABS.map(([id, key]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} aria-pressed={tab === id} onClick={() => setTab(id)} data-tab={id}>
            {t(key)}
            {id === "updates" && pendingUpdates > 0 && <span className="plug-count">{pendingUpdates}</span>}
          </button>
        ))}
      </div>
      {tab === "installed" && <InstalledTab />}
      {tab === "browse" && <BrowseTab />}
      {tab === "updates" && <UpdatesTab />}
      {tab === "mine" && <MineTab onLeave={onLeave} />}
    </>
  );
}

function InstalledTab() {
  const { t } = useI18n();
  const toast = useToast();
  const plugins = usePlugins();
  const setEnabled = useSetPluginEnabled();
  const installFile = useInstallFile();
  const addFolder = useAddFolder();
  const [refused, setRefused] = useState<{ id: string; message: string } | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const all = plugins.data?.plugins ?? [];
  const rows = all.filter((p) => !p.extension);
  const extensions = all.filter((p) => p.extension);
  const modules = plugins.data?.modules ?? [];
  const running = rows.filter((p) => p.state === "active").length;
  const unfilled = modules.filter((m) => m.required && !m.providers.length);

  const toggle = (id: string, enabled: boolean) => {
    setRefused(null);
    setEnabled.mutate({ id, enabled }, { onError: (e) => setRefused({ id, message: e.message }) });
  };

  const fromFile = async () => {
    setInstallError(null);
    const [file] = (await pickFiles(t("plugins.pickFileTitle"), t("plugins.pickButton"))) ?? [];
    if (!file) return;
    installFile.mutate(file, {
      onSuccess: (snapshot) => {
        const added = snapshot.plugins.filter((p) => p.extension).sort((a, b) => (a.extension!.dir < b.extension!.dir ? 1 : -1))[0];
        toast({ body: t("plugins.installedFromFile", { title: added?.extension?.title ?? file, version: added?.extension?.version ?? "" }) });
      },
      onError: (e) => setInstallError(messageOf(e))
    });
  };

  const fromFolder = async () => {
    setInstallError(null);
    const dir = await pickDirectory(t("plugins.pickFolderTitle"), t("plugins.pickButton"));
    if (!dir) return;
    addFolder.mutate(dir, {
      onSuccess: (snapshot) => {
        const added = snapshot.plugins.find((p) => p.extension?.dir === dir);
        toast({ body: t("plugins.folderLoaded", { title: added?.extension?.title ?? dir }) });
      },
      onError: (e) => setInstallError(messageOf(e))
    });
  };

  return (
    <>
      <SectionHead
        title={t("plugins.extensionsTitle")}
        aside={
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <button type="button" className="btn btn-secondary" onClick={() => void fromFile()} disabled={installFile.isPending} data-testid="install-file">
              <Icon name="i-file" size={13} /> {t("plugins.installFile")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void fromFolder()} disabled={addFolder.isPending} data-testid="load-folder">
              <Icon name="i-folder" size={13} /> {t("plugins.loadFolder")}
            </button>
          </div>
        }
      >
        {t("plugins.extensionsLede")}
      </SectionHead>
      {installError && <p className="meta-txt" style={{ color: "var(--danger)", whiteSpace: "pre-wrap" }}>{installError}</p>}
      <div className="stack-2" data-testid="extensions">
        {extensions.map((plugin) => (
          <ExtensionRow key={plugin.id} plugin={plugin} />
        ))}
      </div>
      {!extensions.length && <p className="meta-txt">{t("plugins.noExtensions")}</p>}

      <hr className="rule" />
      <SectionHead title={t("pluginsPanel.modulesTitle")}>{t("pluginsPanel.modulesLede")}</SectionHead>
      <ModuleTable modules={modules} />
      {unfilled.length > 0 && (
        <p className="meta-txt dense" style={{ marginTop: "var(--space-3)", color: "var(--danger)" }}>
          {t("pluginsPanel.nothingProvides", {
            list: unfilled.map((m) => m.title).join(", "),
            pronoun: t(unfilled.length > 1 ? "pluginsPanel.pronounThem" : "pluginsPanel.pronounIt")
          })}
        </p>
      )}

      <hr className="rule" />
      {/* `.tag` is a flex box, so whitespace between elements would be dropped: one string. */}
      <SectionHead title={t("pluginsPanel.installedTitle")} aside={<Tag tone="neutral">{t("pluginsPanel.runningOfTotal", { running, total: rows.length })}</Tag>}>
        {t("pluginsPanel.installedLede")}
      </SectionHead>
      <div>
        {rows.map((plugin) => (
          <PluginRow
            key={plugin.id}
            plugin={plugin}
            busy={setEnabled.isPending}
            error={refused?.id === plugin.id ? refused.message : undefined}
            onToggle={(enabled) => toggle(plugin.id, enabled)}
          />
        ))}
      </div>
      {!rows.length && <p className="meta-txt">{t("pluginsPanel.emptyRows")}</p>}
    </>
  );
}
