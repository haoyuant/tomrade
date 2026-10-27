import { useState } from "react";
import { CLI_HOOK_COVERAGE, type CliHookEvent } from "@tomradex/plugin-sdk";
import type { FullModeInfo, PluginView, RangeMiss } from "@tomradex/plugins";
import { Icon } from "~/components/icons";
import { Tag } from "~/components/ui/atoms";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { Menu, MenuActionItem } from "~/components/ui/menu";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useAllowVersion, useReload, useRollback, useSetAutoUpdate, useUndoVia, useUninstall, useWithdrawVersion } from "~/lib/plugins";
import { useSetPluginEnabled } from "~/lib/queries";
import { restartApp, reveal } from "~/lib/shell";
import { useToast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import { ConfirmBuildDialog } from "./ConfirmBuildDialog";
import { Reach, TrustTags, messageOf, useCurrentProject } from "./parts";

const STATE_KEY: Record<PluginView["state"], MessageKey> = {
  active: "pluginsPanel.stateRunning",
  pending: "pluginsPanel.stateWaiting",
  failed: "pluginsPanel.stateFailed",
  disabled: "pluginsPanel.stateOff"
};

/** One extension: what it is, who vouches for it, what it can reach, and what can be done with it. */
export function ExtensionRow({ plugin }: { plugin: PluginView }) {
  const { t } = useI18n();
  const toast = useToast();
  const projectId = useCurrentProject();
  const ext = plugin.extension!;
  const setEnabled = useSetPluginEnabled();
  const reload = useReload();
  const rollback = useRollback();
  const autoUpdate = useSetAutoUpdate();
  const undo = useUndoVia(projectId);
  const [uninstalling, setUninstalling] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A row that failed to load is not running, so its switch reads off; switching it on tries it again.
  const on = plugin.state !== "disabled" && plugin.state !== "failed";
  const fail = (e: unknown) => setError(messageOf(e));
  const name = ext.dir.split(/[\\/]/).at(-1) ?? ext.id;

  return (
    <div className="plug-ext" data-id={plugin.id}>
      <div className={cn("cfg-row", !on && "off")}>
        <Icon name="i-plug" size={15} style={{ color: plugin.state === "failed" ? "var(--danger)" : on ? "var(--accent)" : "var(--meta)" }} />
        <div className="cfg-name">
          {ext.title} <span className="meta-txt mono">{ext.id}</span> <span className="meta-txt">{t("plugins.version", { version: ext.version })}</span>
          <div className="row plug-tags" style={{ gap: 6, marginTop: 3 }}>
            <TrustTags tier={ext.tier} risk={ext.risk.level} />
            {ext.pending && (
              <button type="button" className="btn btn-primary btn-xs" onClick={() => setConfirming(true)} data-testid="review-build">
                {t("plugins.reviewBuild")}
              </button>
            )}
          </div>
          {plugin.state === "failed" && plugin.error && !ext.pending && <div className="meta-txt dense" style={{ color: "var(--danger)" }}>{plugin.error}</div>}
          {ext.modified && <div className="meta-txt dense">{t("plugins.modified")}</div>}
        </div>
        <Tag tone={ext.pending ? "strong" : plugin.state === "active" ? "strong" : "neutral"}>{ext.pending ? t("plugins.pending") : t(STATE_KEY[plugin.state])}</Tag>
        <button
          type="button"
          className="switch"
          role="switch"
          aria-checked={on}
          aria-label={t("pluginsPanel.enableAria", { id: plugin.id })}
          disabled={setEnabled.isPending || !!ext.pending}
          onClick={() => setEnabled.mutate({ id: plugin.id, enabled: !on }, { onError: fail })}
        />
        <Menu
          label={ext.title}
          align="end"
          modal
          trigger={
            <button type="button" className="btn btn-icon" aria-label={t("plugins.details")}>
              <Icon name="i-sliders" size={13} />
            </button>
          }
        >
          {(ext.source === "folder" || ext.source === "studio") && <MenuActionItem icon={<Icon name="i-sync" size={13} />} name={t("plugins.reload")} onSelect={() => reload.mutate(plugin.id, { onError: fail })} />}
          {ext.previousVersion && <MenuActionItem icon={<Icon name="i-undo" size={13} />} name={t("plugins.rollback", { version: ext.previousVersion })} onSelect={() => rollback.mutate(plugin.id, { onError: fail })} />}
          {projectId && (
            <MenuActionItem
              icon={<Icon name="i-undo" size={13} />}
              name={t("plugins.undoWrites")}
              onSelect={() =>
                window.confirm(t("plugins.undoWritesConfirm", { title: ext.title })) &&
                undo.mutate(ext.namespace, {
                  onSuccess: (r) => {
                    toast({ body: r.reverted ? `${t("plugins.undoneWrites", { reverted: r.reverted, title: ext.title })}${r.kept.length ? ` · ${t("plugins.keptWrites", { kept: r.kept.length })}` : ""}` : t("plugins.undoneNothing", { title: ext.title }) });
                  },
                  onError: fail
                })
              }
            />
          )}
          {ext.source === "store" && (
            <MenuActionItem
              icon={<Icon name={ext.tier === "local" ? "i-lock" : "i-sync"} size={13} />}
              name={`${t("plugins.autoUpdate")}${ext.autoUpdate ? " ✓" : ""}`}
              onSelect={() => autoUpdate.mutate({ id: plugin.id, on: !ext.autoUpdate }, { onError: fail })}
            />
          )}
          <MenuActionItem icon={<Icon name="i-folder" size={13} />} name={t("plugins.reveal")} onSelect={() => reveal(ext.dir)} />
          <MenuActionItem icon={<Icon name="i-trash" size={13} />} name={t("plugins.uninstall")} onSelect={() => setUninstalling(true)} />
        </Menu>
      </div>
      <div className="plug-ext-reach">
        <Reach reasons={ext.risk.reasons} inject={ext.inject} hosts={ext.permissions.network.filter((h) => h !== "*")} />
      </div>
      {!!ext.outOfRange.length && <VersionRange id={plugin.id} title={ext.title} version={ext.version} misses={ext.outOfRange} />}
      {ext.full && <FullMode full={ext.full} refused={plugin.rowsRefused} />}
      {!!ext.agentHooks.length && <AgentHooks events={ext.agentHooks} />}
      {error && (
        <p className="meta-txt dense" style={{ margin: "5px 0 0 var(--space-3)", color: "var(--danger)" }}>
          {error}
        </p>
      )}
      {uninstalling && <UninstallDialog id={plugin.id} title={ext.title} onClose={() => setUninstalling(false)} />}
      {confirming && <ConfirmBuildDialog name={name} title={ext.title} onClose={() => setConfirming(false)} />}
    </div>
  );
}

const RANGE_KEY: Record<RangeMiss["kind"], MessageKey> = { tomrade: "plugins.rangeTomrade", sdk: "plugins.rangeSdk" };

/**
 * A plugin built for other versions than this one: it is refused until the person lets this exact
 * version run here anyway, warned that it may crash Tomrade or lose data, and can take that back.
 */
function VersionRange({ id, title, version, misses }: { id: string; title: string; version: string; misses: RangeMiss[] }) {
  const { t } = useI18n();
  const withdraw = useWithdrawVersion();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const granted = misses.every((m) => m.granted);
  return (
    <div className="plug-ext-reach" data-testid="version-range">
      {misses.map((m) => (
        <div key={m.kind} className="meta-txt dense">
          {t(RANGE_KEY[m.kind], { range: m.range, version: m.version })}
        </div>
      ))}
      {granted ? (
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <span className="meta-txt dense">{t("plugins.runsByExemption", { version })}</span>
          <button type="button" className="btn btn-ghost btn-xs" data-testid="withdraw-version" disabled={withdraw.isPending} onClick={() => withdraw.mutate(id, { onError: (e) => setError(messageOf(e)) })}>
            {t("plugins.withdrawExemption")}
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn-xs" data-testid="allow-version" onClick={() => setAsking(true)}>
          {t("plugins.runAnyway")}
        </button>
      )}
      {error && <p className="meta-txt dense" style={{ color: "var(--danger)" }}>{error}</p>}
      {asking && <AllowVersionDialog id={id} title={title} version={version} misses={misses} onClose={() => setAsking(false)} />}
    </div>
  );
}

function AllowVersionDialog({ id, title, version, misses, onClose }: { id: string; title: string; version: string; misses: RangeMiss[]; onClose: () => void }) {
  const { t } = useI18n();
  const allow = useAllowVersion();
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} label={t("plugins.runAnywayTitle", { title, version })} className="sheet-md">
      <DialogHead title={t("plugins.runAnywayTitle", { title, version })} />
      <DialogBody>
        {misses.map((m) => (
          <p key={m.kind}>{t(RANGE_KEY[m.kind], { range: m.range, version: m.version })}</p>
        ))}
        <p style={{ color: "var(--danger)" }}>{t("plugins.runAnywayRisk")}</p>
        <p className="meta-txt">{t("plugins.runAnywayScope", { title, version })}</p>
        {error && <p className="meta-txt" style={{ color: "var(--danger)" }}>{error}</p>}
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t("plugins.cancel")}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          data-testid="allow-version-confirm"
          disabled={allow.isPending}
          onClick={() => allow.mutate(id, { onSuccess: onClose, onError: (e) => setError(messageOf(e)) })}
        >
          {t("plugins.runAnywayConfirm")}
        </button>
      </DialogFoot>
    </Dialog>
  );
}

const HOOK_KEY: Record<CliHookEvent, MessageKey> = {
  "session-start": "plugins.agentHook_session-start",
  prompt: "plugins.agentHook_prompt",
  "pre-tool": "plugins.agentHook_pre-tool",
  "post-tool": "plugins.agentHook_post-tool",
  stop: "plugins.agentHook_stop",
  "session-end": "plugins.agentHook_session-end"
};

const ROW_KEY: Record<FullModeInfo["rows"][number]["change"], MessageKey> = {
  adds: "plugins.rowAdds",
  replaces: "plugins.rowReplaces",
  "switches-off": "plugins.rowSwitches-off",
  configures: "plugins.rowConfigures"
};

/** What a full-mode plugin does to Tomrade itself: its rows, who else changes them, and whether a restart is due. */
function FullMode({ full, refused }: { full: FullModeInfo; refused?: string[] }) {
  const { t } = useI18n();
  return (
    <div className="plug-ext-reach meta-txt dense" data-testid="full-mode">
      <p style={{ margin: 0 }}>{t("plugins.fullMode", { range: full.tomrade })}</p>
      {!!full.rows.length && (
        <ul className="dash">
          {full.rows.map((row) => (
            <li key={row.id}>
              {t(ROW_KEY[row.change], { id: row.id })}
              {!!row.alsoBy.length && ` · ${t("plugins.rowAlsoBy", { others: row.alsoBy.join(", ") })}`}
              {row.refused && <span style={{ color: "var(--danger)" }}>{` · ${t("plugins.rowRefused", { reason: row.refused })}`}</span>}
            </li>
          ))}
        </ul>
      )}
      {!!refused?.length && <p style={{ margin: 0, color: "var(--danger)" }}>{t("plugins.rowsRefused", { modules: refused.join(", ") })}</p>}
      {full.restart && (
        <p className="row" style={{ margin: 0, gap: 8 }}>
          {t("plugins.rowsRestart")}
          <button type="button" className="btn btn-xs" onClick={() => restartApp()}>
            {t("plugins.restartNow")}
          </button>
        </p>
      )}
    </div>
  );
}

const AGENT_NAMES: Record<string, string> = { "claude-code": "Claude Code", workbuddy: "WorkBuddy", dsh: "DeepSeek Harness", pi: "Pi", codex: "Codex", cursor: "Cursor", opencode: "OpenCode", hermes: "Hermes", gemini: "Gemini CLI" };

/** Which coding agents each of its hooks reaches: the ones that act on its answer, and the ones it only hears. */
function AgentHooks({ events }: { events: string[] }) {
  const { t } = useI18n();
  const names = (agents: readonly string[]) => agents.map((a) => AGENT_NAMES[a] ?? a).join(", ");
  return (
    <div className="plug-ext-reach meta-txt dense" data-testid="agent-hooks">
      <p style={{ margin: 0 }}>{t("plugins.agentHooks")}</p>
      <ul className="dash">
        {[...new Set(events)].flatMap((event) => {
          const reach = CLI_HOOK_COVERAGE[event as CliHookEvent];
          if (!reach) return [];
          return [
            <li key={event}>
              {t(HOOK_KEY[event as CliHookEvent])}
              {!!reach.answers.length && ` · ${t("plugins.agentHookAnswers", { agents: names(reach.answers) })}`}
              {` · ${t("plugins.agentHookSees", { agents: names(reach.sees) })}`}
            </li>
          ];
        })}
      </ul>
    </div>
  );
}

function UninstallDialog({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const uninstall = useUninstall();
  const [removeData, setRemoveData] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} label={t("plugins.uninstallTitle", { title })} className="sheet-md">
      <DialogHead title={t("plugins.uninstallTitle", { title })} />
      <DialogBody>
        <p>{t("plugins.uninstallLede")}</p>
        <label className="row" style={{ gap: 8, marginTop: "var(--space-3)" }}>
          <input type="checkbox" checked={removeData} onChange={(e) => setRemoveData(e.target.checked)} /> {t("plugins.removeData")}
        </label>
        {error && <p className="meta-txt" style={{ color: "var(--danger)" }}>{error}</p>}
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t("plugins.cancel")}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={uninstall.isPending}
          onClick={() =>
            uninstall.mutate(
              { id, removeData },
              {
                onSuccess: () => {
                  toast({ body: t("plugins.uninstalled", { title }) });
                  onClose();
                },
                onError: (e) => setError(messageOf(e))
              }
            )
          }
        >
          {t("plugins.uninstall")}
        </button>
      </DialogFoot>
    </Dialog>
  );
}
