import { useEffect, useRef, useState } from "react";
import { Icon } from "~/components/icons";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { useI18n } from "~/lib/i18n";
import { isWindows } from "~/lib/keys";
import { openSettingsPane } from "~/lib/settingsHost";
import { updatesOnScreen, useUpdateActions, useUpdateStatus } from "~/lib/updates";
import { SettingsDialog } from "./SettingsDialog";

/**
 * Says so once per version and step: a newer release is out, then it is
 * downloaded. Nothing happens until the person picks; Later leaves it to the
 * About pane — and, once downloaded, to the next quit. Download sends them to
 * the About pane, where the progress is. While that pane is open it already
 * says as much, so nothing pops up over it.
 */
export function UpdateNotice() {
  const { t, locale } = useI18n();
  const status = useUpdateStatus();
  const { download, install } = useUpdateActions();
  const seen = useRef(new Set<string>());
  const [shown, setShown] = useState<string | null>(null);
  // Sign-in and first-run setup host no Settings sheet: this one stands in, mounted once needed.
  const [ownSettings, setOwnSettings] = useState<boolean | null>(null);
  const phase = status.data?.phase;
  const key = phase?.kind === "available" || phase?.kind === "ready" ? `${phase.kind}:${phase.version}` : null;

  useEffect(() => {
    setShown(null);
    if (!key || seen.current.has(key)) return;
    seen.current.add(key);
    if (!updatesOnScreen()) setShown(key);
    // The phase object changes on every progress tick; the key is what decides.
  }, [key]);

  const open = shown !== null && shown === key;
  const close = () => setShown(null);
  const startDownload = () => {
    close();
    download.mutate();
    if (!openSettingsPane("about")) setOwnSettings(true);
  };
  const date = phase?.kind === "available" && phase.date ? new Date(phase.date).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" }) : null;

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && close()} label={t(phase?.kind === "ready" ? "about.noticeReadyTitle" : "about.noticeAvailableTitle")} className="sheet-sm update-notice">
        {open && phase && (phase.kind === "available" || phase.kind === "ready") && (
          <>
            <DialogHead title={t(phase.kind === "ready" ? "about.noticeReadyTitle" : "about.noticeAvailableTitle")} />
            <DialogBody className="update-notice-body">
              <img className="about-logo" src={`${import.meta.env.BASE_URL}logo.png`} alt="" draggable={false} />
              <div className="about-id">
                <div className="about-name">Tomrade {phase.version}</div>
                <p className="meta-txt">
                  {t("about.noticeCurrent", { version: status.data?.version ?? "" })}
                  {date && ` ${t("about.updateDate", { date })}`}
                </p>
                <p className="update-notice-note">{t(phase.kind === "ready" ? "about.noticeReadyNote" : "about.noticeAvailableNote")}</p>
                {phase.kind === "ready" && isWindows && <p className="update-notice-note">{t("about.windowsInstallNote")}</p>}
              </div>
            </DialogBody>
            <DialogFoot>
              <button type="button" className="btn btn-secondary" onClick={close}>
                {t("about.later")}
              </button>
              {phase.kind === "available" ? (
                <button type="button" autoFocus className="btn btn-primary" onClick={startDownload}>
                  <Icon name="i-download" size={13} />
                  {t("about.download")}
                </button>
              ) : (
                <button type="button" autoFocus className="btn btn-primary" disabled={install.isPending} onClick={() => install.mutate()}>
                  {t("about.restartNow")}
                </button>
              )}
            </DialogFoot>
          </>
        )}
      </Dialog>
      {ownSettings !== null && <SettingsDialog open={ownSettings} onOpenChange={setOwnSettings} pane="about" />}
    </>
  );
}
