import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Item } from "@tomradex/domain";
import { invoke } from "~/lib/api";
import { PLATFORM_LABELS, deviceLabel, labelMiss, runOnState, useDevices, type RunTarget } from "~/lib/devices";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { invalidateWorkspace, keys, useHubInfo } from "~/lib/queries";
import { openSettingsPane } from "~/lib/settingsHost";
import { errorSpec, useToast } from "~/lib/toast";

const PLATFORM_WORDS: Record<string, MessageKey> = { darwin: "devices.platform_darwin", win32: "devices.platform_win32", linux: "devices.platform_linux" };
/** What is missing while this computer is the only place to run, and the Settings pane that mends it. */
const ONLY_HERE: Record<"signed-out" | "alone" | "out", { hint: MessageKey; pane?: "hub" | "devices" }> = {
  "signed-out": { hint: "devices.runOnSignedOut", pane: "hub" },
  alone: { hint: "devices.runOnAlone" },
  out: { hint: "devices.runOnOut", pane: "devices" }
};
const UNABLE: Record<"not-accepting" | "project", MessageKey> = { "not-accepting": "devices.runOnNotAccepting", project: "devices.runOnOtherProject" };
/**
 * Start's choice of where the ticket runs: this computer, another that accepts work, or any of a platform.
 * Sent elsewhere, it starts there with that computer's own agent and within its limits. While no other
 * computer could take it, the row stays and says what is missing, so the choice can be found.
 */
export function RunOn({ projectId, item, target, onTarget, onClose }: { projectId: string; item: Item; target: RunTarget; onTarget: (target: RunTarget) => void; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const hub = useHubInfo();
  const devices = useDevices();
  const state = useMemo(() => runOnState(hub.data?.cloudEnabled, devices.data, projectId), [hub.data?.cloudEnabled, devices.data, projectId]);
  const able = useMemo(() => (state.kind === "choose" ? state.others.filter((o) => !o.why).map((o) => o.device) : []), [state]);
  const platforms = useMemo(() => [...new Set(able.map((d) => d.platform))].filter((p) => PLATFORM_WORDS[p]), [able]);
  const [remember, setRemember] = useState(false);
  const chosen = able.find((d) => d.id === target);
  const platform = target.startsWith("platform:") ? target.slice("platform:".length) : null;
  const send = useMutation({
    mutationFn: async () => {
      const sent = await invoke("dispatch.send", { projectId, itemId: item.id, ...(platform ? { platform } : { to: target }) });
      if (remember) {
        const label = platform ? PLATFORM_LABELS[platform] : chosen ? deviceLabel(chosen.name) : null;
        const kept = item.labels.filter((l) => !Object.values(PLATFORM_LABELS).includes(l.toLowerCase()) && !l.toLowerCase().startsWith("device:"));
        if (label) await invoke("items.update", projectId, item.id, { labels: [...kept, label] }, item.version);
      }
      return sent;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.dispatches });
      invalidateWorkspace(qc, projectId);
      toast({ body: t("devices.sentTo", { name: chosen?.name ?? t("devices.anyOf", { platform: platform ? t(PLATFORM_WORDS[platform]!) : "" }) }) });
      onClose();
    },
    onError: (error) => toast(errorSpec(error))
  });
  if (item.workType === "general" || state.kind === "hidden") return null;
  const miss = labelMiss(item, projectId, devices.data);
  // The label asked for a computer that cannot take it: said, so a ticket meant for elsewhere does not start here unnoticed.
  const missed = miss && (
    <p className="meta-txt" role="note" data-testid="run-on-miss">
      {t("devices.missNote", {
        ask: miss.platform ? t("devices.missAskPlatform", { label: miss.label, platform: PLATFORM_WORDS[miss.platform] ? t(PLATFORM_WORDS[miss.platform]!) : miss.platform }) : t("devices.missAskDevice", { label: miss.label }),
        why: miss.why === "nobody" ? t(miss.platform ? "devices.missWhy_nobodyPlatform" : "devices.missWhy_nobodyDevice") : t(`devices.missWhy_${miss.why}`, { name: miss.name })
      })}
    </p>
  );
  const settings = (pane: "hub" | "devices") => (
    <button type="button" className="link-btn" data-testid="run-on-settings" onClick={() => { onClose(); openSettingsPane(pane); }}>
      {t(pane === "hub" ? "devices.runOnOpenHub" : "devices.runOnOpenDevices")}
    </button>
  );
  if (state.kind !== "choose") {
    const only = ONLY_HERE[state.kind];
    return (
      <div className="run-on stack-3" data-testid="run-on" data-state={state.kind}>
        <div className="run-on-row">
          <span className="run-on-name">{t("devices.runOn")}</span>
          <span className="meta-txt">{t("devices.thisComputer")}</span>
        </div>
        <p className="meta-txt" data-testid="run-on-hint">{t(only.hint)} {only.pane && settings(only.pane)}</p>
        {missed}
      </div>
    );
  }
  const unable = state.others.filter((o) => o.why);
  const remote = target !== "here";
  return (
    <div className="run-on stack-3" data-testid="run-on" data-state={able.length ? "choose" : "no-taker"}>
      <label className="run-on-row">
        <span className="run-on-name">{t("devices.runOn")}</span>
        <select className="input" data-testid="run-on-select" value={target} onChange={(e) => onTarget(e.target.value)}>
          <option value="here">{t("devices.thisComputer")}</option>
          {able.map((d) => <option key={d.id} value={d.id}>{d.online ? d.name : t("devices.runOnOffline", { name: d.name })}</option>)}
          {platforms.map((p) => <option key={p} value={`platform:${p}`}>{t("devices.anyOf", { platform: t(PLATFORM_WORDS[p]!) })}</option>)}
          {unable.map(({ device, why }) => <option key={device.id} value={device.id} disabled>{t(UNABLE[why!], { name: device.name })}</option>)}
        </select>
      </label>
      {!able.length && <p className="meta-txt" data-testid="run-on-hint">{t("devices.runOnNoTaker")} {settings("devices")}</p>}
      {!remote && missed}
      {remote && (
        <>
          <p className="meta-txt" data-testid="run-on-note">
            {t(chosen && !chosen.online ? "devices.runOnNoteOffline" : "devices.runOnNote")}
          </p>
          <label className="accept-check"><input type="checkbox" checked={remember} onChange={() => setRemember((v) => !v)} /><span>{t("devices.runOnRemember")}</span></label>
          <div>
            <button type="button" className="btn btn-primary" data-testid="run-on-send" disabled={send.isPending} onClick={() => send.mutate()}>
              {t("devices.send", { name: chosen?.name ?? t("devices.anyOf", { platform: platform ? t(PLATFORM_WORDS[platform]!) : "" }) })}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
