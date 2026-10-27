import { useCallback, useMemo, useState } from "react";
import { FoldChevron } from "~/components/ui/atoms";
import { logQuietly } from "~/lib/api";
import { codingFromLines, foldTools, workConclusion, workLabel, type ConvoLine, type ConvoSay } from "~/lib/convoFold";

export type { ConvoLine, ConvoSay } from "~/lib/convoFold";

/**
 * A conversation's lines, long runs of tool calls folded under what they came to; once it writes code, each stretch
 * of it folds whole under its conclusion. `coding`: all of it is writing code. `waiting`: the session waits on the person.
 */
export function ConvoLines({ lines, open, toggle, say, coding, waiting }: { lines: ConvoLine[]; open: ReadonlySet<number>; toggle: (key: number) => void; say: ConvoSay; coding?: boolean; waiting?: boolean }) {
  const entries = useMemo(() => foldTools(lines, coding ? 0 : codingFromLines(lines), waiting), [lines, coding, waiting]);
  return (
    <>
      {entries.map((entry) =>
        "fold" in entry ? (
          <details key={`fold-${entry.fold[0]!.key}`} className={entry.coding ? "trace-fold cs-convo-fold work-fold" : "trace-fold cs-convo-fold"} data-testid={entry.coding ? "work-fold" : undefined}>
            <summary>{entry.coding ? workConclusion(entry.work, say, entry.waiting) : workLabel(entry.work, say)}</summary>
            {entry.fold.map((l) => <ConvoLineRow key={l.key} line={l} open={open.has(l.key)} onToggle={() => toggle(l.key)} say={say} />)}
          </details>
        ) : entry.who === "mark" ? (
          <p key={entry.key} className="cs-convo-mark" data-testid="convo-mark">{entry.text}</p>
        ) : (
          <ConvoLineRow key={entry.key} line={entry} open={open.has(entry.key)} onToggle={() => toggle(entry.key)} say={say} />
        )
      )}
    </>
  );
}

/** One line of a conversation read back; a tool call folds open to its whole input and output. */
export function ConvoLineRow({ line, open, onToggle, say }: { line: ConvoLine; open: boolean; onToggle: () => void; say: ConvoSay }) {
  const [copied, setCopied] = useState(false);
  const detail = line.detail;
  const copy = () => {
    const text = detail ? [line.text, detail.input, detail.output].filter(Boolean).join("\n\n") : line.text;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, logQuietly("clipboard"));
  };
  return (
    <div className="cs-convo-item" data-who={line.who}>
      {detail ? (
        <div className="cs-convo-tool">
          <FoldChevron open={open} onToggle={onToggle} />
          <button type="button" className="cs-convo-line" data-who="tool" aria-expanded={open} onClick={onToggle}>
            {line.text}
          </button>
        </div>
      ) : (
        <div className="cs-convo-line" data-who={line.who}>
          {line.text}
        </div>
      )}
      <button type="button" className="link-btn cs-convo-copy" onClick={copy}>
        {say(copied ? "convoCopied" : "convoCopy")}
      </button>
      {detail && open && (
        <div className="cs-convo-detail" data-testid="cs-convo-detail">
          <span className="cs-row-meta">{say("convoInput")}</span>
          <pre>{detail.input}</pre>
          <span className="cs-row-meta">{say("convoOutput")}</span>
          {detail.output !== undefined ? <pre>{detail.output}</pre> : <span className="cs-row-meta">{say("convoNoOutput")}</span>}
        </div>
      )}
    </div>
  );
}

/** Above the first line read: the way to what came before, or the word that the conversation starts here. */
export function ConvoTop({ cut, reading, onEarlier, say }: { cut: boolean; reading: boolean; onEarlier: () => void; say: ConvoSay }) {
  if (!cut) return <p className="cs-convo-top">{say("convoStart")}</p>;
  return (
    <button type="button" className="link-btn cs-convo-top" data-testid="cs-convo-earlier" disabled={reading} onClick={onEarlier}>
      {say(reading ? "convoReading" : "convoEarlier")}
    </button>
  );
}

/** The folded tool calls, by line key: toggling one leaves the rest as they were. The handlers keep their identity. */
export function useOpenLines(): [ReadonlySet<number>, (key: number) => void, () => void] {
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const toggle = useCallback(
    (key: number) =>
      setOpen((now) => {
        const next = new Set(now);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    []
  );
  const closeAll = useCallback(() => setOpen(new Set()), []);
  return [open, toggle, closeAll];
}
