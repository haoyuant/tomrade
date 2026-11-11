import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Item } from "@tomradex/domain";
import { invoke } from "~/lib/api";
import { PLATFORM_LABELS, deviceLabel, takers, useDevices, type RunTarget } from "~/lib/devices";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { invalidateWorkspace, keys } from "~/lib/queries";
import { errorSpec, useToast } from "~/lib/toast";

const PLATFORM_WORDS: Record<string, MessageKey> = { darwin: "devices.platform_darwin", win32: "devices.platform_win32", linux: "devices.platform_linux" };
/**
 * Start's choice of where the ticket runs: this computer, another that accepts work, or any of a platform.
 * Sent elsewhere, it starts there with that computer's own agent and within its limits. Nothing shows while
 * no other computer could take it.
 */
export function RunOn({ projectId, item, target, onTarget, onSent }: { projectId: string; item: Item; target: RunTarget; onTarget: (target: RunTarget) => void; onSent: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const devices = useDevices();
  const able = useMemo(() => takers(devices.data?.devices, projectId), [devices.data, projectId]);
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
      onSent();
    },
    onError: (error) => toast(errorSpec(error))
  });
  if (item.workType === "general" || !able.length) return null;
  const remote = target !== "here";
  return (
    <div className="run-on stack-3" data-testid="run-on">
      <label className="run-on-row">
        <span className="run-on-name">{t("devices.runOn")}</span>
        <select className="input" data-testid="run-on-select" value={target} onChange={(e) => onTarget(e.target.value)}>
          <option value="here">{t("devices.thisComputer")}</option>
          {able.map((d) => <option key={d.id} value={d.id}>{d.online ? d.name : t("devices.runOnOffline", { name: d.name })}</option>)}
          {platforms.map((p) => <option key={p} value={`platform:${p}`}>{t("devices.anyOf", { platform: t(PLATFORM_WORDS[p]!) })}</option>)}
        </select>
      </label>
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
