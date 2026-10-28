import { createContext, Fragment, memo, useContext, useLayoutEffect, useMemo, useState } from "react";
import type { CardAction, CardView, ChecklistCard, EngineView, FindingCard, PendingView, RunView, ThreadMessage } from "@tomradex/agent";
import type { Item } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { findEngine } from "~/lib/agent";
import { workConclusion, workParts, type ConvoSay } from "~/lib/convoFold";
import { useI18n } from "~/lib/i18n";
import { openSettingsPane } from "~/lib/settingsHost";
import type { BarStatus } from "~/lib/sessionBar";
import type { foldSteps } from "~/lib/steps";
import { AgentMedia } from "../AgentMedia";
import { ChecklistBlock, FindingBlock } from "../DoctorCards";
import { ClaimCard, type ClaimOffer } from "./ClaimCard";
import { looksLikeMarkdown } from "~/lib/markdownDetect";
import { AgentMarkdown, CardBlock, ErrorBlock, linkify, MergeBlock, ProposalBlock, Question, RetryRow, RunFoot, RunMetrics, StartBatchBlock, StartBrief, StartOffer, Trace, type ProposalCard, type StartOfferCard } from "./blocks";
import type { MergeCard, StartBatchCard } from "@tomradex/code-link";
import { mentionSignature } from "./links";
import { liveStore, useLive, type LiveStore } from "./liveStore";

/** What every row reads besides its own message; the handlers keep their identity, so a streamed reply re-renders only its own line. */
export interface TranscriptActionsValue {
  projectId: string;
  runs: Map<string, RunView>;
  cards: Map<string, CardView>;
  engines?: EngineView[];
  retryEngines: EngineView[];
  pending: PendingView | null;
  byKey: Map<string, Item>;
  busy: boolean;
  /** How the conversations a note points at stand now, by thread id — a child writing code in the background. */
  threadStatus: Map<string, BarStatus>;
  /** The question waiting now is the built-in shell asking before a command, as it does for every one: it points at the setting that lets reading and checks through. */
  commandAsk?: boolean;
  /** Answering moves on to the next conversation or session waiting on the person. */
  goesOnNext?: boolean;
  onOpenIssue: (id: string) => void;
  onOpenThread: (id: string) => void;
  onAnswer: (id: string, value: string | string[]) => void;
  onRevert: (runId: string) => void;
  onOpenSettings: (engineId?: string) => void;
  onCardAction: (action: CardAction, threadId: string, engineId?: string) => void;
}

/** While the run writes code: the way to move that coding into a conversation of its own under this one, and keep talking here. */
export function BackgroundOffer({ busy, onPick }: { busy: boolean; onPick: () => void }) {
  const { t } = useI18n();
  return (
    <button type="button" className="btn btn-secondary btn-xs" data-testid="to-background" title={t("agentPanel.toBackgroundTitle")} disabled={busy} onClick={onPick}>
      {t("agentPanel.toBackground")}
    </button>
  );
}

type StableActions = Pick<TranscriptActionsValue, "projectId" | "engines" | "retryEngines" | "onOpenIssue" | "onOpenThread" | "onAnswer" | "onRevert" | "onOpenSettings" | "onCardAction">;

// What rows read is split: the handlers and engines, which rarely change, by context; the rest (runs, tickets, what is
// pending) from a store each row selects its own part of, so a ticket refetch or a run starting re-renders only the rows it touches.
const TranscriptActions = createContext<{ stable: StableActions; live: LiveStore<TranscriptActionsValue> } | null>(null);

const useTranscriptActions = () => {
  const value = useContext(TranscriptActions);
  if (!value) throw new Error("A transcript row rendered outside <Transcript>");
  return value;
};

/** The thread's messages, steps folded and the kickoff brief closed; only the newest failure offers a retry, only the newest changes the undo hint. */
export function Transcript({ actions, folded, briefId, codeFrom, claim, lastErrorId, lastChangesId, onRetry, onRetryWith, onTroubleshoot, onBackground }: {
  actions: TranscriptActionsValue;
  folded: ReturnType<typeof foldSteps>;
  briefId: string | null;
  /** Where the conversation turns to writing code, and the ticket it writes for: a rule is drawn there. `offer`: that writing is the run going now, so the rule offers to move it out. */
  codeFrom?: { id: string; ticket: string | null; offer?: boolean } | null;
  /** Before the message where the conversation first changes a file: the card that offers to claim a ticket for it. */
  claim?: { at: string; offer: ClaimOffer } | null;
  lastErrorId: string | null;
  lastChangesId: string | null;
  onRetry?: () => void;
  onRetryWith?: (engineId: string) => void;
  onTroubleshoot?: (threadId: string, runId: ThreadMessage["runId"]) => void;
  /** Moves the coding under way into a conversation of its own under this one. */
  onBackground?: () => void;
}) {
  const { t } = useI18n();
  const say: ConvoSay = (key, vars) => t(`codeSessions.${key}`, vars);
  const [live] = useState(() => liveStore(actions));
  useLayoutEffect(() => live.set(actions), [live, actions]);
  const { projectId, engines, retryEngines, onOpenIssue, onOpenThread, onAnswer, onRevert, onOpenSettings, onCardAction } = actions;
  const stable = useMemo(
    () => ({ projectId, engines, retryEngines, onOpenIssue, onOpenThread, onAnswer, onRevert, onOpenSettings, onCardAction }),
    [projectId, engines, retryEngines, onOpenIssue, onOpenThread, onAnswer, onRevert, onOpenSettings, onCardAction]
  );
  const provided = useMemo(() => ({ stable, live }), [stable, live]);
  return (
    <TranscriptActions.Provider value={provided}>
      {folded.map((entry) => {
        const row = "fold" in entry ? (
          // writing code folds whole, under what it came to; chat folds only its earlier steps
          <details key={`fold-${entry.fold[0].id}`} className={entry.coding ? "trace-fold work-fold" : "trace-fold"} data-testid={entry.coding ? "work-fold" : undefined} data-waiting={entry.waiting != null || undefined}>
            <summary>
              <Icon name="i-chev" size={10} />
              <span>{entry.coding ? workConclusion(entry.work, say, entry.waiting) : [t("agentPanel.earlierSteps", { n: entry.fold.length }), ...workParts(entry.work, say)].join(" · ")}</span>
            </summary>
            {entry.fold.map((m) => <TranscriptRow key={m.id} m={m} />)}
          </details>
        ) : entry.id === briefId ? (
          <StartBrief key={entry.id} m={entry} />
        ) : (
          <TranscriptRow
            key={entry.id}
            m={entry}
            // only the newest failure, and only while nothing runs: try the last message again
            onRetry={entry.id === lastErrorId ? onRetry : undefined}
            onRetryWith={entry.id === lastErrorId ? onRetryWith : undefined}
            onTroubleshoot={entry.id === lastErrorId && onTroubleshoot ? () => onTroubleshoot(entry.threadId, entry.runId) : undefined}
            hint={entry.id === lastChangesId}
          />
        );
        const has = (id: string) => ("fold" in entry ? entry.fold.some((m) => m.id === id) : entry.id === id);
        const starts = !!codeFrom && has(codeFrom.id);
        const offers = !!claim && has(claim.at);
        return starts || offers ? (
          <Fragment key={`code-${"fold" in entry ? entry.fold[0].id : entry.id}`}>
            {offers && <ClaimCard offer={claim!.offer} />}
            {starts && (
              <div className="work-rule" role="separator" data-testid="work-rule">
                <span>{codeFrom!.ticket ? t("agentPanel.writingCodeFor", { key: codeFrom!.ticket }) : t("agentPanel.writingCode")}</span>
                {codeFrom!.offer && onBackground && <BackgroundOffer busy={false} onPick={onBackground} />}
              </div>
            )}
            {row}
          </Fragment>
        ) : row;
      })}
    </TranscriptActions.Provider>
  );
}

const NO_ITEMS = new Map<string, Item>();

const TranscriptRow = memo(Row);

function Row(props: Parameters<typeof RowBody>[0]) {
  const { t } = useI18n();
  const b = props.m.block;
  if (props.m.role !== "user" || b.type !== "text" || !b.steerId) return <RowBody {...props} />;
  // sent into the running turn: it sits where the agent read it, and says so
  return (
    <div className="turn turn-user is-steer">
      <span className="turn-rule" />
      <span className="turn-steer">{t("agentPanel.steered")}</span>
      <p>{b.text}</p>
    </div>
  );
}

function RowBody({ m, onRetry, onRetryWith, onTroubleshoot, hint }: { m: ThreadMessage; onRetry?: () => void; onRetryWith?: (engineId: string) => void; onTroubleshoot?: () => void; hint?: boolean }) {
  const { t } = useI18n();
  const { stable, live } = useTranscriptActions();
  const { projectId, engines, retryEngines, onOpenIssue, onOpenThread, onAnswer, onRevert, onOpenSettings, onCardAction } = stable;
  const b = m.block;
  // each row hears only what it shows: its run, its card, the tickets its text names, the question waiting
  const run = useLive(live, (a) => (m.runId ? a.runs.get(m.runId) : undefined));
  const changesRun = useLive(live, (a) => (b.type === "changes" ? a.runs.get(b.runId) : undefined));
  const card = useLive(live, (a) => (b.type === "card" ? a.cards.get(b.id) : undefined));
  const status = useLive(live, (a) => (b.type === "note" && b.threadFor ? a.threadStatus.get(b.threadFor) : undefined));
  const asking = b.type === "question";
  const pending = useLive(live, (a) => (asking ? a.pending : null));
  const commandAsk = useLive(live, (a) => asking && !!a.commandAsk);
  const goesOnNext = useLive(live, (a) => asking && !!a.goesOnNext);
  const busy = useLive(live, (a) => (asking || b.type === "changes") && a.busy);
  // a text names tickets by key: its map changes when one of those does, not when any ticket does
  const mentions = useLive(live, (a) => (b.type === "text" && m.role === "agent" ? mentionSignature(b.text, a.byKey) : b.type === "changes" ? a.byKey : ""));
  const byKey = useMemo(() => (mentions === "" ? NO_ITEMS : live.get().byKey), [live, mentions]);
  if (m.role === "user") {
    const focus = b.type === "text" ? b.focus : undefined;
    return (
      <div className="turn turn-user">
        <span className="turn-rule" />
        <p>{b.type === "text" ? b.text : ""}</p>
        {b.type === "text" && b.attachments?.map(media => <AgentMedia key={media.id} projectId={projectId} threadId={m.threadId} media={media} />)}
        {!!focus?.length && (
          <span className="turn-ctx num" title={focus.map((r) => r.title).join(" · ")}>
            {focus.map((r) => r.key ?? r.title).join(" · ")}
          </span>
        )}
      </div>
    );
  }
  if (b.type === "note" && b.claimed) {
    // the moment the conversation claimed a ticket: its writing code for it starts here
    return (
      <div className="work-rule" role="separator" data-testid="work-rule" data-claimed={b.claimed} title={b.text}>
        <span>{t("agentPanel.writingCodeFor", { key: b.claimed })}</span>
      </div>
    );
  }
  if (b.type === "note") {
    // the conversation the note is about, with how it stands now: running, or waiting on the person
    return (
      <p className="agent-note">
        {b.text}
        {b.settingsFor && (
          <>
            {" "}
            <button type="button" className="link-btn" data-testid="note-settings" onClick={() => onOpenSettings(b.settingsFor)}>
              {t("agentPanel.stepLimitSettings")}
            </button>
          </>
        )}
        {b.threadFor && (
          <>
            {(status === "run" || status === "wait") && <span className="note-thread" data-status={status}>{` · ${t(status === "run" ? "sessionBar.statusRun" : "sessionBar.statusWait")}`}</span>}
            {" "}
            <button type="button" className="link-btn" data-testid="note-thread" onClick={() => onOpenThread(b.threadFor!)}>
              {t("agentPanel.seeThread")}
            </button>
          </>
        )}
      </p>
    );
  }
  const failedEngine = b.type === "error" && m.runId ? findEngine(engines, run?.engine) : undefined;
  const body =
    b.type === "text" ? (
      <>
        {m.role === "agent" && looksLikeMarkdown(b.text)
          ? <AgentMarkdown text={b.text} byKey={byKey} onOpenIssue={onOpenIssue} projectId={projectId} />
          : b.text.split(/\n{2,}/).map((para, i) => <p key={i}>{linkify(para, byKey, onOpenIssue, projectId)}</p>)}
        {m.role === "agent" && m.runId && (run?.changes ?? 0) === 0 && <RunMetrics run={run} />}
      </>
    ) : b.type === "media" ? (
      <AgentMedia projectId={projectId} threadId={m.threadId} media={b.media} caption={b.caption} />
    ) : b.type === "trace" ? (
      <Trace block={b} />
    ) : b.type === "question" ? (
      <Question block={b} pending={pending} onAnswer={onAnswer} busy={busy && pending?.kind !== "permission"} goesOnNext={goesOnNext} onCommandSettings={commandAsk ? () => { if (!openSettingsPane("shell")) onOpenSettings(); } : undefined} />
    ) : b.type === "card" && b.schema === "checklist" ? (
      // the stream holds the card as it was first posted; the live one ticks as checks finish
      <ChecklistBlock title={b.title} card={(card?.data ?? b.data) as ChecklistCard} />
    ) : b.type === "card" && b.schema === "finding" ? (
      <FindingBlock card={b.data as FindingCard} engines={retryEngines} allEngines={engines ?? []} onAction={(action, engineId) => onCardAction(action, m.threadId, engineId)} />
    ) : b.type === "card" && b.schema === "start" ? (
      <StartOffer card={b.data as StartOfferCard} projectId={projectId} onOpenIssue={onOpenIssue} />
    ) : b.type === "card" && b.schema === "start-batch" ? (
      // the live card carries what came of each ticket once started
      <StartBatchBlock card={(card?.data ?? b.data) as StartBatchCard} cardId={b.id} projectId={projectId} threadId={m.threadId} onOpenIssue={onOpenIssue} />
    ) : b.type === "card" && b.schema === "merge" ? (
      <MergeBlock card={(card?.data ?? b.data) as MergeCard} projectId={projectId} threadId={m.threadId} onOpenIssue={onOpenIssue} />
    ) : b.type === "card" && b.schema === "backlog.proposal" ? (
      <ProposalBlock card={b.data as ProposalCard} />
    ) : b.type === "card" ? (
      <CardBlock block={b} />
    ) : b.type === "changes" ? (
      <RunFoot block={b} run={changesRun} byKey={byKey} onOpenIssue={onOpenIssue} onRevert={onRevert} busy={busy} hint={hint} />
    ) : b.type === "error" ? (
      <ErrorBlock
        text={b.text}
        details={b.details}
        engine={failedEngine}
        others={retryEngines.filter((e) => e.id !== failedEngine?.id)}
        onOpenSettings={onOpenSettings}
        onRetry={onRetry}
        onRetryWith={onRetryWith}
        onTroubleshoot={onTroubleshoot}
      />
    ) : b.type === "status" ? (
      <p className="ai-pending">{b.text}</p>
    ) : b.type === "retry" ? (
      <RetryRow block={b} />
    ) : null;
  return (
    <div className="turn turn-ai">
      <div className="turn-mark">
        <span className="prov-tick" style={{ height: 12 }} />
      </div>
      <div className="turn-body">{body}</div>
    </div>
  );
}
