import type { EnginePick, EngineTry, EngineView } from "@tomradex/agent";
import type { MessageKey } from "./i18n";

/** What a translated message reads as: useI18n().t, for helpers outside a render. */
export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** The CodeBuddy edition pick: a machine-wide knob, named and worded here so every surface agrees. */
const REGION_LABELS: Record<string, MessageKey> = {
  auto: "agentPanel.regionAuto",
  china: "agentPanel.regionChina",
  international: "agentPanel.regionInternational"
};

/** A pick's heading: the localized names for the two original knobs and the edition; a plugin's own title otherwise. */
export function pickTitleOf(t: Translate, pick: EnginePick): string {
  if (pick.key === "model" || pick.key === "profile") return t("agentPanel.modelHead");
  if (pick.key === "effort") return t("agentPanel.effortHead");
  if (pick.key === "region") return t("agentPanel.regionHead");
  return pick.title;
}

/** A choice's label: the edition's choices carry stable values, so their words come from the interface, not the plugin. */
export function pickChoiceName(t: Translate, pick: EnginePick, choice: { value: string; label?: string; searchesWeb?: boolean }): string {
  const known = pick.key === "region" ? REGION_LABELS[choice.value] : undefined;
  return known ? t(known) : (choice.label ?? choice.value);
}

/**
 * Whether this machine has the engine at all. An in-app engine is here by
 * definition; one behind a CLI is here once the CLI is found — signed out,
 * broken, chosen by hand, or found somewhere it cannot run (WSL, a desktop
 * app) still counts, since the row explains what to do. Only an agent nobody
 * installed is kept out of the way.
 */
export const detectedHere = (engine: Pick<EngineView, "ok" | "cli" | "need">): boolean =>
  engine.ok || (engine.cli ? engine.cli.state !== "missing" || !!engine.cli.wsl || !!engine.cli.desktopApp || !!engine.cli.manual : engine.need !== "install");

/**
 * Whether an engine that says it is ready has shown it can run. Found and
 * signed in is not enough: a try with its settings now settles it. Until then
 * an agent a test message can reach is still being checked — one that could
 * not list its models cannot run a turn — while one on Tomrade's models, or
 * one that runs only in a terminal, goes by its models.
 */
export type EngineHealth = "works" | "checking" | "broken";

type HealthOf = Pick<EngineView, "ok" | "tried" | "picks" | "usesModels" | "terminalOnly">;

const modelPick = (engine: Pick<EngineView, "picks">) => engine.picks?.find((pick) => pick.key === "model");
const triable = (engine: HealthOf) => !engine.usesModels && !engine.terminalOnly;

export function engineHealth(engine: HealthOf): EngineHealth {
  if (!engine.ok) return "broken";
  if (engine.tried) return engine.tried.ok ? "works" : "broken";
  const model = modelPick(engine);
  if (model?.failed) return "broken";
  return model?.pending || triable(engine) ? "checking" : "works";
}

/** Found and signed in, never tried: only a test message tells whether it works. */
export const awaitsTry = (engine: HealthOf): boolean => engine.ok && !engine.tried && triable(engine) && !modelPick(engine)?.failed;

/** The last try with the engine's current settings, when it came back without a real reply. */
export const failedTry = (engine: Pick<EngineView, "tried">): EngineTry | undefined => (engine.tried && !engine.tried.ok ? engine.tried : undefined);

/** What keeps an engine that says it is ready from running, in its agent's words; none when nothing is known to. */
export function engineProblem(engine: HealthOf): { kind: "tried" | "models"; detail: string } | null {
  if (!engine.ok) return null;
  if (engine.tried) return engine.tried.ok ? null : { kind: "tried", detail: engine.tried.error ?? "" };
  const failed = modelPick(engine)?.failed;
  return failed ? { kind: "models", detail: failed } : null;
}
