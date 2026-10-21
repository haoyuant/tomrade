import { useLayoutEffect, useRef, type ChangeEvent, type KeyboardEvent, type RefObject } from "react";
import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";

/** The message box with its attach and send (or stop) buttons; what the keys do is the panel's. */
export function Composer({ composer, draft, placeholder, archived, busy, canSend, problem, acceptedMedia, onChange, onAttach, onKeyDown, onSend, onStop }: {
  composer: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  placeholder: string;
  archived: boolean;
  busy: boolean;
  canSend: boolean;
  /** Why the conversation cannot run here, shown on the send button. */
  problem: string | null;
  acceptedMedia: string[];
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onAttach: (files: File[]) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  /** Present while a run works: the send button becomes Stop. */
  onStop?: () => void;
}) {
  const { t } = useI18n();
  const fileInput = useRef<HTMLInputElement>(null);

  // the composer grows with what is typed, up to a few lines, then scrolls
  useLayoutEffect(() => {
    const el = composer.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [draft, composer]);

  return (
    <div className="ai-composer" data-busy={busy || undefined}>
      <input ref={fileInput} type="file" multiple accept={acceptedMedia.join(",")} style={{ display: "none" }} onChange={event => {
        onAttach(Array.from(event.target.files ?? [])); event.target.value = "";
      }} />
      <button type="button" className="btn btn-icon" aria-label={t("agentPanel.attachMedia")} title={t(acceptedMedia.length ? "agentPanel.attachMedia" : "agentPanel.unsupportedAttachment")} disabled={busy || archived || !acceptedMedia.length} onClick={() => fileInput.current?.click()}>+</button>
      {/* typing stays open while the agent works; Enter then queues the message for when the turn ends */}
      <textarea
        ref={composer}
        className="ai-input"
        rows={1}
        placeholder={placeholder}
        disabled={archived}
        aria-label={t("agentPanel.messageAria")}
        value={draft}
        onChange={onChange}
        onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); onAttach(Array.from(event.clipboardData.files)); } }}
        onKeyDown={onKeyDown}
      />
      {onStop ? (
        <button type="button" className="btn btn-icon ai-send" title={t("agentPanel.stop")} aria-label={t("agentPanel.stop")} onClick={onStop}>
          <Icon name="i-stop" size={14} />
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-icon ai-send"
          title={problem ?? t("agentPanel.send")}
          aria-label={t("agentPanel.send")}
          disabled={!canSend}
          onClick={onSend}
        >
          <Icon name="i-send" size={14} />
        </button>
      )}
    </div>
  );
}
