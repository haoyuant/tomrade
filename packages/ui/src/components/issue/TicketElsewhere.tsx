import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DispatchView } from "@tomradex/dispatch";
import type { DeviceView } from "@tomradex/hub-cloud";
import { LiveDot } from "~/components/ui/atoms";
import { invoke } from "~/lib/api";
import { dispatchOf, elsewhereOn, useDevices, useDispatches } from "~/lib/devices";
import { agoLabel } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { keys } from "~/lib/queries";
import { errorSpec, useToast } from "~/lib/toast";

const PLATFORM_WORDS: Record<string, MessageKey> = { darwin: "devices.platform_darwin", win32: "devices.platform_win32", linux: "devices.platform_linux" };
/** The reasons a machine gives for turning a ticket away, as it names them. */
const REFUSALS = new Set(["off", "project-not-allowed", "project-missing", "permission", "busy", "not-idle", "on-battery", "no-agent", "start"]);
/** A request that is over stays on the ticket this long. */
const SHOWN_MS = 24 * 3_600_000;

/**
 * Where else the ticket is: sent to another of the account's computers and how that stands, with the way to
 * take it back; or held by a session on another computer. Nothing when neither.
 */
export function TicketElsewhere({ projectId, itemKey }: { projectId: string; itemKey: string }) {
  const { t } = useI18n();
  const devices = useDevices();
  const dispatches = useDispatches();
  const sent = dispatchOf(dispatches.data, projectId, itemKey);
  const going = sent && (sent.state === "queued" || sent.state === "accepted" || sent.state === "running");
  const found = elsewhereOn(devices.data?.devices, projectId, itemKey);
  // While it runs there, the session's own line says more than the request's.
  const session = found && (!sent || sent.state === "running" || !going) ? found : null;
  return (
    <>
      {sent && (going || Date.now() - sent.updatedAt < SHOWN_MS) && !(sent.state === "running" && session?.device.online) && <SentLine sent={sent} devices={devices.data?.devices ?? []} />}
      {session && (
        session.device.online ? (
          <p className="ticket-elsewhere" data-testid="ticket-elsewhere">
            <LiveDot />
            {t(`devices.elsewhere_${session.session.state}`, { name: session.device.name })}
            {sent?.state === "running" && <TakeBack id={sent.id} />}
          </p>
        ) : (
          <p className="ticket-elsewhere last" data-testid="ticket-elsewhere">{t("devices.elsewhereLast", { name: session.device.name, time: agoLabel(session.device.activityAt ?? session.device.lastSeenAt) })}</p>
        )
      )}
    </>
  );
}

function SentLine({ sent, devices }: { sent: DispatchView; devices: DeviceView[] }) {
  const { t } = useI18n();
  const id = sent.claimedBy ?? sent.toDevice;
  const name = devices.find((d) => d.id === id)?.name ?? (id ? id : t("devices.anyOf", { platform: sent.toPlatform && PLATFORM_WORDS[sent.toPlatform] ? t(PLATFORM_WORDS[sent.toPlatform]!) : (sent.toPlatform ?? "") }));
  // A refusal reads `code` or `code: what more there is to say`.
  const [code, ...rest] = (sent.reason ?? "").split(": ");
  const why = () => {
    if (!REFUSALS.has(code ?? "")) return sent.reason ?? "";
    const words = t(`devices.refusal_${code}` as MessageKey);
    return rest.length ? `${words} (${rest.join(": ")})` : words;
  };
  const text =
    sent.state === "refused" ? t("devices.sentRefused", { name, reason: why() })
    : sent.state === "cancelled" ? t(sent.reason === "expired" ? "devices.sentExpired" : "devices.sentCancelled")
    : sent.state === "done" ? (sent.reason ? t("devices.sentStopped", { name, reason: sent.reason }) : t("devices.sentDone", { name }))
    : t(`devices.sent_${sent.state}` as MessageKey, { name });
  const going = sent.state === "queued" || sent.state === "accepted" || sent.state === "running";
  return (
    <p className={`ticket-elsewhere${going ? "" : " last"}`} data-testid="ticket-sent" data-state={sent.state}>
      {going && <LiveDot />}
      {text}
      {going && <TakeBack id={sent.id} />}
    </p>
  );
}

function TakeBack({ id }: { id: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => invoke("dispatch.cancel", id),
    onSuccess: (list) => qc.setQueryData(keys.dispatches, list),
    onError: (error) => toast(errorSpec(error))
  });
  return (
    <button type="button" className="status-link" data-testid="ticket-sent-cancel" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
      {t("devices.sentCancel")}
    </button>
  );
}
