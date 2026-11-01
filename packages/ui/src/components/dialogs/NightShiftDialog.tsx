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
import { DEFAULT_MAX_CONCURRENCY, factsChosen, nodeConfig, runConcurrency, shiftCandidates, shiftNote, shiftOrder, UNTIL_DONE_HOURS, useLastNightShift, useNightShift, useNightShiftActions, useOnBattery, useRuleMatches, useShiftPlan, useWorkRules, withTaken, type NodeOverride } from "~/lib/nightShift";
import { useAllItems } from "~/lib/queries";
import { errorSpec, useToast } from "~/lib/toast";
import { NodeConfigPanel, WorkRulesPanel } from "./PlanConfig";
import { PlanGraph } from "./PlanGraph";

const HALT_WORD: Record<string, MessageKey> = { stopped: "nightShift.lastStopped", deadline: "nightShift.lastDeadline", budget: "nightShift.lastBudget", failures: "nightShift.lastFailures" };
const usd = (amount: number) => `$${amount.toFixed(2)}`;
const delivered = (shift: NightShiftView) => shift.counts.delivered + shift.counts.done;

/** Sets a night shift going, and shows the one going: nothing about it needs the assistant. */
export function NightShiftDialog({ projectId, onClose, onOpenIssue }: { projectId: string; onClose: () => void; onOpenIssue: (id: string) => void }) {
  const { t } = useI18n();
  const current = useNightShift(projectId);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} label={t("nightShift.title")} className="sheet-plan">
      <DialogHead title={t("nightShift.title")} />
      {current.data ? <Going projectId={projectId} shift={current.data} onClose={onClose} onOpenIssue={onOpenIssue} /> : current.isLoading ? null : <SetUp projectId={projectId} onClose={onClose} />}
    </Dialog>
  );
}

function PlanViewSwitch({ view, onChange }: { view: "graph" | "list"; onChange: (next: "graph" | "list") => void }) {
  const { t } = useI18n();
  return (
    <div className="seg plan-view" role="group" aria-label={t("nightShift.tickets")} data-testid="plan-view">
      <button type="button" aria-pressed={view === "graph"} data-view="graph" onClick={() => onChange("graph")}><Icon name="i-graph" size={13} /> {t("nightShift.viewGraph")}</button>
      <button type="button" aria-pressed={view === "list"} data-view="list" onClick={() => onChange("list")}><Icon name="i-bars" size={13} /> {t("nightShift.viewList")}</button>
    </div>
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
            {ticket.origin && <Tag tone="faint">{t("nightShift.added")}</Tag>}
            {ticket.note && <p className="meta-txt">{ticket.note}</p>}
            {ticket.origin && <p className="meta-txt">{t("nightShift.addedFrom", { key: ticket.origin.fromKey, why: ticket.origin.why })}</p>}
          </div>
          <Tag tone={ticket.state === "needs-you" || ticket.state === "failed" ? "strong" : "faint"}>{t(`nightShift.state_${ticket.state}` as MessageKey)}</Tag>
        </div>
      ))}
    </div>
  );
}

/** The run as the plan drew it, with each node where it stands. */
function GoingGraph({ projectId, shift, onOpenIssue }: { projectId: string; shift: NightShiftView; onOpenIssue: (id: string) => void }) {
  const { t } = useI18n();
  const all = useAllItems(projectId);
  const byId = useMemo(() => new Map(shift.tickets.map((ticket) => [ticket.itemId, ticket])), [shift.tickets]);
  const items = useMemo(() => (all.data ?? []).filter((item) => byId.has(item.id)), [all.data, byId]);
  const everyone = useMemo(() => new Set(items.map((item) => item.id)), [items]);
  const shown = new Set(items.map((item) => item.id));
  const links = [
    ...items.flatMap((item) => item.blocks.filter((to) => byId.has(to)).map((to) => ({ from: item.id, to, firm: true }))),
    // where an added ticket came from: not a dependency, so it stays dashed
    ...shift.tickets.flatMap((ticket) => (ticket.origin && shown.has(ticket.origin.fromId) && shown.has(ticket.itemId) ? [{ from: ticket.origin.fromId, to: ticket.itemId, firm: false }] : []))
  ];
  const subOf = (item: Item) => {
    const ticket = byId.get(item.id);
    if (!ticket) return null;
    const from = ticket.origin ? t("nightShift.addedFrom", { key: ticket.origin.fromKey, why: ticket.origin.why }) : null;
    return [t(`nightShift.state_${ticket.state}` as MessageKey), ticket.note, from].filter(Boolean).join(" · ");
  };
  if (!items.length) return null;
  return <PlanGraph items={items} links={links} chosen={everyone} subOf={subOf} subs={items.map(subOf).join("|")} onToggle={onOpenIssue} stateOf={(id) => byId.get(id)?.state} addedOf={(id) => !!byId.get(id)?.origin} />;
}

/** What happened, newest first. It stays with the run, so it reads the same after a restart. */
function Timeline({ shift, onOpenIssue }: { shift: NightShiftView; onOpenIssue: (id: string) => void }) {
  const { t, locale } = useI18n();
  if (!shift.steps.length) return null;
  return (
    <Field label={t("nightShift.timeline")}>
      <ol className="plan-timeline" data-testid="plan-timeline">
        {[...shift.steps].reverse().map((step) => (
          <li key={`${step.itemId}:${step.kind}:${step.at}`} data-testid="plan-step" data-kind={step.kind}>
            <time className="meta-txt num">{new Date(step.at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}</time>
            <span>
              <button type="button" className="kref num" onClick={() => onOpenIssue(step.itemId)}>{step.key}</button> {t(`nightShift.step_${step.kind}` as MessageKey)}
              {step.note && <span className="meta-txt"> · {step.note}</span>}
            </span>
          </li>
        ))}
      </ol>
    </Field>
  );
}

function Going({ projectId, shift, onClose, onOpenIssue }: { projectId: string; shift: NightShiftView; onClose: () => void; onOpenIssue: (id: string) => void }) {
  const { t, locale } = useI18n();
  const [view, setView] = useState<"graph" | "list">("graph");
  const toast = useToast();
  const { stop } = useNightShiftActions(projectId);
  const added = shift.tickets.filter((ticket) => ticket.origin).length;
  const until = new Date(shift.deadlineAt).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const facts = [
    t(shift.settings.mode === "terminal" ? "nightShift.runsInTerminal" : "nightShift.runsInSession"),
    t("nightShift.going", { done: delivered(shift), total: shift.tickets.length }),
    ...(shift.counts["needs-you"] ? [t("nightShift.needsYou", { n: shift.counts["needs-you"] })] : []),
    ...(added ? [t("nightShift.addedCount", { n: added })] : []),
    ...(shift.spentUsd > 0 ? [t(shift.costKnown ? "nightShift.spent" : "nightShift.spentPartly", { amount: usd(shift.spentUsd) })] : []),
    ...(shift.halt ? [t("nightShift.stopping")] : shift.settings.maxMinutes <= 24 * 60 ? [t("nightShift.until", { at: until })] : [])
  ];
  return (
    <>
      <DialogBody>
        <div className="stack-4">
          <p className="meta-txt" data-testid="night-shift-going">{facts.join(" · ")}</p>
          <PlanViewSwitch view={view} onChange={setView} />
          {view === "graph" ? <GoingGraph projectId={projectId} shift={shift} onOpenIssue={onOpenIssue} /> : <TicketRows shift={shift} onOpenIssue={onOpenIssue} />}
          <Timeline shift={shift} onOpenIssue={onOpenIssue} />
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
  const plan = useShiftPlan(projectId);

  const [takenKeys, setTaken] = useState<ReadonlySet<string>>(new Set());
  const proposed = useMemo(() => plan.data?.proposed ?? [], [plan.data]);
  const taken = useMemo(() => proposed.filter((e) => takenKeys.has(`${e.from}>${e.to}`)), [proposed, takenKeys]);
  // Everything below reads the tickets as they will stand once what was taken is written.
  const planned = useMemo(() => withTaken(items.data ?? [], taken), [items.data, taken]);
  const candidates = useMemo(() => shiftCandidates(planned), [planned]);
  const open = useMemo(() => new Map(planned.filter((i) => i.status !== "done" && i.status !== "cancelled").map((i) => [i.id, i] as [string, Item])), [planned]);
  const suggested = useMemo(() => (plan.data ? new Set(plan.data.nodes.filter((n) => n.suggested).map((n) => n.itemId)) : factsChosen(candidates)), [plan.data, candidates]);
  // Kept apart from the suggestion, so a plan that lands after a click still ticks what it suggests.
  const [took, setTook] = useState<ReadonlySet<string>>(new Set());
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  const chosen = useMemo(() => new Set([...suggested, ...took].filter((id) => !left.has(id))), [suggested, took, left]);
  const [askedSuggested, setAskedSuggested] = useState(false);
  const isSuggestion = chosen.size === suggested.size && [...suggested].every((id) => chosen.has(id));
  const whyLeft = useMemo(() => new Map((plan.data?.nodes ?? []).flatMap((n) => (n.why ? [[n.itemId, n.why] as [string, string]] : []))), [plan.data]);
  const [view, setView] = useState<"graph" | "list">("graph");
  const workRules = useWorkRules(projectId);
  const ruleMatches = useRuleMatches(projectId);
  const [overrides, setOverrides] = useState<Record<string, NodeOverride>>({});
  const [focus, setFocus] = useState<string | null>(null);
  const ruleOf = (id: string) => (workRules.data ?? []).find((r) => r.id === ruleMatches.data?.[id]);
  const [kind, setKind] = useState<"done" | "night">("done");
  const [chosenMode, setMode] = useState<"terminal" | "run" | null>(null);
  const [chosenEngine, setEngine] = useState<string | null>(null);
  const [chosenPermission, setPermission] = useState<string | null>(null);
  const [maxConcurrency, setMaxConcurrency] = useState(DEFAULT_MAX_CONCURRENCY);
  const [maxHours, setMaxHours] = useState(8);
  const [maxUsd, setMaxUsd] = useState("");
  const [autoMerge, setAutoMerge] = useState(false);
  const [keepAwake, setKeepAwake] = useState(true);
  const [notify, setNotify] = useState<"steps" | "stuck">("steps");
  const [maxInserts, setMaxInserts] = useState(3);
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
  const concurrency = runConcurrency(maxConcurrency, plan.data?.concurrency);
  const concurrencyWhy = plan.data?.concurrencyWhy;
  const add = (ids: string[]) => {
    setTook((now) => new Set([...now, ...ids]));
    setLeft((now) => new Set([...now].filter((id) => !ids.includes(id))));
  };
  const toggle = (id: string) => {
    if (!chosen.has(id)) return add([id]);
    setTook((now) => new Set([...now].filter((other) => other !== id)));
    setLeft((now) => new Set([...now, id]));
  };
  const pickSuggested = () => {
    setTook(new Set());
    setLeft(new Set());
    setAskedSuggested(true);
  };
  const pickNone = () => {
    setTook(new Set());
    setLeft(new Set(candidates.map((i) => i.id)));
  };
  const take = (key: string) => {
    const next = new Set(takenKeys);
    if (!next.delete(key)) next.add(key);
    setTaken(next);
  };
  const setOverride = (id: string, next: NodeOverride | null) => setOverrides(({ [id]: _gone, ...rest }) => (next && Object.keys(next).length ? { ...rest, [id]: next } : rest));
  const sourceOf = (item: Item): string | null => {
    const rule = ruleOf(item.id);
    const { config, from } = nodeConfig(overrides[item.id], rule);
    const gone = config.engine && engines.data && !engines.data.find((e) => e.id === config.engine)?.ok;
    if (gone) return t("nightShift.engineGone", { engine: config.engine! });
    return from === "manual" ? t("nightShift.fromManual") : from === "rule" ? t("nightShift.fromRule", { name: rule!.name }) : null;
  };
  const noteOf = (item: Item) => {
    const merging = nodeConfig(overrides[item.id], ruleOf(item.id)).config.autoMerge ?? autoMerge;
    const note = chosen.has(item.id) ? shiftNote(item, chosen, open, merging) : null;
    return note ? t(note.kind === "outside" ? "nightShift.outside" : note.kind === "after" ? "nightShift.after" : "nightShift.afterNeedsMerge", { keys: note.keys.join(", ") }) : null;
  };
  const subOf = (item: Item) => [noteOf(item) ?? whyLeft.get(item.id), sourceOf(item)].filter(Boolean).join(" · ") || null;
  const focusItem = focus ? candidates.find((i) => i.id === focus) : undefined;
  const shownIds = new Set(candidates.map((i) => i.id));
  const links = [
    ...candidates.flatMap((i) => i.blocks.filter((to) => shownIds.has(to) && !taken.some((e) => e.from === i.id && e.to === to)).map((to) => ({ from: i.id, to, firm: true }))),
    ...proposed.filter((e) => shownIds.has(e.from) && shownIds.has(e.to)).map((e) => ({ from: e.from, to: e.to, firm: takenKeys.has(`${e.from}>${e.to}`) }))
  ];
  const go = () =>
    start.mutate(
      {
        itemIds: shiftOrder(candidates.filter((i) => chosen.has(i.id))).map((i) => i.id),
        mode,
        ...(engine ? { engine: engine.id } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        concurrency,
        maxMinutes: Math.round((kind === "done" ? UNTIL_DONE_HOURS : maxHours) * 60),
        ...(spendLimit > 0 ? { maxUsd: spendLimit } : {}),
        autoMerge,
        keepAwake,
        judge,
        notify,
        maxInserts,
        dependencies: taken.map(({ from, to }) => ({ from, to })),
        nodes: Object.fromEntries(Object.entries(overrides).filter(([id]) => chosen.has(id)))
      },
      { onError: (err) => toast(errorSpec(err)) }
    );
  const openBrief = (file: string) => {
    onClose();
    void navigate({ to: "/p/$projectId/f/$", params: { projectId, _splat: file } });
  };
  const lastWords = last.data && t(last.data.halt ? HALT_WORD[last.data.halt]! : "nightShift.lastFinished", { done: delivered(last.data), total: last.data.tickets.length });
  // The choice starts as the suggestion, so the button often changes nothing: this line is what answers it.
  const pickNote =
    plan.isFetching || !candidates.length ? null
    : !suggested.size ? t(plan.data?.analyzed ? "nightShift.noneSuggested" : "nightShift.noneSuggestedFacts")
    : askedSuggested && isSuggestion ? t("nightShift.pickedSuggested", { n: suggested.size })
    : null;

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
        <div data-testid="plan-summary">
          {plan.isFetching ? (
            <p className="meta-txt">{t("nightShift.planning")}</p>
          ) : plan.data?.summary ? (
            <p>{plan.data.summary}</p>
          ) : (
            plan.data && !plan.data.analyzed && <p className="meta-txt" data-testid="plan-why">{plan.data.why}</p>
          )}
          {!plan.isFetching && <button type="button" className="tlink" data-testid="plan-again" onClick={() => void plan.refetch()}>{t("nightShift.planAgain")}</button>}
        </div>
        <Field label={`${t("nightShift.tickets")} · ${t("nightShift.chosen", { n: chosen.size })}`}>
          {!candidates.length && !items.isLoading && <p className="meta-txt">{t("nightShift.noTickets")}</p>}
          <div className="plan-tools">
            <PlanViewSwitch view={view} onChange={setView} />
            <button
              type="button"
              className="btn btn-ghost"
              data-testid="plan-pick-suggested"
              disabled={plan.isFetching || !suggested.size}
              onClick={pickSuggested}
            >
              {t("nightShift.pickSuggested")}
              {!plan.isFetching && <span className="num">{suggested.size}</span>}
            </button>
            <button type="button" className="btn btn-ghost" data-testid="plan-pick-none" onClick={pickNone}>{t("nightShift.pickNone")}</button>
            <span className="meta-txt" role="status" data-testid="plan-pick-note">{pickNote}</span>
          </div>
          {view === "graph" ? (
            candidates.length > 0 && <PlanGraph items={candidates} links={links} chosen={chosen} subOf={subOf} subs={candidates.map(subOf).join("|")} onToggle={toggle} onAdd={add} onConfigure={setFocus} />
          ) : (
            <div className="inbox-list night-shift-pick" data-testid="night-shift-pick">
              {candidates.map((item) => {
                const note = subOf(item);
                return (
                  <label className="cfg-row" key={item.id} style={{ cursor: "pointer" }} data-testid="night-shift-candidate">
                    <input type="checkbox" checked={chosen.has(item.id)} onChange={() => toggle(item.id)} />
                    <span className="cfg-name"><span className="num">{item.key}</span> {item.title}</span>
                    {note && <span className="meta-txt" data-testid="night-shift-note">{note}</span>}
                    <button type="button" className="btn btn-icon" aria-label={t("nightShift.configure", { key: item.key })} title={t("nightShift.configure", { key: item.key })} onClick={(event) => { event.preventDefault(); setFocus(item.id); }}>
                      <Icon name="i-sliders" size={13} />
                    </button>
                  </label>
                );
              })}
            </div>
          )}
        </Field>
        {focusItem && (
          <NodeConfigPanel
            item={focusItem}
            rule={ruleOf(focusItem.id)}
            override={overrides[focusItem.id]}
            engines={ready}
            allEngines={engines.data ?? []}
            onChange={(next) => setOverride(focusItem.id, next)}
            onClose={() => setFocus(null)}
          />
        )}
        {proposed.length > 0 && (
          <Field label={t("nightShift.proposed")}>
            <p className="meta-txt">{t("nightShift.proposedHint")}</p>
            <div className="inbox-list" data-testid="plan-proposed">
              {proposed.map((edge) => {
                const key = `${edge.from}>${edge.to}`;
                return (
                  <label className="cfg-row" key={key} style={{ cursor: "pointer" }} data-testid="plan-proposed-edge">
                    <input type="checkbox" checked={takenKeys.has(key)} onChange={() => take(key)} />
                    <span className="cfg-name"><span className="num">{edge.fromKey}</span> → <span className="num">{edge.toKey}</span></span>
                    {edge.why && <span className="meta-txt">{edge.why}</span>}
                  </label>
                );
              })}
            </div>
          </Field>
        )}
        <WorkRulesPanel projectId={projectId} rules={workRules.data ?? []} engines={ready} />
        <Field label={t("nightShift.kind")}>
          <div className="seg night-shift-mode" role="group" aria-label={t("nightShift.kind")} data-testid="night-shift-kind">
            <button type="button" aria-pressed={kind === "done"} data-kind="done" onClick={() => setKind("done")}>{t("nightShift.kindDone")}</button>
            <button type="button" aria-pressed={kind === "night"} data-kind="night" onClick={() => setKind("night")}><Icon name="i-moon" size={13} /> {t("nightShift.kindNight")}</button>
          </div>
          <p className="meta-txt">{kind === "done" ? t("nightShift.kindDoneHint", { hours: UNTIL_DONE_HOURS }) : t("nightShift.kindNightHint")}</p>
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
            <input id="nsConcurrency" className="input" type="number" min={1} max={8} value={maxConcurrency} onChange={(event) => setMaxConcurrency(Math.min(8, Math.max(1, Number(event.target.value) || 1)))} />
          </Field>
          {kind === "night" && (
            <Field label={t("nightShift.maxHours")} htmlFor="nsHours">
              <input id="nsHours" className="input" type="number" min={1} max={24} value={maxHours} onChange={(event) => setMaxHours(Math.min(24, Math.max(1, Number(event.target.value) || 1)))} />
            </Field>
          )}
          <Field label={t("nightShift.maxInserts")} htmlFor="nsInserts">
            <input id="nsInserts" className="input" data-testid="night-shift-max-inserts" type="number" min={0} max={10} value={maxInserts} onChange={(event) => setMaxInserts(Math.min(10, Math.max(0, Number(event.target.value) || 0)))} />
          </Field>
          <Field label={t("nightShift.maxUsd")} htmlFor="nsUsd">
            <input id="nsUsd" className="input" type="number" min={0} step={1} placeholder={t("nightShift.maxUsdPlaceholder")} value={maxUsd} onChange={(event) => setMaxUsd(event.target.value)} />
          </Field>
        </div>
        <p className="meta-txt" data-testid="plan-concurrency">{concurrencyWhy ? t("nightShift.concurrencyDecidedWhy", { n: concurrency, why: concurrencyWhy }) : t("nightShift.concurrencyDecided", { n: concurrency })}</p>
        <p className="meta-txt" data-testid="night-shift-inserts-hint">{t(maxInserts ? "nightShift.maxInsertsHint" : "nightShift.maxInsertsOff")}</p>
        {spendLimit > 0 && <p className="meta-txt" data-testid="night-shift-cost-note">{t(mode === "terminal" ? "nightShift.costTerminal" : "nightShift.costSession")}</p>}
        <label className="cfg-row" style={{ cursor: "pointer" }}>
          <input type="checkbox" data-testid="night-shift-auto-merge" checked={autoMerge} onChange={(event) => setAutoMerge(event.target.checked)} />
          <span className="cfg-name">{t("nightShift.autoMerge")}</span>
        </label>
        <p className="meta-txt">{t("nightShift.autoMergeHint")}</p>
        <Field label={t("nightShift.notify")} htmlFor="nsNotify">
          <select id="nsNotify" className="select" data-testid="night-shift-notify" value={notify} onChange={(event) => setNotify(event.target.value as "steps" | "stuck")}>
            <option value="steps">{t("nightShift.notifySteps")}</option>
            <option value="stuck">{t("nightShift.notifyStuck")}</option>
          </select>
          <p className="meta-txt">{t("nightShift.notifyHint")}</p>
        </Field>
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
