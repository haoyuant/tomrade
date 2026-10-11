import { useState } from "react";
import type { Mention } from "@tomradex/notes";
import { linkTarget, noteName, parseNote } from "@tomradex/notes/syntax";
import { Icon } from "~/components/icons";
import { Eyebrow } from "~/components/ui/atoms";
import { useWorkspace } from "~/components/workspace/context";
import { invoke } from "~/lib/api";
import { nameOf } from "~/lib/files";
import { useI18n } from "~/lib/i18n";
import { useNoteLinks } from "~/lib/notes";
import { errorSpec, useToast } from "~/lib/toast";

/** The first unlinked mention of `name` on a line, as a link to `target`; the words as written stay as the alias when they differ. */
export function linkMention(body: string, line: number, name: string, target: string): string | null {
  const lines = body.split("\n");
  const text = lines[line - 1];
  if (text === undefined) return null;
  const spans = parseNote(text).links;
  const lower = text.toLowerCase();
  const needle = name.toLowerCase();
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
    if (spans.some((l) => at >= l.from && at < l.to)) continue;
    const written = text.slice(at, at + name.length);
    lines[line - 1] = `${text.slice(0, at)}[[${target}${written === target ? "" : `|${written}`}]]${text.slice(at + name.length)}`;
    return lines.join("\n");
  }
  return null;
}

function MentionRow({ mention, onOpen, action }: { mention: Mention; onOpen: () => void; action?: React.ReactNode }) {
  return (
    <div className="mention-row" data-source={mention.path}>
      <button type="button" className="mention-open" onClick={onOpen}>
        <span className="mention-name">{mention.title ?? noteName(mention.path)}</span>
        <span className="mention-path meta-txt num">
          {mention.path}:{mention.line}
        </span>
        <span className="mention-text">{mention.text}</span>
      </button>
      {action}
    </div>
  );
}

/**
 * Under a note: the notes that link to it, each with the line it is linked
 * from, and — folded until asked — the ones that only say its name, each a
 * click from becoming a link.
 */
export function Backlinks({ projectId, path, paths }: { projectId: string; path: string; paths: string[] }) {
  const { t } = useI18n();
  const toast = useToast();
  const { openFile } = useWorkspace();
  const links = useNoteLinks(projectId, path, true);
  const [showUnlinked, setShowUnlinked] = useState(false);
  if (links.isError || !links.data) return null;
  const { backlinks, unlinked } = links.data;
  const name = noteName(path);
  const link = async (mention: Mention) => {
    try {
      const source = await invoke("files.read", projectId, mention.path);
      // A note read only in part must not be saved as that part.
      const next = source && !source.truncated && linkMention(source.body, mention.line, name, linkTarget(path, mention.path, paths));
      if (!source || !next) return toast({ body: t("notes.mentionMoved") });
      const saved = await invoke("files.save", projectId, mention.path, next, { expect: source.hash ?? null, message: `Linked ${name}` });
      toast({ body: saved.ok ? t("notes.linkedToast", { name, source: nameOf(mention.path) }) : t("notes.mentionMoved") });
    } catch (error) {
      toast(errorSpec(error));
    }
  };
  return (
    <section className="note-backlinks" aria-label={t("notes.linked")} data-testid="backlinks">
      <div className="note-backlinks-head">
        <Icon name="i-link" size={13} />
        <Eyebrow>{t("notes.linked")}</Eyebrow>
        <span className="meta-txt num">{backlinks.length}</span>
      </div>
      {backlinks.length ? (
        <div className="mention-list" data-kind="linked">
          {backlinks.map((m) => (
            <MentionRow key={`${m.path}:${m.line}`} mention={m} onOpen={() => openFile(m.path)} />
          ))}
        </div>
      ) : (
        <p className="meta-txt dense">{t("notes.noBacklinks")}</p>
      )}
      {unlinked.length > 0 && (
        <>
          <button type="button" className="note-backlinks-head is-toggle" aria-expanded={showUnlinked} onClick={() => setShowUnlinked((v) => !v)}>
            <Icon name={showUnlinked ? "i-chevdown" : "i-chev"} size={12} />
            <Eyebrow>{t("notes.unlinked")}</Eyebrow>
            <span className="meta-txt num">{unlinked.length}</span>
          </button>
          {showUnlinked && (
            <div className="mention-list" data-kind="unlinked">
              {unlinked.map((m) => (
                <MentionRow
                  key={`${m.path}:${m.line}`}
                  mention={m}
                  onOpen={() => openFile(m.path)}
                  action={
                    <button type="button" className="btn btn-ghost mention-link" onClick={() => void link(m)}>
                      {t("notes.linkIt")}
                    </button>
                  }
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
