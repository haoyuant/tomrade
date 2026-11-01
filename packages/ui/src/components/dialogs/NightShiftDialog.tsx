import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { NightShiftView } from "@tomradex/night-shift";
import type { Item } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { Tag } from "~/components/ui/atoms";
import { Dialog, DialogBody, DialogClose, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { Field } from "~/components/dialogs/plugins/parts";
import { useEngines } from "~/lib/agent";
import { isFullAccess, permissionLabel, useStartDefaults } from "~/lib/codeLink";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { shiftCandidates, shiftNote, shiftOrder, useLastNightShift, useNightShift, useNightShiftActions, useOnBattery } from "~/lib/nightShift";
import { useAllItems } from "~/lib/queries";
import { errorSpec, useToast } from "~/lib/toast";

const HALT_WORD: Record<string, MessageKey> = { stopped: "nightShift.lastStopped", deadline: "nightShift.lastDeadline", budget: "nightShift.lastBudget", failures: "nightShift.lastFailures" };
const usd = (amount: number) => `$${amount.toFixed(2)}`;
const delivered = (shift: NightShiftView) => shift.counts.delivered + shift.counts.done;

/** Sets a night shift going, and shows the one going: nothing about it needs the assistant. */
export function NightShiftDialog({ projectId, onClose, onOpenIssue }: { projectId: string; onClose: () => void; onOpenIssue: (id: string) => void }) {
  const { t } = useI18n();
  const current = useNightShift(projectId);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} label={t("nightShift.title")} className="sheet-md">
      <DialogHead title={t("nightShift.title")} />
      {current.data ? <Going projectId={projectId} shift={current.data} onClose={onClose} onOpenIssue={onOpenIssue} /> : current.isLoading ? null : <SetUp projectId={projectId} onClose={onClose} />}
    </Dialog>
  );
}

function TicketRows({ shift, onOpenIssue }: { shift: NightShiftView; onOpenIssue: (id: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="inbox-list" data-testid="night-shift-tickets">
      {shift.tickets.map((ticket) => (
        <div className="inbox-row" key={ticket.itemId} data-testid="night-shift-ticket" data-state={ticket.state}>
          <div>
            <button type="button" className="kref num" onClick={() => onOpenIssue(ticket.itemId)}>{ticket.key}</button> {ticket.title}
            {ticket.note && <p className="meta-txt">{ticket.note}</p>}
          </div>
          <Tag tone={ticket.state === "needs-you" || ticket.state === "failed" ? "strong" : "faint"}>{t(`nightShift.state_${ticket.state}` as MessageKey)}</Tag>
        </div>
      ))}
    </div>
  );
}

function Going({ projectId, shift, onClose, onOpenIssue }: { projectId: string; shift: NightShiftView; onClose: () => void; onOpenIssue: (id: string) => void }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const { stop } = useNightShiftActions(projectId);
  const until = new Date(shift.deadlineAt).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const facts = [
    t(shift.settings.mode === "terminal" ? "nightShift.runsInTerminal" : "nightShift.runsInSession"),
    t("nightShift.going", { done: delivered(shift), total: shift.tickets.length }),
    ...(shift.counts["needs-you"] ? [t("nightShift.needsYou", { n: shift.counts["needs-you"] })] : []),
    ...(shift.spentUsd > 0 ? [t(shift.costKnown ? "nightShift.spent" : "nightShift.spentPartly", { amount: usd(shift.spentUsd) })] : []),
    shift.halt ? t("nightShift.stopping") : t("nightShift.until", { at: until })
  ];
  return (
    <>
      <DialogBody>
        <div className="stack-4">
          <p className="meta-txt" data-testid="night-shift-going">{facts.join(" · ")}</p>
          <TicketRows shift={shift} onOpenIssue={onOpenIssue} />
        </div>
      </DialogBody>
      <DialogFoot>
        <DialogClose asChild><button type="button" className="btn btn-secondary" onClick={onClose}>{t("common.close")}</button></DialogClose>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="night-shift-stop"
          title={t("nightShift.stopHint")}
          disabled={!!shift.halt || stop.isPending}
          onClick={() => stop.mutate(shift.id, { onError: (err) => toast(errorSpec(err)) })}
        >
          {t("nightShift.stop")}
        </button>
      </DialogFoot>
    </>
  );
}

function SetUp({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const items = useAllItems(projectId);
  const engines = useEngines();
  const defaults = useStartDefaults();
  const last = useLastNightShift(projectId);
  const { start } = useNightShiftActions(projectId);
  const navigate = useNavigate();

  const candidates = useMemo(() => shiftCandidates(items.data ?? []), [items.data]);
  const open = useMemo(() => new Map((items.data ?? []).filter((i) => i.status !== "done" && i.status !== "cancelled").map((i) => [i.id, i] as [string, Item])), [items.data]);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const chosen = useMemo(() => picked ?? new Set(candidates.filter((i) => i.status === "todo").map((i) => i.id)), [picked, candidates]);
  const [chosenMode, setMode] = useState<"terminal" | "run" | null>(null);
  const [chosenEngine, setEngine] = useState<string | null>(null);
  const [chosenPermission, setPermission] = useState<string | null>(null);
  const [concurrency, setConcurrency] = useState(2);
  const [maxHours, setMaxHours] = useState(8);
  const [maxUsd, setMaxUsd] = useState("");
  const [autoMerge, setAutoMerge] = useState(false);
  const [keepAwake, setKeepAwake] = useState(true);
  const [judge, setJudge] = useState(true);
  const onBattery = useOnBattery();

  const mode = chosenMode ?? defaults.data?.mode ?? "run";
  const ready = (engines.data ?? []).filter((e) => e.ok && e.capabilities.includes("code") && (mode === "terminal" || !e.terminalOnly));
  const remembered = defaults.data?.engine;
  const engine = ready.find((e) => e.id === (chosenEngine ?? remembered)) ?? ready[0];
  const permissionModes = mode === "run" ? engine?.permissionModes : undefined;
  const rememberedPermission = remembered === engine?.id ? defaults.data?.permissionMode : undefined;
  const permissionMode = permissionModes ? (chosenPermission ?? rememberedPermission ?? permissionModes.default) : undefined;
  const spendLimit = Number(maxUsd);
  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (!next.delete(id)) next.add(id);
    setPicked(next);
  };
  const go = () =>
    start.mutate(
      {
        itemIds: shiftOrder(candidates.filter((i) => chosen.has(i.id))).map((i) => i.id),
        mode,
        ...(engine ? { engine: engine.id } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        concurrency,
        maxMinutes: Math.round(maxHours * 60),
        ...(spendLimit > 0 ? { maxUsd: spendLimit } : {}),
        autoMerge,
        keepAwake,
        judge
      },
      { onError: (err) => toast(errorSpec(err)) }
    );
  const openBrief = (file: string) => {
    onClose();
    void navigate({ to: "/p/$projectId/f/$", params: { projectId, _splat: file } });
  };
  const lastWords = last.data && t(last.data.halt ? HALT_WORD[last.data.halt]! : "nightShift.lastFinished", { done: delivered(last.data), total: last.data.tickets.length });

  return (
    <>
      <DialogBody>
        <div className="stack-4">
        <p className="meta-txt">{t("nightShift.intro")}</p>
        {lastWords && (
          <p className="meta-txt" data-testid="night-shift-last">
            {t("nightShift.lastShift")}: {lastWords}
            {last.data?.briefPath && <> · <button type="button" className="tlink" data-testid="night-shift-brief" onClick={() => openBrief(last.data!.briefPath!)}>{t("nightShift.openBrief")}</button></>}
          </p>
        )}
        <Field label={`${t("nightShift.tickets")} · ${t("nightShift.chosen", { n: chosen.size })}`}>
          {!candidates.length && !items.isLoading && <p className="meta-txt">{t("nightShift.noTickets")}</p>}
          <div className="inbox-list night-shift-pick" data-testid="night-shift-pick">
            {candidates.map((item) => {
              const note = chosen.has(item.id) ? shiftNote(item, chosen, open, autoMerge) : null;
              return (
                <label className="cfg-row" key={item.id} style={{ cursor: "pointer" }} data-testid="night-shift-candidate">
                  <input type="checkbox" checked={chosen.has(item.id)} onChange={() => toggle(item.id)} />
                  <span className="cfg-name"><span className="num">{item.key}</span> {item.title}</span>
                  {note && <span className="meta-txt" data-testid="night-shift-note">{t(note.kind === "outside" ? "nightShift.outside" : note.kind === "after" ? "nightShift.after" : "nightShift.afterNeedsMerge", { keys: note.keys.join(", ") })}</span>}
                </label>
              );
            })}
          </div>
        </Field>
        <Field label={t("nightShift.where")}>
          <div className="seg night-shift-mode" role="group" aria-label={t("nightShift.where")} data-testid="night-shift-mode">
            <button type="button" aria-pressed={mode === "terminal"} data-mode="terminal" onClick={() => setMode("terminal")}>
              <Icon name="i-terminal" size={13} /> {t("nightShift.whereTerminal")}
            </button>
            <button type="button" aria-pressed={mode === "run"} data-mode="run" onClick={() => setMode("run")}>
              <Icon name="i-plug" size={13} /> {t("nightShift.whereSession")}
            </button>
          </div>
          <p className="meta-txt">{t(mode === "terminal" ? "nightShift.whereTerminalHint" : "nightShift.whereSessionHint")}</p>
        </Field>
        <Field label={t("nightShift.agent")} htmlFor="nsEngine">
          <select id="nsEngine" className="select" value={engine?.id ?? ""} onChange={(event) => { setEngine(event.target.value); setPermission(null); }}>
            {ready.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
          </select>
          {engines.isSuccess && !ready.length && <p className="meta-txt">{t("nightShift.noAgents")}</p>}
        </Field>
        {permissionModes ? (
          <Field label={t("nightShift.permissions")} htmlFor="nsPermission">
            <select id="nsPermission" className="select" value={permissionMode} onChange={(event) => setPermission(event.target.value)}>
              {permissionModes.choices.map((choice) => <option key={choice.value} value={choice.value}>{permissionLabel(t, choice)}</option>)}
            </select>
            {isFullAccess(permissionMode) ? (
              <p className="start-warning" role="note"><Icon name="i-warn" size={13} /><span>{t("codeLink.fullAccessWarning")}</span></p>
            ) : (
              <p className="meta-txt">{t("nightShift.stallNote")}</p>
            )}
          </Field>
        ) : (
          mode === "terminal" && <p className="meta-txt" data-testid="night-shift-terminal-permissions">{t("nightShift.terminalPermissions")}</p>
        )}
        <div className="night-shift-limits">
          <Field label={t("nightShift.concurrency")} htmlFor="nsConcurrency">
            <input id="nsConcurrency" className="input" type="number" min={1} max={8} value={concurrency} onChange={(event) => setConcurrency(Math.min(8, Math.max(1, Number(event.target.value) || 1)))} />
          </Field>
          <Field label={t("nightShift.maxHours")} htmlFor="nsHours">
            <input id="nsHours" className="input" type="number" min={1} max={24} value={maxHours} onChange={(event) => setMaxHours(Math.min(24, Math.max(1, Number(event.target.value) || 1)))} />
          </Field>
          <Field label={t("nightShift.maxUsd")} htmlFor="nsUsd">
            <input id="nsUsd" className="input" type="number" min={0} step={1} placeholder={t("nightShift.maxUsdPlaceholder")} value={maxUsd} onChange={(event) => setMaxUsd(event.target.value)} />
          </Field>
        </div>
        {spendLimit > 0 && <p className="meta-txt" data-testid="night-shift-cost-note">{t(mode === "terminal" ? "nightShift.costTerminal" : "nightShift.costSession")}</p>}
        <label className="cfg-row" style={{ cursor: "pointer" }}>
          <input type="checkbox" data-testid="night-shift-auto-merge" checked={autoMerge} onChange={(event) => setAutoMerge(event.target.checked)} />
          <span className="cfg-name">{t("nightShift.autoMerge")}</span>
        </label>
        <p className="meta-txt">{t("nightShift.autoMergeHint")}</p>
        <label className="cfg-row" style={{ cursor: "pointer" }}>
          <input type="checkbox" data-testid="night-shift-judge" checked={judge} onChange={(event) => setJudge(event.target.checked)} />
          <span className="cfg-name">{t("nightShift.judge")}</span>
        </label>
        <p className="meta-txt">{t("nightShift.judgeHint")}</p>
        <label className="cfg-row" style={{ cursor: "pointer" }}>
          <input type="checkbox" data-testid="night-shift-keep-awake" checked={keepAwake} onChange={(event) => setKeepAwake(event.target.checked)} />
          <span className="cfg-name">{t("nightShift.keepAwake")}</span>
        </label>
        <p className="meta-txt">{t("nightShift.awakeNote")}</p>
        {onBattery && <p className="start-warning" role="note" data-testid="night-shift-battery"><Icon name="i-warn" size={13} /><span>{t("nightShift.onBattery")}</span></p>}
        </div>
      </DialogBody>
      <DialogFoot>
        <DialogClose asChild><button type="button" className="btn btn-secondary" onClick={onClose}>{t("common.cancel")}</button></DialogClose>
        <button type="button" className="btn btn-primary" data-testid="night-shift-start" disabled={!chosen.size || !engine || start.isPending} onClick={go}>
          {start.isPending ? t("nightShift.starting") : t("nightShift.start")}
        </button>
      </DialogFoot>
    </>
  );
}
