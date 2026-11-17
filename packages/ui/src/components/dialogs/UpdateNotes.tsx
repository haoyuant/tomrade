import { useI18n } from "~/lib/i18n";
import { releaseNotes } from "~/lib/updates";

/** What changed in the version on offer, in the reader's language; nothing when its release said nothing. */
export function UpdateNotes({ text }: { text: string | null | undefined }) {
  const { t, locale } = useI18n();
  const lines = releaseNotes(text, locale);
  if (!lines.length) return null;
  return (
    <div className="update-notes" data-testid="update-notes">
      <div className="update-notes-title">{t("about.whatsNew")}</div>
      <ul>
        {lines.map((line, at) => (
          <li key={at}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
