import { useMemo } from "react";
import { announcementDate, type Announcement } from "~/lib/announcements";
import { capabilityLink, openCapabilities } from "~/lib/capabilities";
import { useI18n } from "~/lib/i18n";
import { renderMarkdown } from "~/lib/markdown";
import { openExternal } from "~/lib/shell";

/** An announcement read in full: its Markdown, links opening in the browser (or a card of "What Tomrade can do"), and when it started. */
export function AnnouncementBody({ announcement }: { announcement: Announcement }) {
  const { locale } = useI18n();
  const html = useMemo(() => renderMarkdown(announcement.body, undefined, { notes: false, breaks: true }), [announcement.body]);
  return (
    <>
      <article
        className="md-view body-prose"
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={(e) => {
          const anchor = (e.target as HTMLElement).closest("a");
          if (!anchor) return;
          e.preventDefault();
          const href = anchor.getAttribute("href") ?? "";
          // a new feature's announcement can point at its card on "What Tomrade can do"
          const capability = capabilityLink(href);
          if (capability) openCapabilities(capability.focus);
          else if (/^https?:\/\//i.test(href)) openExternal(href);
        }}
      />
      <p className="meta-txt announcement-date">{announcementDate(announcement.startsAt, locale)}</p>
    </>
  );
}
