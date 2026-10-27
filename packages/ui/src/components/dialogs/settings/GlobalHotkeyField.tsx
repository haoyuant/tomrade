import { useEffect, useState, type ReactNode } from "react";
import { Kbd } from "~/components/ui/atoms";
import { useI18n } from "~/lib/i18n";
import { chordFromEvent, COMMANDS, conflictsOf, formatChord, globalChordProblem, resolveKeymap, sameChord, type CommandId } from "~/lib/keybindings";
import { isMac } from "~/lib/keys";
import { useCommands, useSaveSettings, useSettings } from "~/lib/queries";
import { readableError } from "~/lib/toast";
import { overridesOf, useGlobalKeyStatus } from "../KeybindingsPane";

const COMMAND: CommandId = "terminalWindowGlobal";
const ALT_SPACE = "Alt+Space";

/**
 * The key that brings up the Terminal window from any app: none, ⌥Space, or one pressed here. The same setting as
 * Settings › Keyboard shortcuts' "From any app", offered in Settings › Sessions and on the first run. Nothing where
 * this app has no Terminal window.
 */
export function GlobalHotkeyField() {
  const { t } = useI18n();
  const settings = useSettings();
  const save = useSaveSettings();
  const terminal = !!useCommands().data?.some((c) => c.id === "code-sessions.open");
  const status = useGlobalKeyStatus();
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [clash, setClash] = useState<{ chord: string; others: CommandId[] } | null>(null);
  const stored = (settings.data?.keybindings as { overrides?: Record<string, string[]> } | undefined)?.overrides ?? {};
  const map = resolveKeymap(stored);
  const chord = map[COMMAND][0] ?? null;

  const write = (next: string | null, steal: CommandId[] = []) => {
    if (!settings.data) return;
    const keys = { ...map, [COMMAND]: next ? [next] : [] };
    for (const other of steal) keys[other] = keys[other].filter((k) => !sameChord(k, next!));
    setProblem(null);
    setClash(null);
    save.mutateAsync({ ...settings.data, keybindings: { overrides: overridesOf(keys) } }).catch((err: unknown) => setProblem(t("common.notSaved", { reason: readableError(err) })));
  };
  const take = (next: string) => {
    const wrong = globalChordProblem(next);
    if (wrong) return setProblem(t(wrong === "bare" ? "shortcuts.globalBare" : wrong === "ctrl" ? "shortcuts.globalCtrl" : "shortcuts.globalCommon", { keys: formatChord(next) }));
    const others = conflictsOf(map, COMMAND, next);
    if (others.length) return setClash({ chord: next, others });
    write(next);
  };

  // While recording, the next key is the one: the window hears it first and nobody else does.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      const pressed = chordFromEvent(e);
      if (!pressed) return;
      setRecording(false);
      if (pressed !== "Escape") take(pressed);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (!terminal || !settings.data) return null;
  const choice = recording ? "record" : !chord ? "none" : sameChord(chord, ALT_SPACE) ? "altSpace" : "record";
  const refused = chord ? status.find((s) => s.command === COMMAND && !s.registered && sameChord(s.chord, chord)) : undefined;
  const option = (id: "none" | "altSpace" | "record", label: ReactNode, pick: () => void) => (
    <button key={id} type="button" role="radio" aria-checked={choice === id} className={choice === id ? "chip-opt sel" : "chip-opt"} data-hotkey={id} onClick={pick}>
      {label}
    </button>
  );
  const note = recording ? "shortcuts.hotkeyRecordNote" : !chord ? "shortcuts.hotkeyNoneNote" : isMac ? "shortcuts.hotkeySetNoteMac" : "shortcuts.hotkeySetNote";
  const other = (id: CommandId) => t(COMMANDS.find((c) => c.id === id)!.label);
  return (
    <div className="field" data-testid="global-hotkey">
      <span>{t("shortcuts.hotkeyTitle")}</span>
      <div className="quick-providers" role="radiogroup" aria-label={t("shortcuts.hotkeyTitle")}>
        {option("none", t("shortcuts.hotkeyNone"), () => { setRecording(false); if (chord) write(null); })}
        {option("altSpace", formatChord(ALT_SPACE), () => { setRecording(false); if (!chord || !sameChord(chord, ALT_SPACE)) take(ALT_SPACE); })}
        {option("record", recording ? `${t("shortcuts.record")} · ${t("shortcuts.recordHint")}` : chord && choice === "record" ? <Kbd>{formatChord(chord)}</Kbd> : t("shortcuts.hotkeyRecord"), () => { setProblem(null); setClash(null); setRecording(true); })}
      </div>
      {clash && (
        <span className="field-error" role="alert">
          {t("shortcuts.conflict", { keys: formatChord(clash.chord), other: clash.others.map(other).join(", ") })}{" "}
          <button type="button" className="btn btn-ghost" data-testid="global-hotkey-use-here" onClick={() => write(clash.chord, clash.others)}>
            {t("shortcuts.useHere")}
          </button>
        </span>
      )}
      {problem && <span className="field-error" role="alert">{problem}</span>}
      {refused && <span className="field-error" role="alert" data-testid="global-hotkey-taken">{t("shortcuts.globalTaken", { keys: formatChord(refused.chord) })}</span>}
      <span className="meta-txt">{t(note)}</span>
    </div>
  );
}
