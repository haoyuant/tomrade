import { Kbd } from "~/components/ui/atoms";
import { Dialog, DialogBody, DialogHead } from "~/components/ui/dialog";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { COMMANDS, FIXED, GROUPS, formatChord, useKeymap } from "~/lib/keybindings";
import { windowChord, type WindowKey } from "~/code-sessions/keys";

// The Terminal window's own keys, fixed there as in iTerm2; listed here so "?" shows them too.
const TERMINAL_ROWS: { label: MessageKey; keys: (WindowKey | "PageUp" | "PageDown")[] }[] = [
  { label: "shortcuts.termSplitRight", keys: ["splitRight"] },
  { label: "shortcuts.termSplitDown", keys: ["splitDown"] },
  { label: "shortcuts.termClose", keys: ["close"] },
  { label: "shortcuts.termMove", keys: ["left", "right", "up", "down"] },
  { label: "shortcuts.termPrev", keys: ["previous"] },
  { label: "shortcuts.termNext", keys: ["next"] },
  { label: "shortcuts.termFold", keys: ["fold"] },
  { label: "shortcuts.termPalette", keys: ["palette"] },
  { label: "shortcuts.termPage", keys: ["PageUp", "PageDown"] }
];

/** Every shortcut in one place, as the person has them, written for this platform; "?" opens it. */
export function ShortcutsDialog({ open, onOpenChange, onCustomize }: { open: boolean; onOpenChange: (open: boolean) => void; onCustomize?: () => void }) {
  const { t } = useI18n();
  const map = useKeymap();
  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={t("shortcuts.title")} className="sheet-md">
      <DialogHead title={t("shortcuts.title")}>
        {onCustomize && (
          <button type="button" className="btn btn-ghost" data-testid="shortcuts-customize" onClick={onCustomize}>
            {t("shortcuts.customize")}
          </button>
        )}
      </DialogHead>
      <DialogBody>
        <div className="shortcut-groups">
          {GROUPS.map((group) => {
            const rows = [
              ...COMMANDS.filter((c) => c.group === group.id && map[c.id].length).map((c) => ({ id: c.id as string, label: c.label, keys: map[c.id] })),
              ...FIXED.filter((f) => f.group === group.id).map((f) => ({ id: f.label as string, label: f.label, keys: f.keys }))
            ];
            if (!rows.length) return null;
            return (
              <section key={group.id} className="shortcut-group">
                <h3 className="eyebrow">{t(group.title)}</h3>
                <dl>
                  {rows.map((row) => (
                    <div className="shortcut-row" key={row.id} data-command={row.id}>
                      <dt>
                        {row.keys.map((key) => (
                          <Kbd key={key}>{formatChord(key)}</Kbd>
                        ))}
                      </dt>
                      <dd>{t(row.label)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
          <section className="shortcut-group" data-testid="shortcuts-terminal">
            <h3 className="eyebrow">{t("shortcuts.terminal")}</h3>
            <dl>
              {TERMINAL_ROWS.map((row) => (
                <div className="shortcut-row" key={row.label}>
                  <dt>
                    {row.keys.map((key) => (
                      <Kbd key={key}>{formatChord(key === "PageUp" || key === "PageDown" ? key : windowChord(key))}</Kbd>
                    ))}
                  </dt>
                  <dd>{t(row.label)}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </DialogBody>
    </Dialog>
  );
}
