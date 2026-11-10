import { useEffect, useState } from "react";
import { Icon } from "~/components/icons";
import { Eyebrow, Spacer } from "~/components/ui/atoms";
import { useI18n } from "~/lib/i18n";
import { useConfigureHub, useHubInfo } from "~/lib/queries";
import { pickDirectory } from "~/lib/shell";
import { errorSpec, useToast } from "~/lib/toast";
import { isCommitKey } from "~/lib/keys";

/**
 * First run: the one question before anything else. Tomrade keeps every
 * project as a folder the user can see, and this is where they all go. The
 * default is prefilled so accepting it is one click; nothing else is asked.
 */
export function HubSetup() {
  const { t, tx } = useI18n();
  const hub = useHubInfo();
  const configure = useConfigureHub();
  const toast = useToast();
  const [dir, setDir] = useState("");
  const [picking, setPicking] = useState(false);

  // prefilled once the default arrives; a folder cleared by hand stays cleared
  useEffect(() => {
    if (!dir && hub.data?.defaultDir) setDir(hub.data.defaultDir);
  }, [hub.data?.defaultDir]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = async () => {
    setPicking(true);
    const chosen = await pickDirectory(t("hubSetup.pickTitle"), t("hubSetup.pickButton"));
    setPicking(false);
    if (chosen) setDir(chosen);
  };

  const submit = () => {
    const trimmed = dir.trim();
    if (!trimmed || configure.isPending) return;
    configure.mutate(trimmed, { onError: (error) => toast(errorSpec(error)) });
  };

  return (
    <div className="app hub-setup">
      <header className="titlebar">
        <span className="crumb-title">{t("hubSetup.brand")}</span>
        <Spacer />
      </header>
      <main className="sheet">
        <div className="wrap" style={{ maxWidth: 640 }}>
          <Eyebrow>{t("hubSetup.eyebrow")}</Eyebrow>
          <h1 className="sec-title" style={{ marginTop: "var(--space-3)" }}>
            {t("hubSetup.title")}
          </h1>
          <p className="sec-lede" style={{ marginTop: "var(--space-2)" }}>
            {t("hubSetup.lede")}
          </p>
          <div className="panel stack-3" style={{ marginTop: "var(--space-5)" }}>
            <div className="field">
              <label htmlFor="hubDir">{t("hubSetup.folderLabel")}</label>
              <div className="row" style={{ gap: "var(--space-2)" }}>
                <input
                  id="hubDir"
                  className="input num"
                  style={{ flex: 1 }}
                  autoComplete="off"
                  spellCheck={false}
                  value={dir}
                  onChange={(e) => setDir(e.target.value)}
                  onKeyDown={(e) => {
                    if (isCommitKey(e)) submit();
                  }}
                />
                <button type="button" className="btn btn-secondary" disabled={picking} onClick={() => void choose()}>
                  <Icon name="i-search" size={13} />
                  {picking ? t("hubSetup.choosing") : t("hubSetup.choose")}
                </button>
              </div>
              <span className="meta-txt">{t("hubSetup.folderNote")}</span>
            </div>
            <ul className="dash-list">
              <li>{tx("hubSetup.bulletProjects", { path: <span className="num">projects/</span> })}</li>
              <li>{t("hubSetup.bulletCache")}</li>
              <li>{t("hubSetup.bulletMove")}</li>
            </ul>
          </div>
          <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-4)" }}>
            <button type="button" className="btn btn-primary hub-use" disabled={!dir.trim() || configure.isPending} onClick={submit}>
              {configure.isPending ? t("hubSetup.setting") : t("hubSetup.useFolder")}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
