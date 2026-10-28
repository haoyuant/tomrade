import { useEffect, useState } from "react";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { Eyebrow } from "~/components/ui/atoms";
import { subscribe } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { useBuildReview, useStudioConfirm, useWorkspaces } from "~/lib/plugins";
import { readableError, useToast } from "~/lib/toast";
import { isLeadWindow } from "~/lib/window-chrome";
import { Findings, Reach, TrustTags } from "./parts";

const wider = (before: { permissions: { network: string[]; fs: string; exec: boolean; window?: boolean }; inject: string[] } | null, after: { permissions: { network: string[]; fs: string; exec: boolean; window?: boolean }; inject: string[] }) => {
  if (!before) return [];
  const FS = ["none", "plugin", "project", "any"];
  return [
    ...after.inject.filter((s) => !before.inject.includes(s)),
    ...after.permissions.network.filter((h) => !before.permissions.network.includes(h)),
    ...(FS.indexOf(after.permissions.fs) > FS.indexOf(before.permissions.fs) ? [`fs: ${after.permissions.fs}`] : []),
    ...(after.permissions.exec && !before.permissions.exec ? ["exec"] : []),
    ...(after.permissions.window && !before.permissions.window ? ["window"] : [])
  ];
};

/**
 * The one place an agent's build becomes code running in Tomrade: what it is,
 * what changed since the last build the person allowed, what it can reach, and
 * what the code check found — then their decision, for exactly this digest.
 */
export function ConfirmBuildDialog({ name, title, onClose }: { name: string; title: string; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const review = useBuildReview(name);
  const confirm = useStudioConfirm();
  const [error, setError] = useState<string | null>(null);
  const r = review.data;
  const grew = r ? wider(r.previous, r) : [];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} label={t("plugins.confirmTitle", { title })} className="sheet-md">
      <DialogHead title={t("plugins.confirmTitle", { title })} />
      <DialogBody>
        <div className="stack-3" data-testid="confirm-build">
          <p>{t("plugins.confirmLede")}</p>
          {r && (
            <>
              <div className="row" style={{ gap: 6 }}>
                <span className="mono meta-txt">{r.id}</span>
                <span className="mono meta-txt">{r.digest.slice(0, 12)}</span>
                <TrustTags tier="dev" risk={r.risk.level} />
              </div>
              <p className="meta-txt">{r.previous ? (r.diff ? t("plugins.confirmDiff", r.diff) : "") : t("plugins.confirmFirst")}</p>
              {!!grew.length && <p style={{ color: "var(--danger)" }}>{t("plugins.confirmWider", { list: grew.join(", ") })}</p>}
              <Eyebrow>{t("plugins.reachTitle")}</Eyebrow>
              <Reach reasons={r.risk.reasons} inject={r.inject} hosts={r.permissions.network.filter((h) => h !== "*")} />
              <Eyebrow>{t("plugins.findings")}</Eyebrow>
              <Findings findings={r.analysis?.findings ?? []} />
            </>
          )}
          {review.error && <p style={{ color: "var(--danger)" }}>{readableError(review.error)}</p>}
          {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
        </div>
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t("plugins.notNow")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!r || confirm.isPending}
          data-testid="confirm-load"
          onClick={() =>
            r &&
            confirm.mutate(
              { name, digest: r.digest },
              {
                onSuccess: (result) => {
                  toast({ body: `${t("plugins.loaded", { title })}${result.snapshot ? ` · ${t("plugins.snapshotSaved")}` : ""}` });
                  onClose();
                },
                onError: (e) => setError(readableError(e))
              }
            )
          }
        >
          {t("plugins.load")}
        </button>
      </DialogFoot>
    </Dialog>
  );
}

/**
 * Wherever the person is, a build the agent staged surfaces as a toast — in the
 * leading window, not in every one; the review opens from it without a trip through Settings.
 */
export function PendingBuildWatcher() {
  const { t } = useI18n();
  const toast = useToast();
  const { refetch } = useWorkspaces();
  const [open, setOpen] = useState<{ name: string; title: string } | null>(null);
  useEffect(() => {
    if (!window.tomrade) return;
    return subscribe("studio.pending", (id) => {
      if (!isLeadWindow()) return;
      void refetch().then(({ data }) => {
        const w = data?.find((x) => x.id === id);
        if (!w) return;
        toast({ body: t("plugins.pendingToast", { title: w.title }), sticky: true, actions: [{ label: t("plugins.review"), run: () => setOpen({ name: w.name, title: w.title }) }] });
      });
    });
  }, [t, toast, refetch]);
  return open ? <ConfirmBuildDialog name={open.name} title={open.title} onClose={() => setOpen(null)} /> : null;
}
