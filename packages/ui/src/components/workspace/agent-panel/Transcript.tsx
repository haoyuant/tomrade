import { createContext, Fragment, memo, useContext } from "react";
import type { CardAction, CardView, ChecklistCard, EngineView, FindingCard, PendingView, RunView, ThreadMessage } from "@tomradex/agent";
import type { Item } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { findEngine } from "~/lib/agent";
import { workParts } from "~/lib/convoFold";
import { useI18n } from "~/lib/i18n";
import type { foldSteps } from "~/lib/steps";
import { AgentMedia } from "../AgentMedia";
import { ChecklistBlock, FindingBlock } from "../DoctorCards";
import { CardBlock, ErrorBlock, linkify, MergeBlock, ProposalBlock, Question, RetryRow, RunFoot, RunMetrics, StartBatchBlock, StartBrief, StartOffer, Trace, type ProposalCard, type StartOfferCard } from "./blocks";
import type { MergeCard, StartBatchCard } from "@tomradex/code-link";

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
  onOpenIssue: (id: string) => void;
  onAnswer: (id: string, value: string | string[]) => void;
  onRevert: (runId: string) => void;
  onOpenSettings: (engineId?: string) => void;
  onCardAction: (action: CardAction, threadId: string, engineId?: string) => void;
}

const TranscriptActions = createContext<TranscriptActionsValue | null>(null);

const useTranscriptActions = (): TranscriptActionsValue => {
  const value = useContext(TranscriptActions);
  if (!value) throw new Error("A transcript row rendered outside <Transcript>");
  return value;
};

/** The thread's messages, steps folded and the kickoff brief closed; only the newest failure offers a retry, only the newest changes the undo hint. */
export function Transcript({ actions, folded, briefId, codeFrom, lastErrorId, lastChangesId, onRetry, onRetryWith, onTroubleshoot }: {
  actions: TranscriptActionsValue;
  folded: ReturnType<typeof foldSteps>;
  briefId: string | null;
  /** Where the conversation turns to writing code, and the ticket it writes for: a rule is drawn there. */
  codeFrom?: { id: string; ticket: string | null } | null;
  lastErrorId: string | null;
  lastChangesId: string | null;
  onRetry?: () => void;
  onRetryWith?: (engineId: string) => void;
  onTroubleshoot?: (threadId: string, runId: ThreadMessage["runId"]) => void;
}) {
  const { t } = useI18n();
  return (
    <TranscriptActions.Provider value={actions}>
      {folded.map((entry) => {
        const row = "fold" in entry ? (
          <details key={`fold-${entry.fold[0].id}`} className="trace-fold">
            <summary>
              <Icon name="i-chev" size={10} />
              <span>{[t("agentPanel.earlierSteps", { n: entry.fold.length }), ...workParts(entry.work, (key, vars) => t(`codeSessions.${key}`, vars))].join(" · ")}</span>
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
        const starts = !!codeFrom && ("fold" in entry ? entry.fold.some((m) => m.id === codeFrom.id) : entry.id === codeFrom.id);
        return starts ? (
          <Fragment key={`code-${codeFrom!.id}`}>
            <div className="work-rule" role="separator" data-testid="work-rule">
              <span>{codeFrom!.ticket ? t("agentPanel.writingCodeFor", { key: codeFrom!.ticket }) : t("agentPanel.writingCode")}</span>
            </div>
            {row}
          </Fragment>
        ) : row;
      })}
    </TranscriptActions.Provider>
  );
}

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
  const { projectId, runs, cards, engines, retryEngines, pending, byKey, onOpenIssue, onAnswer, onRevert, onOpenSettings, onCardAction, busy } = useTranscriptActions();
  const b = m.block;
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
  if (b.type === "note")
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
      </p>
    );
  const failedEngine = b.type === "error" && m.runId ? findEngine(engines, runs.get(m.runId!)?.engine) : undefined;
  const body =
    b.type === "text" ? (
      <>
        {b.text.split(/\n{2,}/).map((para, i) => <p key={i}>{linkify(para, byKey, onOpenIssue, projectId)}</p>)}
        {m.role === "agent" && m.runId && (runs.get(m.runId)?.changes ?? 0) === 0 && <RunMetrics run={runs.get(m.runId)} />}
      </>
    ) : b.type === "media" ? (
      <AgentMedia projectId={projectId} threadId={m.threadId} media={b.media} caption={b.caption} />
    ) : b.type === "trace" ? (
      <Trace block={b} />
    ) : b.type === "question" ? (
      <Question block={b} pending={pending} onAnswer={onAnswer} busy={busy && pending?.kind !== "permission"} />
    ) : b.type === "card" && b.schema === "checklist" ? (
      // the stream holds the card as it was first posted; the live one ticks as checks finish
      <ChecklistBlock title={b.title} card={(cards.get(b.id)?.data ?? b.data) as ChecklistCard} />
    ) : b.type === "card" && b.schema === "finding" ? (
      <FindingBlock card={b.data as FindingCard} engines={retryEngines} allEngines={engines ?? []} onAction={(action, engineId) => onCardAction(action, m.threadId, engineId)} />
    ) : b.type === "card" && b.schema === "start" ? (
      <StartOffer card={b.data as StartOfferCard} projectId={projectId} onOpenIssue={onOpenIssue} />
    ) : b.type === "card" && b.schema === "start-batch" ? (
      // the live card carries what came of each ticket once started
      <StartBatchBlock card={(cards.get(b.id)?.data ?? b.data) as StartBatchCard} cardId={b.id} projectId={projectId} threadId={m.threadId} onOpenIssue={onOpenIssue} />
    ) : b.type === "card" && b.schema === "merge" ? (
      <MergeBlock card={(cards.get(b.id)?.data ?? b.data) as MergeCard} projectId={projectId} threadId={m.threadId} onOpenIssue={onOpenIssue} />
    ) : b.type === "card" && b.schema === "backlog.proposal" ? (
      <ProposalBlock card={b.data as ProposalCard} />
    ) : b.type === "card" ? (
      <CardBlock block={b} />
    ) : b.type === "changes" ? (
      <RunFoot block={b} run={runs.get(b.runId)} byKey={byKey} onOpenIssue={onOpenIssue} onRevert={onRevert} busy={busy} hint={hint} />
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
