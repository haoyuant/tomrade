import { Icon } from "~/components/icons";
import { Eyebrow, LiveDot, Num, SectionHead } from "~/components/ui/atoms";
import { useI18n } from "~/lib/i18n";
import { keyLabel } from "~/lib/keybindings";
import { useMcpUrl } from "~/lib/queries";
import { ScopeTag } from "./ScopeTag";

/** Tomrade's own MCP server: where coding agents reach this backlog, and what they may not do to it. */
export function AgentAccessSection() {
  const { t, tx } = useI18n();
  const mcp = useMcpUrl();
  return (
    <>
      <SectionHead title={t("settingsDialog.agentsLabel")} aside={<ScopeTag scope="machine" />}>
        {t("settingsDialog.agentsLede")}
      </SectionHead>
      <div className="grid-2">
        <div className="panel">
          <div className="row" style={{ gap: 7, marginBottom: "var(--space-3)" }}>
            <LiveDot />
            <Eyebrow>{t("settingsDialog.mcpListening")}</Eyebrow>
          </div>
          <p className="num" style={{ fontSize: 14, color: "var(--fg-2)" }}>
            {mcp.data ?? t("settingsDialog.notRunning")}
          </p>
          <p className="meta-txt dense" style={{ marginTop: "var(--space-3)" }}>
            {t("settingsDialog.mcpNote")}
          </p>
        </div>
        <div className="panel">
          <div className="row" style={{ gap: 7, marginBottom: "var(--space-3)" }}>
            <Icon name="i-lock" size={14} style={{ color: "var(--meta)" }} />
            <Eyebrow>{t("settingsDialog.humanProtected")}</Eyebrow>
          </div>
          <ul className="dash-list">
            <li>{t("settingsDialog.lockedFieldsBullet")}</li>
            <li>{t("settingsDialog.oplogBullet")}</li>
            <li>{tx("settingsDialog.undoBullet", { cmdz: <Num>{keyLabel("undo")}</Num> })}</li>
          </ul>
        </div>
      </div>
    </>
  );
}
