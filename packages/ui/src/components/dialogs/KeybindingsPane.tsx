import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppSettings } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { Kbd, SectionHead, Tag } from "~/components/ui/atoms";
import { invoke, subscribe } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import {
  COMMANDS,
  FIXED,
  GROUPS,
  chordFromEvent,
  conflictsOf,
  exportKeybindings,
  formatChord,
  globalChordProblem,
  isBare,
  parseKeybindingsFile,
  resolveKeymap,
  sameChord,
  type CommandId,
  type Keymap,
  type Overrides
} from "~/lib/keybindings";
import { errorSpec, useToast } from "~/lib/toast";

/** Alone, these keys type, move the caret or leave a field; with a modifier they are fair game. */
const RESERVED_BARE = new Set(["Escape", "Tab", "Enter", "Space", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

/** What a recording is for: replacing one of a command's chords, or adding one. */
interface Recording {
  id: CommandId;
  /** Index of the chord being replaced; null to add one. */
  at: number | null;
}

interface Pending {
  id: CommandId;
  at: number | null;
  chord: string;
  others: CommandId[];
}

declare module "@tomradex/ipc" {
  interface Channels {
    /** The key given to the whole computer, and whether the system let Tomrade have it. */
    "keybindings.globalStatus": () => GlobalKeyStatus[];
  }
  interface Broadcasts {
    "keybindings.globalStatusChanged": (status: GlobalKeyStatus[]) => void;
  }
}
interface GlobalKeyStatus {
  command: string;
  chord: string;
  registered: boolean;
}

const isGlobal = (id: CommandId) => COMMANDS.find((c) => c.id === id)?.group === "global";

/** What the desktop shell made of the keys for the whole computer; empty in a browser tab. */
function useGlobalKeyStatus(): GlobalKeyStatus[] {
  const qc = useQueryClient();
  useEffect(() => subscribe("keybindings.globalStatusChanged", (status) => qc.setQueryData(["keybindings", "globalStatus"], status)), [qc]);
  return useQuery({ queryKey: ["keybindings", "globalStatus"], queryFn: () => invoke("keybindings.globalStatus").catch(() => []), staleTime: Infinity }).data ?? [];
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

/** Only what differs from the defaults is stored, so later defaults still reach a command left alone. */
function overridesOf(map: Keymap): Overrides {
  const out: Overrides = {};
  for (const c of COMMANDS) if (!sameList(map[c.id], c.defaults)) out[c.id] = map[c.id];
  return out;
}

/** A command's defaults back, taken from whichever command they had gone to — never two commands on one key. */
function resetOne(map: Keymap, id: CommandId): Keymap {
  const defaults = COMMANDS.find((c) => c.id === id)!.defaults;
  const next = { ...map, [id]: defaults };
  for (const c of COMMANDS) if (c.id !== id) next[c.id] = next[c.id].filter((k) => !defaults.some((d) => sameChord(d, k)));
  return next;
}

export function KeybindingsPane({ settings, onSave, scopeTag }: { settings: AppSettings; onSave: (next: AppSettings) => Promise<unknown>; scopeTag?: ReactNode }) {
  const { t } = useI18n();
  const toast = useToast();
  const stored = (settings.keybindings as { overrides?: Record<string, string[]> } | undefined)?.overrides ?? {};
  // Keyed by content: settings arrive as a new object on every read.
  const storedKey = JSON.stringify(stored);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const map = useMemo(() => resolveKeymap(stored), [storedKey]);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [problem, setProblem] = useState<{ id: CommandId; text: string } | null>(null);
  const [query, setQuery] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const globalStatus = useGlobalKeyStatus();
  const changed = Object.keys(overridesOf(map)).length > 0;

  const commit = (next: Keymap) =>
    onSave({ ...settings, keybindings: { overrides: overridesOf(next) } }).catch((error: unknown) => toast(errorSpec(error)));

  const place = (id: CommandId, at: number | null, chord: string, steal: CommandId[]) => {
    const next = { ...map };
    for (const other of steal) next[other] = next[other].filter((k) => !sameChord(k, chord));
    const own = next[id].filter((k, i) => i === at || !sameChord(k, chord));
    const index = at === null ? -1 : own.indexOf(map[id][at]!);
    next[id] = index >= 0 ? own.map((k, i) => (i === index ? chord : k)) : [...own, chord].slice(0, 4);
    void commit(next);
  };

  // While recording, every key is the one being recorded: the window hears it first and nobody else does.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      const chord = chordFromEvent(e);
      if (!chord) return;
      if (chord === "Escape") {
        setRecording(null);
        return;
      }
      setRecording(null);
      if (isBare(chord) && RESERVED_BARE.has(chord.replace(/^Shift\+/, ""))) {
        setProblem({ id: recording.id, text: t("shortcuts.reserved", { keys: formatChord(chord) }) });
        return;
      }
      const globalProblem = isGlobal(recording.id) ? globalChordProblem(chord) : null;
      if (globalProblem) {
        setProblem({ id: recording.id, text: t(globalProblem === "bare" ? "shortcuts.globalBare" : globalProblem === "ctrl" ? "shortcuts.globalCtrl" : "shortcuts.globalCommon", { keys: formatChord(chord) }) });
        return;
      }
      setProblem(null);
      const others = conflictsOf(map, recording.id, chord);
      if (others.length) setPending({ ...recording, chord, others });
      else place(recording.id, recording.at, chord, []);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const labelOf = (id: CommandId) => t(COMMANDS.find((c) => c.id === id)!.label);

  const exportFile = async () => {
    try {
      const saved = await invoke("shell.saveTextFile", {
        title: t("shortcuts.exportTitle"),
        defaultName: "tomrade-shortcuts.json",
        text: JSON.stringify(exportKeybindings(overridesOf(map)), null, 2) + "\n"
      });
      if (saved) toast({ body: t("shortcuts.exported") });
    } catch (error) {
      toast(errorSpec(error));
    }
  };

  const importFile = async () => {
    try {
      const file = await invoke("shell.openTextFile", { title: t("shortcuts.importTitle"), extensions: ["json"] });
      if (!file) return;
      let parsed: ReturnType<typeof parseKeybindingsFile>;
      try {
        parsed = parseKeybindingsFile(file.text);
      } catch {
        toast({ body: t("shortcuts.importNotOurs") });
        return;
      }
      // An imported file is a whole set of keys: what it leaves out goes back to the default.
      const next = resolveKeymap(parsed.overrides);
      await onSave({ ...settings, keybindings: { overrides: overridesOf(next) } });
      const n = Object.keys(overridesOf(next)).length;
      toast({ body: parsed.skipped ? t("shortcuts.importedSkipped", { n, skipped: parsed.skipped }) : t("shortcuts.imported", { n }) });
    } catch (error) {
      toast(errorSpec(error));
    }
  };

  const needle = query.trim().toLowerCase();
  const shows = (label: string, keys: string[]) => !needle || label.toLowerCase().includes(needle) || keys.some((k) => formatChord(k).toLowerCase().includes(needle) || k.toLowerCase().includes(needle));

  return (
    <div className="keys-pane" data-testid="keybindings-pane">
      <SectionHead title={t("shortcuts.title")} aside={scopeTag}>
        {t("shortcuts.paneIntro")}
      </SectionHead>
      <div className="keys-toolbar">
        <input className="input keys-search" type="search" value={query} placeholder={t("shortcuts.searchPlaceholder")} aria-label={t("shortcuts.searchPlaceholder")} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className="btn btn-secondary" data-testid="keys-export" onClick={() => void exportFile()}>
          <Icon name="i-download" size={13} /> {t("shortcuts.exportKeys")}
        </button>
        <button type="button" className="btn btn-secondary" data-testid="keys-import" onClick={() => void importFile()}>
          <Icon name="i-upload" size={13} /> {t("shortcuts.importKeys")}
        </button>
        {confirmReset ? (
          <span className="keys-confirm" role="alert">
            <span>{t("shortcuts.resetAllConfirm")}</span>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="keys-reset-all-confirm"
              onClick={() => {
                setConfirmReset(false);
                void commit(resolveKeymap(undefined));
              }}
            >
              {t("shortcuts.resetAll")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmReset(false)}>
              {t("common.cancel")}
            </button>
          </span>
        ) : (
          <button type="button" className="btn btn-ghost" data-testid="keys-reset-all" disabled={!changed} onClick={() => setConfirmReset(true)}>
            {t("shortcuts.resetAll")}
          </button>
        )}
      </div>

      {GROUPS.map((group) => {
        const commands = COMMANDS.filter((c) => c.group === group.id && shows(t(c.label), map[c.id]));
        const fixed = FIXED.filter((f) => f.group === group.id && shows(t(f.label), f.keys));
        if (!commands.length && !fixed.length) return null;
        return (
          <section key={group.id} className="keys-group">
            <h4 className="eyebrow">{t(group.title)}</h4>
            <div className="panel keys-list">
              {commands.map((c) => {
                const keys = map[c.id];
                const isChanged = !sameList(keys, c.defaults);
                const recordingHere = recording?.id === c.id;
                const pendingHere = pending?.id === c.id ? pending : null;
                // one key for the whole computer is plenty, and each one the system refused is said
                const room = c.group === "global" ? 1 : 4;
                const refused = c.group === "global" ? globalStatus.find((g) => g.command === c.id && !g.registered) : undefined;
                return (
                  <div key={c.id} className="keys-row" data-command={c.id} data-changed={isChanged || undefined}>
                    <div className="keys-label">
                      <span>{t(c.label)}</span>
                      {isChanged && <Tag tone="faint">{t("shortcuts.changed")}</Tag>}
                    </div>
                    <div className="keys-chords">
                      {keys.map((chord, i) =>
                        recordingHere && recording.at === i ? (
                          <span key={chord} className="keys-recording" aria-live="polite">
                            {t("shortcuts.record")} <span className="meta-txt">{t("shortcuts.recordHint")}</span>
                          </span>
                        ) : (
                          <span key={chord} className="keys-chord">
                            <button type="button" className="keys-chord-btn" title={t("shortcuts.record")} onClick={() => { setPending(null); setProblem(null); setRecording({ id: c.id, at: i }); }}>
                              <Kbd>{formatChord(chord)}</Kbd>
                            </button>
                            <button
                              type="button"
                              className="keys-chord-x"
                              aria-label={t("shortcuts.removeKeys", { keys: formatChord(chord) })}
                              onClick={() => void commit({ ...map, [c.id]: keys.filter((_, j) => j !== i) })}
                            >
                              <Icon name="i-close" size={10} />
                            </button>
                          </span>
                        )
                      )}
                      {recordingHere && recording.at === null ? (
                        <span className="keys-recording" aria-live="polite">
                          {t("shortcuts.record")} <span className="meta-txt">{t("shortcuts.recordHint")}</span>
                        </span>
                      ) : (
                        keys.length < room && (
                          <button type="button" className="btn btn-ghost keys-add" data-testid="keys-add" onClick={() => { setPending(null); setProblem(null); setRecording({ id: c.id, at: null }); }}>
                            {keys.length ? <Icon name="i-plus" size={12} /> : t("shortcuts.addKeys")}
                          </button>
                        )
                      )}
                      {!keys.length && !recordingHere && <span className="meta-txt">{t("shortcuts.noKeys")}</span>}
                    </div>
                    <div className="keys-actions">
                      {isChanged && (
                        <button type="button" className="btn btn-ghost" data-testid="keys-reset" onClick={() => void commit(resetOne(map, c.id))}>
                          {t("shortcuts.reset")}
                        </button>
                      )}
                    </div>
                    {pendingHere && (
                      <div className="keys-note" role="alert">
                        <Icon name="i-warn" size={13} />
                        <span>{t("shortcuts.conflict", { keys: formatChord(pendingHere.chord), other: pendingHere.others.map(labelOf).join(", ") })}</span>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          data-testid="keys-use-here"
                          onClick={() => {
                            setPending(null);
                            place(pendingHere.id, pendingHere.at, pendingHere.chord, pendingHere.others);
                          }}
                        >
                          {t("shortcuts.useHere")}
                        </button>
                        <button type="button" className="btn btn-ghost" onClick={() => setPending(null)}>
                          {t("common.cancel")}
                        </button>
                      </div>
                    )}
                    {refused && keys.some((k) => sameChord(k, refused.chord)) && (
                      <div className="keys-note" role="alert" data-testid="keys-global-taken">
                        <Icon name="i-warn" size={13} />
                        <span>{t("shortcuts.globalTaken", { keys: formatChord(refused.chord) })}</span>
                      </div>
                    )}
                    {problem?.id === c.id && (
                      <div className="keys-note" role="alert">
                        <Icon name="i-warn" size={13} />
                        <span>{problem.text}</span>
                      </div>
                    )}
                  </div>
                );
              })}
              {fixed.map((f) => (
                <div key={f.label} className="keys-row is-fixed">
                  <div className="keys-label">
                    <span>{t(f.label)}</span>
                  </div>
                  <div className="keys-chords">
                    {f.keys.map((k) => (
                      <Kbd key={k}>{formatChord(k)}</Kbd>
                    ))}
                  </div>
                  <div className="keys-actions">
                    <span className="meta-txt">{t("shortcuts.fixed")}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
