import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Icon } from "~/components/icons";
import { Dialog, DialogBody, DialogHead } from "~/components/ui/dialog";
import { subscribe } from "~/lib/api";
import {
  CAPABILITIES,
  mediaOf,
  openCapabilities,
  projectToTry,
  tryHost,
  tryLater,
  useCapabilitiesRequest,
  usePrefersReducedMotion,
  type Capability
} from "~/lib/capabilities";
import { useI18n } from "~/lib/i18n";
import { useProjects } from "~/lib/queries";
import { openSettingsPane } from "~/lib/settingsHost";
import { useToast } from "~/lib/toast";
import { cn } from "~/lib/utils";

/** The loop plays by itself unless the system asks for less motion; then it waits on its still for a press of play. */
function CapabilityMedia({ capability }: { capability: Capability }) {
  const { locale } = useI18n();
  const reduced = usePrefersReducedMotion();
  const media = mediaOf(capability, locale, import.meta.env.BASE_URL);
  const [noVideo, setNoVideo] = useState(false);
  const [noPoster, setNoPoster] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (reduced) video.current?.pause();
  }, [reduced]);
  return (
    <div className="capability-media">
      {media.video && !noVideo ? (
        <video
          ref={video}
          src={media.video}
          poster={media.poster}
          muted
          loop
          playsInline
          autoPlay={!reduced}
          controls={reduced}
          preload={reduced ? "none" : "auto"}
          onError={() => setNoVideo(true)}
        />
      ) : noPoster ? (
        <Icon name={capability.icon} size={28} />
      ) : (
        <img src={media.poster} alt="" loading="lazy" draggable={false} onError={() => setNoPoster(true)} />
      )}
    </div>
  );
}

function CapabilityCard({ capability, focused, onTry }: { capability: Capability; focused?: boolean; onTry: (capability: Capability) => void }) {
  const { t } = useI18n();
  const title = t(capability.title);
  return (
    <article className={cn("capability", focused && "is-focus")} data-capability={capability.id}>
      <CapabilityMedia capability={capability} />
      <div className="capability-text">
        <h3 className="capability-title">
          <Icon name={capability.icon} size={14} />
          {title}
        </h3>
        <p className="capability-line">{t(capability.line)}</p>
      </div>
      <button type="button" className="btn btn-secondary capability-try" data-testid={`capability-try-${capability.id}`} aria-label={t("capabilities.tryItAria", { title })} onClick={() => onTry(capability)}>
        {t("capabilities.tryIt")}
      </button>
    </article>
  );
}

export function CapabilityCards({ focus, onTry }: { focus?: string | null; onTry: (capability: Capability) => void }) {
  return (
    <div className="capability-grid">
      {CAPABILITIES.map((c) => (
        <CapabilityCard key={c.id} capability={c} focused={focus === c.id} onTry={onTry} />
      ))}
    </div>
  );
}

/** Carries out a card's "Try it": in the project on show, else in one it opens first. */
export function useTryCapability(): (capability: Capability) => void {
  const navigate = useNavigate();
  const projects = useProjects();
  const toast = useToast();
  const { t } = useI18n();
  return (capability) => {
    const action = capability.action;
    if (action.kind === "imSettings" && openSettingsPane("im")) return;
    const host = tryHost();
    if (host) return host.run(action);
    const open = /^#\/p\/([^/?]+)/.exec(window.location.hash)?.[1];
    const projectId = projectToTry(projects.data ?? [], open ? decodeURIComponent(open) : null);
    if (!projectId) return toast({ body: t("capabilities.needProject") });
    tryLater(projectId, action);
    void navigate({ to: "/p/$projectId", params: { projectId } });
  };
}

/** Mounted once at the root: the page opened from the Help menu, the command palette or an announcement's link. */
export function CapabilitiesHost() {
  const { t } = useI18n();
  const request = useCapabilitiesRequest();
  const tryIt = useTryCapability();
  useEffect(() => subscribe("app.capabilities", () => openCapabilities()), []);
  const { open, focus, at } = request;
  useEffect(() => {
    if (!open || !focus) return;
    const frame = requestAnimationFrame(() => document.querySelector(`.capability[data-capability="${focus}"]`)?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [open, focus, at]);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && request.close()} label={t("capabilities.label")} className="sheet-capabilities">
      <DialogHead title={t("capabilities.label")} />
      <DialogBody>
        <p className="sec-lede capability-lede">{t("capabilities.lede")}</p>
        <CapabilityCards
          focus={focus}
          onTry={(capability) => {
            request.close();
            tryIt(capability);
          }}
        />
      </DialogBody>
    </Dialog>
  );
}

/** The projects home, while there are few projects: the same cards in place, until put away. */
export function CapabilitiesSection({ onHide }: { onHide: () => void }) {
  const { t } = useI18n();
  const tryIt = useTryCapability();
  return (
    <section className="capabilities-home" data-testid="capabilities-home">
      <div className="sec-head">
        <div>
          <h2 className="sec-title">{t("capabilities.label")}</h2>
          <p className="sec-lede" style={{ marginTop: 4 }}>
            {t("capabilities.lede")}
          </p>
        </div>
        <button type="button" className="btn btn-ghost" title={t("capabilities.hideHint")} onClick={onHide}>
          {t("capabilities.hide")}
        </button>
      </div>
      <CapabilityCards onTry={tryIt} />
    </section>
  );
}
