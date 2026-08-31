import { useState } from "react";
import type { ModuleView, PluginView } from "@tomrade/plugins";
import { Icon } from "~/components/icons";
import { Eyebrow, SectionHead, Tag } from "~/components/ui/atoms";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { usePlugins, useSetPluginEnabled } from "~/lib/queries";
import { cn } from "~/lib/utils";

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

/**
 * What is installed, what each row puts on the context, and the modules the app
 * may not be left without. Switching a row is live — cordis unloads it and
 * everything that injected it — so the only refusal is the one that would empty
 * a required module.
 *
 * A pane of Settings rather than a sheet of its own: everything here is reached
 * from the same menu as the cards these plugins draw, so a second overlay on
 * top of the first bought nothing.
 */
export function PluginsPanel() {
  const { t, tx } = useI18n();
  const plugins = usePlugins();
  const setEnabled = useSetPluginEnabled();
  const [refused, setRefused] = useState<{ id: string; message: string } | null>(null);

  const rows = plugins.data?.plugins ?? [];
  const modules = plugins.data?.modules ?? [];
  const running = rows.filter((p) => p.state === "active").length;
  const unfilled = modules.filter((m) => m.required && !m.providers.length);

  const toggle = (id: string, enabled: boolean) => {
    setRefused(null);
    setEnabled.mutate({ id, enabled }, { onError: (e) => setRefused({ id, message: e.message }) });
  };

  return (
    <>
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

      <hr className="rule" />
      <SectionHead title={t("pluginsPanel.addingTitle")} />
      <div className="panel">
        <Eyebrow>{t("pluginsPanel.notFromHereYet")}</Eyebrow>
        <ul className="dash" style={{ marginTop: "var(--space-3)" }}>
          <li>{tx("pluginsPanel.addingBullet1", { yml: <span className="mono">tomrade.yml</span>, patchYml: <span className="mono">tomrade.patch.yml</span> })}</li>
          <li>{tx("pluginsPanel.addingBullet2", { name: <span className="mono">name</span> })}</li>
          <li>{t("pluginsPanel.addingBullet3")}</li>
        </ul>
      </div>
    </>
  );
}
