import { useI18n } from "~/lib/i18n";
import { usePushStatus } from "~/lib/push";

/**
 * Under the notification settings: the last phone push that failed and why, so
 * a wrong address or an unreachable service is seen without the log. A push
 * that got through clears it.
 */
export function PushStatus() {
  const { t } = useI18n();
  const failure = usePushStatus().data;
  if (!failure) return null;
  return (
    <p className="meta-txt dense" role="status" style={{ color: "var(--danger)" }}>
      {t("settingsDialog.pushFailed", { channel: failure.channel, reason: failure.error })}
    </p>
  );
}
