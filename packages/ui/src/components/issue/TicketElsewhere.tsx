import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DispatchView } from "@tomradex/dispatch";
import type { DeviceView } from "@tomradex/hub-cloud";
import { LiveDot } from "~/components/ui/atoms";
import { invoke } from "~/lib/api";
import { dispatchOf, elsewhereOn, useDevices, useDispatches, useSharedDevices } from "~/lib/devices";
import { agoLabel } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useRoles } from "~/lib/roles";
import { keys } from "~/lib/queries";
import { errorSpec, useToast } from "~/lib/toast";

const PLATFORM_WORDS: Record<string, MessageKey> = { darwin: "devices.platform_darwin", win32: "devices.platform_win32", linux: "devices.platform_linux" };
/** The reasons a machine gives for turning a ticket away, as it names them. */
const REFUSALS = new Set(["off", "project-not-allowed", "project-missing", "permission", "busy", "not-idle", "on-battery", "no-agent", "start", "declined"]);
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
  const sent = dispatchOf(dispatches.data, projectId, itemKey, devices.data?.devices.find((d) => d.self)?.id);
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
  // A computer of another person's is named with whose it is.
  const lent = useSharedDevices(!!sent.fromEmail).data?.find((d) => d.deviceId === id);
  const name = devices.find((d) => d.id === id)?.name ?? (lent ? t("devices.sharedName", { name: lent.name, owner: lent.owner }) : id ? id : t("devices.anyOf", { platform: sent.toPlatform && PLATFORM_WORDS[sent.toPlatform] ? t(PLATFORM_WORDS[sent.toPlatform]!) : (sent.toPlatform ?? "") }));
  // A refusal reads `code` or `code: what more there is to say`.
  const [code, ...rest] = (sent.reason ?? "").split(": ");
  const why = () => {
    if (!REFUSALS.has(code ?? "")) return sent.reason ?? "";
    const words = t(`devices.refusal_${code}` as MessageKey);
    return rest.length ? `${words} (${rest.join(": ")})` : words;
  };
  const text =
    sent.state === "refused" ? t("devices.sentRefused", { name, reason: why() })
    : sent.state === "cancelled" ? (sent.reason === "unshared" ? t("devices.sentUnshared", { name }) : t(sent.reason === "expired" ? "devices.sentExpired" : "devices.sentCancelled"))
    : sent.state === "queued" && sent.needsYes && !sent.approved ? t("devices.sentAwaitsYes", { name })
    : sent.state === "done" ? (sent.reason ? t("devices.sentStopped", { name, reason: sent.reason }) : t("devices.sentDone", { name }))
    : t(`devices.sent_${sent.state}` as MessageKey, { name });
  const going = sent.state === "queued" || sent.state === "accepted" || sent.state === "running";
  // The role it was sent as, by its name while the project has it.
  const role = useRoles(sent.projectId, !!sent.wish.role).data?.find((r) => r.id === sent.wish.role);
  return (
    <p className={`ticket-elsewhere${going ? "" : " last"}`} data-testid="ticket-sent" data-state={sent.state}>
      {going && <LiveDot />}
      {text}
      {role && <span data-testid="ticket-sent-role"> · {t("roles.sessionRole", { role: role.title })}</span>}
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
