import { Fragment, type ReactNode } from "react";
import type { EngineView } from "@tomradex/agent";
import { useI18n } from "~/lib/i18n";
import { setupRows } from "~/lib/setup";
import { ownFailed } from "~/lib/setupState";
import { BuiltinFallback } from "./BuiltinFallback";
import { DetectedModels } from "./DetectedModels";
import { GitNotice } from "./GitNotice";
import { LocalAgentSetup } from "./LocalAgentSetup";
import { ModelTestNotice } from "./ModelTestNotice";
import { QuickModelSetup } from "./QuickModelSetup";

export interface SetupPart {
  id: "key" | "agents" | "builtin";
  title: string;
  lede: string;
  body: ReactNode;
}

/**
 * Every way to connect an AI, in the order offered: what this computer already
 * has, a key, then the local agents once any is worth a row. Once every agent
 * found here failed its test, the key becomes the next route: the built-in
 * agent, after the agents. Where it shows decides only how each part is framed.
 */
export function SetupOptions({ engines, onOpenSettings, onTroubleshoot, frame }: { engines?: EngineView[]; onOpenSettings: (engineId?: string) => void; onTroubleshoot?: (engineId: string, error?: string) => void; frame: (part: SetupPart) => ReactNode }) {
  const { t } = useI18n();
  const failed = engines ? ownFailed(engines) : [];
  const parts: SetupPart[] = [];
  if (!failed.length) parts.push({ id: "key", title: t("setup.keyTitle"), lede: t("setup.keyLede"), body: <QuickModelSetup /> });
  if (engines && setupRows(engines).length > 0)
    parts.push({ id: "agents", title: t("setup.cliTitle"), lede: t("setup.cliLede"), body: <LocalAgentSetup engines={engines} onOpenSettings={onOpenSettings} onTroubleshoot={onTroubleshoot} /> });
  if (engines && failed.length) parts.push({ id: "builtin", title: t("setup.builtinTitle"), lede: t("setup.builtinLede"), body: <BuiltinFallback failed={failed} engines={engines} /> });
  return (
    <>
      <DetectedModels />
      <ModelTestNotice onOpenSettings={() => onOpenSettings()} />
      {parts.map((part) => (
        <Fragment key={part.id}>{frame(part)}</Fragment>
      ))}
      <GitNotice />
    </>
  );
}
