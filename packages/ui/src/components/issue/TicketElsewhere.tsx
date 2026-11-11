import { LiveDot } from "~/components/ui/atoms";
import { elsewhereOn, useDevices } from "~/lib/devices";
import { agoLabel } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";

/** Another of the account's machines holds this ticket: says which, and how it stands there. Nothing without one. */
export function TicketElsewhere({ projectId, itemKey }: { projectId: string; itemKey: string }) {
  const { t } = useI18n();
  const devices = useDevices();
  const found = elsewhereOn(devices.data?.devices, projectId, itemKey);
  if (!found) return null;
  const { device, session } = found;
  if (!device.online) {
    return <p className="ticket-elsewhere last" data-testid="ticket-elsewhere">{t("devices.elsewhereLast", { name: device.name, time: agoLabel(device.activityAt ?? device.lastSeenAt) })}</p>;
  }
  return (
    <p className="ticket-elsewhere" data-testid="ticket-elsewhere">
      <LiveDot />
      {t(`devices.elsewhere_${session.state}`, { name: device.name })}
    </p>
  );
}
