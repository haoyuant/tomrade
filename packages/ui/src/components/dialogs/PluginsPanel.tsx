import { useState } from "react";
import type { ModuleView, PluginView } from "@tomrade/plugins";
import { Icon } from "~/components/icons";
import { Eyebrow, SectionHead, Tag } from "~/components/ui/atoms";
import { usePlugins, useSetPluginEnabled } from "~/lib/queries";
import { cn } from "~/lib/utils";

const TONE: Record<PluginView["state"], "faint" | "neutral" | "strong"> = {
  active: "strong",
  pending: "neutral",
  failed: "neutral",
  disabled: "faint"
};

const LABEL: Record<PluginView["state"], string> = {
  active: "running",
  pending: "waiting",
  failed: "failed",
  disabled: "off"
};

/** The one line under a row that says what it is doing, or why it is not. */
function detailOf(plugin: PluginView): string {
  if (plugin.state === "failed" && plugin.error) return plugin.error;
  if (plugin.state === "pending") return `Waiting for ${plugin.waitingFor?.join(", ") ?? "a service that never arrived"}`;
  const parts: string[] = [];
  if (plugin.provides.length) parts.push(`Provides ${plugin.provides.join(", ")}`);
  if (plugin.injects.length) parts.push(`needs ${plugin.injects.join(", ")}`);
  return parts.length ? parts.join(" · ") : "Adds to what is already there — it provides no service of its own";
}

function ModuleTable({ modules }: { modules: ModuleView[] }) {
  return (
    <div className="panel" style={{ padding: "var(--space-2) var(--space-3)" }}>
      <table className="tok-table">
        <thead>
          <tr>
            <th>Module</th>
            <th>Provided by</th>
            <th>Kind</th>
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
              <td className="mono">{module.providers.join(", ") || "nothing"}</td>
              <td>{module.required ? "Required" : "Optional"}</td>
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
  const on = plugin.state !== "disabled";
  const locked = plugin.holds.length > 0;
  // Stated once in the lede above, so the row carries only which modules it
  // holds; the sentence lives on the control that will not move.
  const why = locked ? `The only plugin providing ${plugin.holds.join(", ")}. Add another provider before switching it off.` : undefined;
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
          <div className="meta-txt dense">{detailOf(plugin)}</div>
        </div>
        {locked && (
          <Tag tone="faint" title={why}>
            {`holds ${plugin.holds.join(", ")}`}
          </Tag>
        )}
        <Tag tone={TONE[plugin.state]}>{LABEL[plugin.state]}</Tag>
        <button
          type="button"
          className="switch"
          role="switch"
          aria-checked={on}
          aria-label={`Enable ${plugin.id}`}
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
      <SectionHead title="Modules">
        A module is a capability, named by the service key that carries it. Which plugin fills one is never declared — it is read off the running
        context, so a plugin that loads further plugins is credited with what they provide. A required module may not be left empty.
      </SectionHead>
      <ModuleTable modules={modules} />
      {unfilled.length > 0 && (
        <p className="meta-txt dense" style={{ marginTop: "var(--space-3)", color: "var(--danger)" }}>
          Nothing provides {unfilled.map((m) => m.title).join(", ")}. The app is running without {unfilled.length > 1 ? "them" : "it"}.
        </p>
      )}

      <hr className="rule" />
      {/* `.tag` is a flex box, so whitespace between elements would be dropped: one string. */}
      <SectionHead title="Installed" aside={<Tag tone="neutral">{`${running} of ${rows.length} running`}</Tag>}>
        One row per plugin, in the order the composition lists them. A switch takes effect at once: the plugin unloads with its tools, channels,
        badges and settings panes, and everything that injected it goes too. The choice is written to your patch file, so it survives a restart. A
        plugin that holds up a required module on its own has no switch to throw — the module would be left empty.
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
      {!rows.length && <p className="meta-txt">Nothing to show — the composition has not been read.</p>}

      <hr className="rule" />
      <SectionHead title="Adding one" />
      <div className="panel">
        <Eyebrow>Not from here — yet</Eyebrow>
        <ul className="dash" style={{ marginTop: "var(--space-3)" }}>
          <li>
            A plugin is a row in <span className="mono">tomrade.yml</span>, or in your own <span className="mono">tomrade.patch.yml</span>, which
            may add rows the app does not ship.
          </li>
          <li>
            Swapping the plugin behind a required module is a change of <span className="mono">name</span> on its row: a service key has one owner,
            so a replacement cannot be switched on beside the plugin it replaces.
          </li>
          <li>Browsing and installing from here is a later thing. This pane manages what is already listed.</li>
        </ul>
      </div>
    </>
  );
}
