import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { DeviceSession, DeviceView, DevicesInfo } from "@tomradex/hub-cloud";
import { LiveDot, SectionHead, Tag } from "~/components/ui/atoms";
import { findEngine, useEngines } from "~/lib/agent";
import { useConfirm } from "~/lib/confirm";
import { useDeviceActions, useDevices } from "~/lib/devices";
import { agoLabel } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useHubInfo, useProjects } from "~/lib/queries";
import { errorSpec, useToast } from "~/lib/toast";
import { AcceptWork } from "./AcceptWork";
import { ShareComputer } from "./ShareComputer";

const PLATFORMS: Record<string, MessageKey> = { darwin: "devices.platform_darwin", win32: "devices.platform_win32", linux: "devices.platform_linux" };

/**
 * The computers signed in to the account: which are online, what each can run and what each is working on.
 * A computer the account's plan has no place for sees the ones that hold the places, to remove one or subscribe.
 */
export function DevicesPane({ onLeave }: { onLeave: () => void }) {
  const { t } = useI18n();
  const hub = useHubInfo();
  const devices = useDevices();
  const info = devices.data;
  const signedOut = hub.data?.cloudEnabled !== true || info?.state === "signed-out";
  return (
    <>
      <SectionHead title={t("devices.label")}>{t("devices.lede")}</SectionHead>
      {signedOut ? (
        <p className="panel meta-txt" data-testid="devices-signed-out">{t("devices.needsAccount")}</p>
      ) : !info ? null : info.state === "removed" ? (
        <p className="panel meta-txt" data-testid="devices-removed">{t("devices.removed")}</p>
      ) : (
        <DeviceList info={info} onLeave={onLeave} />
      )}
    </>
  );
}

function DeviceList({ info, onLeave }: { info: DevicesInfo; onLeave: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const { recheck } = useDeviceActions();
  const over = info.state === "over-limit";
  const limit = info.plan.limit;
  // The places taken: every machine listed holds one.
  const used = info.devices.length;
  const full = limit !== null && used >= limit;
  // Nowhere to pay yet: the button says so rather than open a page that is not there.
  const subscribe = () => toast({ body: t("devices.subscribeSoon") });
  return (
    <div className="device-list" data-testid="devices">
      {over && (
        <div className="device-over" role="status" data-testid="devices-over-limit">
          <p className="device-over-title">{t("devices.overLimitTitle")}</p>
          <p>{t("devices.overLimitBody", { limit: limit ?? used })}</p>
          <div className="device-actions">
            <button type="button" className="btn btn-primary" data-subscribe-url={info.plan.subscribeUrl} onClick={subscribe}>{t("devices.subscribe")}</button>
            <button type="button" className="btn" disabled={recheck.isPending} onClick={() => recheck.mutate(undefined, { onError: (error) => toast(errorSpec(error)) })}>{t("devices.recheck")}</button>
          </div>
        </div>
      )}
      {info.state === "pending" && <p className="panel meta-txt" data-testid="devices-pending">{t("devices.pending")}</p>}
      {info.devices.map((device) => <DeviceCard key={device.id} device={device} canRemove={!device.self} onLeave={onLeave} />)}
      {info.state === "ready" && info.devices.length === 1 && <p className="meta-txt" data-testid="devices-only-one">{t("devices.onlyOne")}</p>}
      {info.state === "ready" && <AcceptWork devices={info.devices} />}
      {info.state === "ready" && <ShareComputer />}
      {info.state !== "pending" && (
        <div className="panel device-plan" data-testid="devices-plan">
          <Tag tone="neutral">{t(info.plan.id === "free" ? "devices.planFree" : "devices.planPaid")}</Tag>
          <span>{limit === null ? t("devices.planUnlimited", { used }) : t("devices.planUsage", { used, limit })}</span>
          {limit !== null && <span className="meta-txt">{t("devices.planHint", { limit })}</span>}
          {full && !over && <button type="button" className="btn" data-subscribe-url={info.plan.subscribeUrl} onClick={subscribe}>{t("devices.subscribe")}</button>}
        </div>
      )}
    </div>
  );
}

function DeviceCard({ device, canRemove, onLeave }: { device: DeviceView; canRemove: boolean; onLeave: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const engines = useEngines();
  const { rename, remove } = useDeviceActions();
  const [naming, setNaming] = useState<string | null>(null);
  const failed = (error: unknown) => toast(errorSpec(error));
  const platform = PLATFORMS[device.platform] ? t(PLATFORMS[device.platform]!) : device.platform;
  const agentTitle = (id: string) => device.agents.find((a) => a.id === id)?.title ?? findEngine(engines.data, id)?.title ?? id;
  const saveName = () => {
    const name = (naming ?? "").trim();
    if (!name || name === device.name) return setNaming(null);
    rename.mutate({ id: device.id, name }, { onSuccess: () => setNaming(null), onError: failed });
  };
  const working = device.sessions.length + device.nightShifts.length > 0;
  return (
    <div className={`panel device-card${device.online ? "" : " offline"}`} data-testid="device-card" data-device={device.id} data-online={device.online ? "true" : "false"}>
      <div className="device-head">
        {naming === null ? (
          <>
            <span className="device-name">{device.name}</span>
            {device.self && <Tag tone="strong">{t("devices.thisComputer")}</Tag>}
          </>
        ) : (
          <form className="device-rename" onSubmit={(e) => { e.preventDefault(); saveName(); }}>
            <input className="input" autoFocus maxLength={80} aria-label={t("devices.renameLabel")} value={naming} onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setNaming(null); } }} />
            <button type="submit" className="btn btn-primary" disabled={rename.isPending}>{t("devices.save")}</button>
            <button type="button" className="btn btn-ghost" onClick={() => setNaming(null)}>{t("devices.cancel")}</button>
          </form>
        )}
        <span className="device-presence" data-testid="device-presence">
          {device.online ? <><LiveDot />{t("devices.online")}</> : t("devices.lastOnline", { time: agoLabel(device.lastSeenAt) })}
        </span>
      </div>
      <div className="device-facts">
        <span>{platform}{device.arch ? ` · ${device.arch}` : ""}</span>
        {device.version && <span>{t("devices.version", { version: device.version })}</span>}
        {device.agents.length ? device.agents.map((agent) => (
          <span key={agent.id} className={`tag neutral device-agent${agent.ready ? "" : " unready"}`} title={agent.ready ? undefined : t("devices.agentNotReady", { agent: agent.title })}>{agent.title}</span>
        )) : <span className="meta-txt">{t("devices.agentsNone")}</span>}
        {!device.git && <Tag tone="faint">{t("devices.gitMissing")}</Tag>}
        {device.accept?.on && <Tag tone="faint" title={t(`devices.ceiling_${device.accept.ceiling}`)}>{t("devices.acceptsWork")}</Tag>}
        {device.repos.length > 0 && <span className="meta-txt">{t("devices.reposCount", { n: device.repos.length })}</span>}
      </div>
      {working && (
        <div className="device-work" data-testid="device-work">
          <p className="device-work-head">{device.online || device.activityAt === null ? t("devices.working") : t("devices.lastKnown", { time: agoLabel(device.activityAt) })}</p>
          {device.sessions.map((session) => <SessionRow key={`${session.projectId}:${session.key}:${session.agent}`} session={session} agent={agentTitle(session.agent)} onLeave={onLeave} />)}
          {device.nightShifts.map((shift) => <p key={shift.projectId} className="device-session meta-txt" data-testid="device-auto-run">{t("devices.autoRun", { done: shift.done, total: shift.total })}</p>)}
        </div>
      )}
      {naming === null && (
        <div className="device-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setNaming(device.name)}>{t("devices.rename")}</button>
          {canRemove && (
            <button type="button" className="btn btn-ghost" disabled={remove.isPending} data-testid="device-remove"
              onClick={async () => { if (await confirm({ body: t("devices.removeConfirm", { name: device.name }), yes: t("devices.removeYes") })) remove.mutate(device.id, { onError: failed }); }}>
              {t("devices.remove")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** A ticket another machine holds. It opens here when this machine has the project; otherwise the key and title are all there is to show. */
function SessionRow({ session, agent, onLeave }: { session: DeviceSession; agent: string; onLeave: () => void }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const projects = useProjects();
  const here = projects.data?.some((p) => p.id === session.projectId) ?? false;
  const open = () => {
    onLeave();
    void navigate({ to: "/p/$projectId/i/$itemId", params: { projectId: session.projectId, itemId: session.key } });
  };
  return (
    <div className="device-session" data-testid="device-session">
      <span className="card-id">{session.key}</span>
      {here ? (
        <button type="button" className="device-ticket" title={t("devices.openTicket", { key: session.key })} onClick={open}>{session.title}</button>
      ) : (
        <span className="device-ticket">{session.title}</span>
      )}
      <span className="meta-txt">{agent} · {t(`devices.state_${session.state}`)}</span>
    </div>
  );
}
