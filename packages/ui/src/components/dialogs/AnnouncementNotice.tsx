import { useState } from "react";
import { AnnouncementBody } from "~/components/onDemand";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { announcementDate, useAnnouncements, useMarkAnnouncementSeen, type Announcement } from "~/lib/announcements";
import { useI18n } from "~/lib/i18n";

function useOwnLanguage(): Announcement[] {
  const { locale } = useI18n();
  return (useAnnouncements().data ?? []).filter((a) => a.locale === null || a.locale === locale);
}

function Tag({ announcement }: { announcement: Announcement }) {
  const { t } = useI18n();
  return announcement.level === "important" ? <span className="announcement-tag is-important">{t("announcements.important")}</span> : null;
}

/** Each announcement Tomrade published pops up once, oldest first; closing it in any way counts as read. */
export function AnnouncementNotice() {
  const { t } = useI18n();
  const markSeen = useMarkAnnouncementSeen();
  const unseen = useOwnLanguage().filter((a) => !a.seen).reverse();
  const current = unseen[0];
  const dismiss = () => current && markSeen.mutate(current.id);

  return (
    <Dialog open={!!current} onOpenChange={(next) => !next && dismiss()} label={current?.title ?? t("announcements.label")} className="sheet-sm announcement-notice">
      {current && (
        <>
          <DialogHead title={current.title} aside={<Tag announcement={current} />} />
          <DialogBody>
            <AnnouncementBody announcement={current} />
          </DialogBody>
          <DialogFoot>
            <button type="button" autoFocus className="btn btn-primary" disabled={markSeen.isPending} onClick={dismiss}>
              {unseen.length > 1 ? t("announcements.next", { count: unseen.length - 1 }) : t("announcements.gotIt")}
            </button>
          </DialogFoot>
        </>
      )}
    </Dialog>
  );
}

/** Every current announcement, read or not, newest first; opening one reads it in full. */
export function AnnouncementsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, locale } = useI18n();
  const list = useOwnLanguage();
  const markSeen = useMarkAnnouncementSeen();
  const [openId, setOpenId] = useState<string | null>(null);
  const reading = list.find((a) => a.id === openId);
  const close = (next: boolean) => {
    if (!next) setOpenId(null);
    onOpenChange(next);
  };
  const read = (a: Announcement) => {
    setOpenId(a.id);
    if (!a.seen) markSeen.mutate(a.id);
  };

  return (
    <Dialog open={open} onOpenChange={close} label={t("announcements.title")} className="sheet-sm announcement-notice">
      {reading ? (
        <>
          <DialogHead title={reading.title} aside={<Tag announcement={reading} />} />
          <DialogBody>
            <AnnouncementBody announcement={reading} />
          </DialogBody>
          <DialogFoot>
            <button type="button" className="btn btn-secondary" onClick={() => setOpenId(null)}>
              {t("announcements.back")}
            </button>
          </DialogFoot>
        </>
      ) : (
        <>
          <DialogHead title={t("announcements.title")} />
          <DialogBody>
            {list.length === 0 ? (
              <p className="meta-txt">{t("announcements.empty")}</p>
            ) : (
              <ul className="announcement-list">
                {list.map((a) => (
                  <li key={a.id}>
                    <button type="button" className={a.seen ? "announcement-row" : "announcement-row is-unread"} onClick={() => read(a)}>
                      <span className="announcement-row-title">{a.title}</span>
                      <Tag announcement={a} />
                      <span className="meta-txt">{announcementDate(a.startsAt, locale)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </DialogBody>
        </>
      )}
    </Dialog>
  );
}
