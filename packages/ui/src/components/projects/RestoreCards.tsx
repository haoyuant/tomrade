import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RestoreEntry, RestoreState, RestoreSummary } from "@tomradex/storage";
import type { Project } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { Eyebrow, Tag } from "~/components/ui/atoms";
import { useHubInfo, useLocateProject, useRemoveFromHub, useRestores, useRetryRestore, useStorageProviders } from "~/lib/queries";
import { pickDirectory } from "~/lib/shell";
import { useToast } from "~/lib/toast";
import { ConnectionPanel, message } from "./destination";

type IconName = Parameters<typeof Icon>[0]["name"];

const LOOK: Record<RestoreState, { label: MessageKey; icon: IconName; tone: string }> = {
  queued: { label: "restore.stateQueued", icon: "i-clock", tone: "var(--meta)" },
  restoring: { label: "restore.stateRestoring", icon: "i-sync", tone: "var(--accent)" },
  offline: { label: "restore.stateOffline", icon: "i-cloud", tone: "var(--meta)" },
  unpublished: { label: "restore.stateUnpublished", icon: "i-cloud-half", tone: "var(--meta)" },
  "needs-connection": { label: "restore.stateNeedsConnection", icon: "i-plug", tone: "var(--danger)" },
  "needs-provider": { label: "restore.stateNeedsProvider", icon: "i-plug", tone: "var(--danger)" },
  "not-backed-up": { label: "restore.stateNotBackedUp", icon: "i-monitor", tone: "var(--danger)" },
  failed: { label: "restore.stateFailed", icon: "i-warn", tone: "var(--danger)" }
};

const ACTIVE = new Set<RestoreState>(["queued", "restoring"]);
const WAITING = new Set<RestoreState>(["offline", "unpublished"]);

/** The words for one entry: its label, what is happening or missing, and the step under way. */
function useRestoreWords() {
  const { t } = useI18n();
  const where = (e: RestoreEntry) => e.location ?? e.provider?.title ?? "";
  const provider = (e: RestoreEntry) => e.provider?.title ?? "";
  const when = (at?: number) => {
    if (!at) return t("restore.soon");
    const s = Math.round((at - Date.now()) / 1000);
    if (s < 5) return t("restore.soon");
    return s < 90 ? t("restore.inSeconds", { n: s }) : t("restore.inMinutes", { n: Math.round(s / 60) });
  };
  const step = (e: RestoreEntry) =>
    e.step === "downloading" ? t("restore.stepDownloading") : e.step === "opening" ? t("restore.stepOpening") : t("restore.stepContacting");
  const label = (e: RestoreEntry) => t(LOOK[e.state].label, { provider: provider(e) });
  const body = (e: RestoreEntry): string => {
    switch (e.state) {
      case "queued":
        return e.provider ? t("restore.bodyQueued", { where: where(e) }) : t("restore.bodyQueuedLocal");
      case "restoring":
        return t("restore.bodyRestoring");
      case "offline":
        return t("restore.bodyOffline", { where: where(e), when: when(e.retryAt) });
      case "unpublished":
        return t("restore.bodyUnpublished", { where: where(e) });
      case "needs-connection":
        return t("restore.bodyNeedsConnection", { provider: provider(e), where: where(e) });
      case "needs-provider":
        return t("restore.bodyNeedsProvider", { provider: provider(e) });
      case "not-backed-up":
        return t("restore.bodyNotBackedUp");
      case "failed":
        return where(e) ? t("restore.bodyFailed", { where: where(e), detail: e.detail ?? "" }) : t("restore.bodyFailedPlain", { detail: e.detail ?? "" });
    }
  };
  return { label, body, step };
}

/** What the person can do about one entry: retry, connect the account it needs, or point at its folder. */
function RestoreActions({ entry, compact = false }: { entry: RestoreEntry; compact?: boolean }) {
  const { t } = useI18n();
  const retry = useRetryRestore();
  const locate = useLocateProject();
  const toast = useToast();
  const [connecting, setConnecting] = useState(false);
  if (ACTIVE.has(entry.state)) return null;

  const pick = async () => {
    const dir = await pickDirectory(t("restore.locateTitle", { name: entry.name }), t("restore.locateButton"));
    if (!dir) return;
    locate.mutate(
      { projectId: entry.projectId, dir },
      { onSuccess: () => toast({ body: t("restore.locatedToast", { name: entry.name }) }), onError: (error) => toast({ body: message(error) }) }
    );
  };
  const again = () => retry.mutate(entry.projectId, { onError: (error) => toast({ body: message(error) }) });

  return (
    <>
      {entry.state === "needs-connection" && entry.provider && (
        <button type="button" className="btn btn-secondary restore-connect" onClick={() => setConnecting(true)}>
          <Icon name="i-plug" size={13} />
          {t("restore.connect", { provider: entry.provider.title })}
        </button>
      )}
      {entry.state === "not-backed-up" ? (
        <button type="button" className="btn btn-secondary restore-locate" disabled={locate.isPending} onClick={() => void pick()}>
          <Icon name="i-folder" size={13} />
          {t("restore.locate")}
        </button>
      ) : (
        <button type="button" className={compact ? "btn btn-ghost restore-retry" : "btn btn-secondary restore-retry"} disabled={retry.isPending} onClick={again}>
          <Icon name="i-sync" size={13} />
          {retry.isPending ? t("restore.retrying") : t("restore.retry")}
        </button>
      )}
      {connecting && entry.provider && <ConnectDialog providerId={entry.provider.id} title={entry.provider.title} onClose={() => setConnecting(false)} />}
    </>
  );
}

/**
 * The gear of a project that is not on this computer yet. The project's own
 * settings sheet needs its rows and folder, which are not here; this one says
 * where it stands and can take it out of the catalog. Held by id and looked up
 * live: arriving or being removed is what closes it.
 */
function RestoreSheet({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t } = useI18n();
  const words = useRestoreWords();
  const restores = useRestores();
  const hub = useHubInfo();
  const remove = useRemoveFromHub();
  const toast = useToast();
  const [face, setFace] = useState<"details" | "remove">("details");
  const cancel = useRef<HTMLButtonElement>(null);
  const entry = restores.data?.entries.find((e) => e.projectId === projectId);
  const gone = !!restores.data && !entry;
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);
  // The button that opened this face is gone, and the focus trap moves focus to the sheet itself; take it after that.
  useEffect(() => {
    if (face !== "remove") return;
    const frame = requestAnimationFrame(() => cancel.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [face]);
  if (!entry) return null;
  const place = t(hub.data?.cloudEnabled ? "restore.placeAccount" : "restore.placeHub");
  const look = LOOK[entry.state];
  const busy = ACTIVE.has(entry.state);
  const confirm = () =>
    remove.mutate(entry.projectId, {
      onSuccess: () => toast({ body: t("restore.removedToast", { name: entry.name, place }) }),
      onError: (error) => toast({ body: message(error) })
    });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} label={t("restore.detailsFor", { name: entry.name })} className="restore-sheet">
      {face === "details" ? (
        <>
          <DialogHead title={entry.name} aside={<Tag tone="neutral">{entry.keyPrefix}</Tag>} />
          <DialogBody className="stack-4">
            <div className="stack-2">
              <Eyebrow>{t("restore.statusLabel")}</Eyebrow>
              <div className="row" style={{ gap: 7 }}>
                <Icon name={look.icon} size={15} className={entry.state === "restoring" ? "is-spinning" : undefined} style={{ color: look.tone, flex: "none" }} />
                <span className="cfg-name">{entry.state === "restoring" ? `${words.label(entry)} · ${words.step(entry)}` : words.label(entry)}</span>
              </div>
              <p className="meta-txt dense restore-body">{words.body(entry)}</p>
            </div>
            <div className="stack-2">
              <Eyebrow>{t("restore.backupLabel")}</Eyebrow>
              <p className={entry.location || entry.hint ? "num restore-body" : "restore-body"}>{entry.location ?? (entry.hint ? t("restore.lastSeen", { hint: entry.hint }) : t("restore.noBackup"))}</p>
            </div>
            {entry.detail && entry.state !== "failed" && (
              <div className="stack-2">
                <Eyebrow>{t("restore.gitSaid")}</Eyebrow>
                <p className="meta-txt dense num restore-body">{entry.detail}</p>
              </div>
            )}
            <div className="row" style={{ gap: "var(--space-2)", flexWrap: "wrap" }}>
              <RestoreActions entry={entry} />
            </div>
            <div className="stack-2">
              <Eyebrow style={{ color: "var(--danger)" }}>{t("restore.removeSection", { place })}</Eyebrow>
              <p className="meta-txt dense">{t("restore.removeLede")}</p>
              <button type="button" className="btn btn-danger restore-sheet-remove" style={{ alignSelf: "flex-start" }} disabled={busy} aria-haspopup="dialog" onClick={() => setFace("remove")}>
                <Icon name="i-trash" size={13} />
                {t("restore.remove", { place })}
              </button>
            </div>
          </DialogBody>
          <DialogFoot>
            <div className="spacer" />
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              {t("restore.done")}
            </button>
          </DialogFoot>
        </>
      ) : (
        <>
          <DialogHead title={t("restore.removeTitle", { name: entry.name, place })} aside={<Tag tone="neutral">{entry.keyPrefix}</Tag>} />
          <DialogBody className="stack-3">
            <p className="dlg-sub">{t("restore.removeLede")}</p>
            <div className="dangerbar">
              <Icon className="b-mark" name="i-warn" size={15} />
              <p style={{ fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--fg-2)" }}>{t("restore.removeKeeps")}</p>
            </div>
          </DialogBody>
          <DialogFoot>
            {/* Asked once, not typed out: the listing goes, no data does. Cancel holds the focus. */}
            <div className="spacer" />
            <button ref={cancel} type="button" className="btn btn-secondary" onClick={() => setFace("details")}>
              {t("restore.cancel")}
            </button>
            <button type="button" className="btn btn-danger restore-remove-confirm" disabled={remove.isPending || busy} onClick={confirm}>
              <Icon name="i-trash" size={13} />
              {remove.isPending ? t("restore.removing") : t("restore.removeConfirm")}
            </button>
          </DialogFoot>
        </>
      )}
    </Dialog>
  );
}

/** The gear every project card carries, in the same place. */
function SheetGear({ entry, className }: { entry: RestoreEntry; className: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const label = t("restore.detailsFor", { name: entry.name });
  return (
    <>
      <button type="button" className={`btn btn-icon ${className}`} aria-haspopup="dialog" title={label} aria-label={label} onClick={() => setOpen(true)}>
        <Icon name="i-gear" size={15} />
      </button>
      {open && <RestoreSheet projectId={entry.projectId} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The account a destination needs, asked for right where the project waits on it. Connecting resumes the restore by itself. */
function ConnectDialog({ providerId, title, onClose }: { providerId: string; title: string; onClose: () => void }) {
  const { t } = useI18n();
  const providers = useStorageProviders();
  const provider = providers.data?.find((p) => p.id === providerId);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} label={t("restore.connectTitle", { provider: title })}>
      <DialogHead title={t("restore.connectTitle", { provider: title })} />
      <DialogBody className="stack-3">
        <p className="dlg-sub">{t("restore.connectLede")}</p>
        {provider && <ConnectionPanel provider={provider} />}
      </DialogBody>
      <DialogFoot>
        <div className="spacer" />
        <button type="button" className="btn btn-primary" onClick={onClose}>
          {t("restore.done")}
        </button>
      </DialogFoot>
    </Dialog>
  );
}

/** A project in the account that is not on this computer yet: a card in the home grid, saying where it stands. */
export function RestoreCard({ entry }: { entry: RestoreEntry }) {
  const { t } = useI18n();
  const words = useRestoreWords();
  const look = LOOK[entry.state];
  const working = entry.state === "restoring";
  return (
    <div className="proj-cell">
      <div className="proj proj-restore" data-restore={entry.state} data-project={entry.projectId} aria-busy={working}>
        <div className="row" style={{ gap: 7 }}>
          <Icon name={look.icon} size={15} className={working ? "is-spinning" : undefined} style={{ color: look.tone, flex: "none" }} />
          <Eyebrow style={{ minWidth: 0 }}>{working ? `${words.label(entry)} · ${words.step(entry)}` : words.label(entry)}</Eyebrow>
        </div>
        <h2 className="proj-name" style={{ marginTop: "var(--space-3)" }}>
          {entry.name}
        </h2>
        <p className="proj-desc restore-body">{words.body(entry)}</p>
        {entry.state === "not-backed-up" && entry.hint && <p className="meta-txt dense num restore-hint">{t("restore.lastSeen", { hint: entry.hint })}</p>}
        {working && <div className="restore-progress" aria-hidden="true" data-step={entry.step} />}
        <div className="proj-foot restore-foot">
          <span className="stat-k num restore-where" title={entry.location ?? undefined}>
            {entry.location ?? entry.provider?.title ?? entry.keyPrefix}
          </span>
          <span className="row restore-actions" style={{ gap: "var(--space-2)", marginLeft: "auto" }}>
            <RestoreActions entry={entry} />
          </span>
        </div>
      </div>
      <SheetGear entry={entry} className="proj-gear" />
    </div>
  );
}

/** One line over the grid: how far along the account's projects are, or how many wait on the person. */
export function RestoreBanner({ summary }: { summary: RestoreSummary }) {
  const { t } = useI18n();
  const words = useRestoreWords();
  const { entries, restored } = summary;
  if (!entries.length) return null;
  const active = entries.filter((e) => ACTIVE.has(e.state));
  const waiting = entries.filter((e) => WAITING.has(e.state));
  const stuck = entries.length - active.length - waiting.length;
  const current = entries.find((e) => e.state === "restoring");

  let mode: "active" | "attention" | "waiting";
  let title: string;
  let body: ReactNode;
  if (active.length) {
    mode = "active";
    title = t("restore.bannerActiveTitle");
    body = t("restore.bannerActiveBody", { done: restored, total: restored + active.length + waiting.length });
  } else if (stuck) {
    mode = "attention";
    title = t("restore.bannerAttentionTitle", { n: stuck });
    body = t("restore.bannerAttentionBody");
  } else {
    mode = "waiting";
    title = t("restore.bannerWaitingTitle", { n: waiting.length });
    body = t("restore.bannerWaitingBody");
  }
  return (
    <div className="panel restore-banner" role="status" data-mode={mode}>
      <Icon
        name={mode === "active" ? "i-sync" : mode === "attention" ? "i-warn" : "i-cloud"}
        size={17}
        className={mode === "active" ? "is-spinning" : undefined}
        style={{ color: mode === "attention" ? "var(--danger)" : "var(--accent)", flex: "none" }}
      />
      <div className="stack-1" style={{ minWidth: 0 }}>
        <strong className="restore-banner-title">{title}</strong>
        <span className="meta-txt dense">{body}</span>
        {current && <span className="meta-txt dense num restore-banner-current">{t("restore.bannerCurrent", { name: current.name, step: words.step(current) })}</span>}
      </div>
    </div>
  );
}

/** The Hub pane's list: the same entries, one row each. */
export function RestoreRow({ entry }: { entry: RestoreEntry }) {
  const words = useRestoreWords();
  const look = LOOK[entry.state];
  return (
    <div className="cfg-row hub-other restore-row" data-project={entry.projectId} data-restore={entry.state}>
      <Icon name={look.icon} size={15} className={entry.state === "restoring" ? "is-spinning" : undefined} style={{ color: look.tone }} />
      <span className="cfg-name" style={{ minWidth: 0 }}>
        <span>
          {entry.name} <span className="meta-txt num">{entry.keyPrefix}</span>
        </span>
        <span className="meta-txt dense restore-row-body">{entry.state === "restoring" ? words.step(entry) : words.body(entry)}</span>
      </span>
      <span className="meta-txt restore-row-state">{words.label(entry)}</span>
      <RestoreActions entry={entry} compact />
      <SheetGear entry={entry} className="restore-row-gear" />
    </div>
  );
}

/** Say so when a project the account named has arrived; its card is gone by then, and the project list may lag a beat behind. */
export function useRestoredToasts(summary: RestoreSummary | undefined, projects: Project[]) {
  const { t } = useI18n();
  const toast = useToast();
  const listed = useRef(new Map<string, string>());
  const departed = useRef(new Map<string, string>());
  useEffect(() => {
    if (!summary) return;
    const now = new Map(summary.entries.map((e) => [e.projectId, e.name]));
    for (const [id, name] of listed.current) if (!now.has(id)) departed.current.set(id, name);
    listed.current = now;
    const here = new Set(projects.map((p) => p.id));
    for (const [id, name] of departed.current) {
      if (!here.has(id)) continue;
      departed.current.delete(id);
      toast({ body: t("restore.locatedToast", { name }) });
    }
  }, [summary, projects, t, toast]);
}
