import { useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Item } from "@tomradex/domain";
import { invoke } from "~/lib/api";
import type { Role } from "@tomradex/roles";
import { PLATFORM_LABELS, deviceLabel, labelMiss, runOnState, useDevices, useSharedDevices, whyNotShared, type RunTarget, type Unable } from "~/lib/devices";
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
const UNABLE: Record<Unable, MessageKey> = { "not-accepting": "devices.runOnNotAccepting", project: "devices.runOnOtherProject", "role-agent": "devices.runOnNoRoleAgent", "role-limit": "devices.runOnBelowRole" };
/**
 * Start's choice of where the ticket runs: this computer, another that accepts work, or any of a platform.
 * Sent elsewhere, it starts there with that computer's own agent and within its limits, as the role it is
 * worked as when one is given. While no other computer could take it, the row stays and says what is missing,
 * so the choice can be found.
 */
export function RunOn({ projectId, item, target, role, sendRole, lead, sendSlot, onTarget, onClose }: { /** Where the dialog keeps its main action: Send goes there, where Start is when the ticket starts here. */ sendSlot?: HTMLElement | null; projectId: string; item: Item; target: RunTarget; /** The role the ticket is worked as. */ role?: Role | null; /** Whether the role goes with the ticket: the built-in one nobody changed says nothing. */ sendRole?: boolean; /** The row above this one, in the same block: the role's. */ lead?: ReactNode; onTarget: (target: RunTarget) => void; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const hub = useHubInfo();
  const devices = useDevices();
  const state = useMemo(() => runOnState(hub.data?.cloudEnabled, devices.data, projectId, role), [hub.data?.cloudEnabled, devices.data, projectId, role]);
  const able = useMemo(() => (state.kind === "choose" ? state.others.filter((o) => !o.why).map((o) => o.device) : []), [state]);
  const platforms = useMemo(() => [...new Set(able.map((d) => d.platform))].filter((p) => PLATFORM_WORDS[p]), [able]);
  const [remember, setRemember] = useState(false);
  const chosen = able.find((d) => d.id === target);
  const platform = target.startsWith("platform:") ? target.slice("platform:".length) : null;
  // Computers other people share with this account: each is its owner's, and says whose.
  const shared = useSharedDevices(item.workType !== "general");
  const lent = useMemo(() => (shared.data ?? []).map((device) => ({ device, why: whyNotShared(device, projectId, role) })), [shared.data, projectId, role]);
  const borrowed = target.startsWith("share:") ? (lent.find((l) => l.device.share === target.slice("share:".length) && !l.why)?.device ?? null) : null;
  const lentName = (d: { name: string; owner: string }) => t("devices.sharedName", { name: d.name, owner: d.owner });
  const send = useMutation({
    mutationFn: async () => {
      const sent = await invoke("dispatch.send", { projectId, itemId: item.id, ...(borrowed ? { share: borrowed.share } : platform ? { platform } : { to: target }), ...(role && sendRole ? { role: role.id } : {}) });
      if (remember && !borrowed) {
        const label = platform ? PLATFORM_LABELS[platform] : chosen ? deviceLabel(chosen.name) : null;
        const kept = item.labels.filter((l) => !Object.values(PLATFORM_LABELS).includes(l.toLowerCase()) && !l.toLowerCase().startsWith("device:"));
        if (label) await invoke("items.update", projectId, item.id, { labels: [...kept, label] }, item.version);
      }
      return sent;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.dispatches });
      invalidateWorkspace(qc, projectId);
      toast({ body: t("devices.sentTo", { name: borrowed ? lentName(borrowed) : (chosen?.name ?? t("devices.anyOf", { platform: platform ? t(PLATFORM_WORDS[platform]!) : "" })) }) });
      onClose();
    },
    onError: (error) => toast(errorSpec(error))
  });
  if (item.workType === "general" || (state.kind === "hidden" && !lent.length)) return lead ? <div className="run-on stack-3">{lead}</div> : null;
  const miss = labelMiss(item, projectId, devices.data, role);
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
  if (state.kind !== "choose" && state.kind !== "hidden" && !lent.length) {
    const only = ONLY_HERE[state.kind];
    return (
      <div className="run-on stack-3" data-testid="run-on" data-state={state.kind}>
        {lead}
        <div className="run-on-row">
          <span className="run-on-name">{t("devices.runOn")}</span>
          <span className="meta-txt">{t("devices.thisComputer")}</span>
        </div>
        <p className="meta-txt" data-testid="run-on-hint">{t(only.hint)} {only.pane && settings(only.pane)}</p>
        {missed}
      </div>
    );
  }
  const unable = state.kind === "choose" ? state.others.filter((o) => o.why) : [];
  const remote = target !== "here";
  const sendTo = borrowed ? lentName(borrowed) : (chosen?.name ?? t("devices.anyOf", { platform: platform ? t(PLATFORM_WORDS[platform]!) : "" }));
  return (
    <div className="run-on stack-3" data-testid="run-on" data-state={able.length || lent.some((l) => !l.why) ? "choose" : "no-taker"} data-remote={remote ? "" : undefined}>
      {lead}
      <label className="run-on-row">
        <span className="run-on-name">{t("devices.runOn")}</span>
        <select className="input" data-testid="run-on-select" value={target} onChange={(e) => onTarget(e.target.value)}>
          <option value="here">{t("devices.thisComputer")}</option>
          {able.map((d) => <option key={d.id} value={d.id}>{d.online ? d.name : t("devices.runOnOffline", { name: d.name })}</option>)}
          {platforms.map((p) => <option key={p} value={`platform:${p}`}>{t("devices.anyOf", { platform: t(PLATFORM_WORDS[p]!) })}</option>)}
          {unable.map(({ device, why }) => <option key={device.id} value={device.id} disabled>{t(UNABLE[why!], { name: device.name, role: role?.title ?? "" })}</option>)}
          {lent.length > 0 && (
            <optgroup label={t("devices.sharedGroup")}>
              {lent.map(({ device, why }) => (
                <option key={device.share} value={`share:${device.share}`} disabled={!!why}>{why ? t(UNABLE[why], { name: lentName(device), role: role?.title ?? "" }) : lentName(device)}</option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      {!able.length && state.kind === "choose" && <p className="meta-txt" data-testid="run-on-hint">{t("devices.runOnNoTaker")} {settings("devices")}</p>}
      {!remote && missed}
      {remote && (
        <>
          <p className="meta-txt" data-testid="run-on-note">
            {borrowed ? t(borrowed.auto ? "devices.runOnSharedAuto" : "devices.runOnSharedAsks", { owner: borrowed.owner }) : t(chosen && !chosen.online ? "devices.runOnNoteOffline" : "devices.runOnNote")}
            {role && sendRole && <> {t("devices.runOnAsRole", { role: role.title })}</>}
          </p>
          {!borrowed && <label className="accept-check"><input type="checkbox" checked={remember} onChange={() => setRemember((v) => !v)} /><span>{t("devices.runOnRemember")}</span></label>}
          {sendSlot && createPortal(
            <button type="button" className="btn btn-primary" data-testid="run-on-send" disabled={send.isPending} onClick={() => send.mutate()}>
              {t("devices.send", { name: sendTo })}
            </button>,
            sendSlot
          )}
        </>
      )}
    </div>
  );
}
