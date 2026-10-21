import type { ReactNode } from "react";
import { SectionHead } from "~/components/ui/atoms";
import { openLoginSettings, useBackgroundStatus, useSetBackground, type BackgroundStatus } from "~/lib/background";
import { useI18n, type MessageKey } from "~/lib/i18n";

/** Whether Tomrade keeps working with its window closed, and whether that part starts at login. */
export function BackgroundPane({ scopeTag }: { scopeTag?: ReactNode }) {
  const { t } = useI18n();
  const status = useBackgroundStatus();
  const set = useSetBackground();
  const s = status.data;

  return (
    <>
      <SectionHead title={t("background.title")} aside={scopeTag}>
        {t("background.lede")}
      </SectionHead>
      {s && (
        <div className="panel background-prefs">
          <div className="background-pref" data-pref="keepRunning">
            <div>
              <div className="background-pref-name">{t("background.keepRunning")}</div>
              <p className="meta-txt">{t("background.keepRunningNote")}</p>
              {s.keepRunning && s.platform === "linux" && <p className="meta-txt">{t("background.trayNoteLinux")}</p>}
            </div>
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={s.keepRunning}
              aria-label={t("background.keepRunning")}
              disabled={set.isPending}
              onClick={() => set.mutate({ keepRunning: !s.keepRunning })}
            />
          </div>
          <div className="background-pref" data-pref="startAtLogin">
            <div>
              <div className="background-pref-name">{t("background.startAtLogin")}</div>
              <p className="meta-txt">{t("background.startAtLoginNote")}</p>
              <LoginNote status={s} />
            </div>
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={s.keepRunning && s.startAtLogin}
              aria-label={t("background.startAtLogin")}
              disabled={set.isPending || !s.keepRunning || s.login.kind === "unavailable"}
              onClick={() => set.mutate({ startAtLogin: !s.startAtLogin })}
            />
          </div>
        </div>
      )}
    </>
  );
}

const UNAVAILABLE_KEY: Record<Extract<BackgroundStatus["login"], { kind: "unavailable" }>["reason"], MessageKey> = {
  checkout: "background.checkout",
  location: "background.location",
  unsupported: "background.unsupported"
};

/** What stands between the switch and an actual start at login, and where to put it right. */
function LoginNote({ status: s }: { status: BackgroundStatus }) {
  const { t } = useI18n();
  const settingsButton = s.platform === "darwin" || s.platform === "win32";
  let text: string | null = null;
  let action = false;
  if (s.error) text = t("background.failed", { message: s.error });
  else if (s.login.kind === "unavailable") text = t(UNAVAILABLE_KEY[s.login.reason]);
  else if (!s.keepRunning) text = t("background.needsKeepRunning");
  else if (s.startAtLogin && s.login.kind === "approval") {
    text = t("background.approval");
    action = settingsButton;
  } else if (s.startAtLogin && s.login.kind === "disabled") {
    text = t(s.platform === "win32" ? "background.disabledWin" : s.platform === "darwin" ? "background.disabledMac" : "background.disabledLinux");
    action = settingsButton;
  }
  if (!text) return null;
  return (
    <div className="background-login-note" data-login={s.login.kind}>
      <p className="meta-txt" role="status">
        {text}
      </p>
      {action && (
        <button type="button" className="btn btn-ghost" onClick={() => void openLoginSettings()}>
          {t("background.openSettings")}
        </button>
      )}
    </div>
  );
}
