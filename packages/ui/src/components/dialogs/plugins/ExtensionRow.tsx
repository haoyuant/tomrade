import { useState } from "react";
import type { PluginView } from "@tomrade/plugins";
import { Icon } from "~/components/icons";
import { Tag } from "~/components/ui/atoms";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { Menu, MenuActionItem } from "~/components/ui/menu";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useReload, useRollback, useSetAutoUpdate, useUndoVia, useUninstall } from "~/lib/plugins";
import { useSetPluginEnabled } from "~/lib/queries";
import { reveal } from "~/lib/shell";
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
  const on = plugin.state !== "disabled";
  const fail = (e: unknown) => setError(messageOf(e));
  const name = ext.dir.split(/[\\/]/).at(-1) ?? ext.id;

  return (
    <div className="plug-ext" data-id={plugin.id}>
      <div className={cn("cfg-row", !on && "off")}>
        <Icon name="i-plug" size={15} style={{ color: plugin.state === "failed" ? "var(--danger)" : on ? "var(--accent)" : "var(--meta)" }} />
        <div className="cfg-name">
          {ext.title} <span className="meta-txt mono">{ext.id}</span> <span className="meta-txt">{t("plugins.version", { version: ext.version })}</span>
          <div className="row plug-tags" style={{ gap: 6, marginTop: 3 }}>
            <TrustTags tier={ext.tier} risk={ext.risk.level} reviewedAs={null} />
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
