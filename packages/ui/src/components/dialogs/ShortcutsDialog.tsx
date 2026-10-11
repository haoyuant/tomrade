import { Kbd } from "~/components/ui/atoms";
import { Dialog, DialogBody, DialogHead } from "~/components/ui/dialog";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { shortcut } from "~/lib/keys";

const GROUPS: { title: MessageKey; rows: [keys: string[], what: MessageKey][] }[] = [
  {
    title: "shortcuts.anywhere",
    rows: [
      [["⌘K"], "shortcuts.palette"],
      [["⌘N", "N"], "shortcuts.newTicket"],
      [["⌘P"], "shortcuts.switchProject"],
      [["⌘B"], "shortcuts.sidebar"],
      [["⌘J"], "shortcuts.assistant"],
      [["⌘,"], "shortcuts.settings"],
      [["⌘Z"], "shortcuts.undo"],
      [["⇧⌘Z"], "shortcuts.redo"],
      [["⇧⌘F"], "shortcuts.searchNotes"],
      [["Esc"], "shortcuts.closePane"],
      [["?"], "shortcuts.thisSheet"]
    ]
  },
  {
    title: "shortcuts.board",
    rows: [
      [["↑", "↓", "←", "→"], "shortcuts.moveFocus"],
      [["↵"], "shortcuts.openCard"],
      [["⌥←", "⌥→"], "shortcuts.moveCard"],
      [["←", "→"], "shortcuts.folders"]
    ]
  },
  {
    title: "shortcuts.writing",
    rows: [
      [["⌘↵"], "shortcuts.saveBody"],
      [["Esc"], "shortcuts.discardBody"],
      [["⌘E"], "shortcuts.readWrite"]
    ]
  }
];

/** Every shortcut in one place, written for this platform; "?" opens it. */
export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={t("shortcuts.title")} className="sheet-md">
      <DialogHead title={t("shortcuts.title")} />
      <DialogBody>
        <div className="shortcut-groups">
          {GROUPS.map((group) => (
            <section key={group.title} className="shortcut-group">
              <h3 className="eyebrow">{t(group.title)}</h3>
              <dl>
                {group.rows.map(([keys, what]) => (
                  <div className="shortcut-row" key={what}>
                    <dt>
                      {keys.map((key) => (
                        <Kbd key={key}>{key === "↵" ? "Enter" : shortcut(key)}</Kbd>
                      ))}
                    </dt>
                    <dd>{t(what)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogBody>
    </Dialog>
  );
}
