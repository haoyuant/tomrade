import fs from "node:fs";
import path from "node:path";
import type { Context } from "cordis";
import type { Badge, SectionRow } from "@tomradex/contributions";
import type { HerdrBridge } from "./herdr-bridge.js";
import { currentLinks, primaryOf } from "./scan/absorb.js";
import type { CodeLink, ConnectMode } from "./service.js";
import type { StartMode } from "./start.js";
import type { CodeLinkView, ProposalView } from "./store.js";
import type { CodeWords, PlainCodeWord } from "./words.js";

// Names a word book translates; any other value reads as it is.
const DELIVERY_STATES = { active: "deliveryActive", completed: "deliveryCompleted", cancelled: "deliveryCancelled" } as const;
const PR_STATES = { open: "prOpen", merged: "prMerged", closed: "prClosed" } as const;
export const SESSION_STATES = { running: "sessionRunning", waiting: "sessionWaiting", idle: "sessionIdle", error: "sessionError", ended: "sessionEnded", lost: "sessionLost" } as const;
export const STATUSES = { backlog: "statusBacklog", todo: "statusTodo", doing: "statusDoing", verifying: "statusVerifying", done: "statusDone", cancelled: "statusCancelled" } as const;
export const named = (w: CodeWords, keys: Record<string, PlainCodeWord>, value: string): string => (Object.hasOwn(keys, value) ? w(keys[value]!) : value);

/** Relative time, from seconds ago, in the book's language. */
const agoWords = (w: CodeWords, s: number): string => {
  if (s < 60) return w("justNow");
  const m = Math.round(s / 60);
  if (m < 60) return w("minutesAgo", { n: m });
  const h = Math.round(m / 60);
  if (h < 48) return w("hoursAgo", { n: h });
  return w("daysAgo", { n: Math.round(h / 24) });
};

export interface ContribHost {
  /** The service's own context. */
  ctx: Context;
  codeLink: CodeLink;
  herdr: HerdrBridge;
  words: () => CodeWords;
}

/** What code-link adds to the desktop: the ticket's Code section, card badges, the status line and its commands. */
export function contribute(ctx: Context, host: ContribHost): void {
  const { codeLink: self, ctx: home, herdr, words } = host;
  ctx.contributions.section({
    id: "code",
    title: () => words()("section"),
    render: (item) => {
      const w = words();
      const since = (at: number) => agoWords(w, Math.max(0, Math.round((Date.now() - at) / 1000)));
      const links = self.store.links(item.projectId, item.id);
      const delivery = self.store.currentDelivery(item.projectId, item.id);
      const open = delivery ? self.store.proposalsForDelivery(item.projectId, item.id, delivery.sequence, "open") : [];
      const sessions = self.store.sessions(item.projectId, { itemId: item.id, ...(delivery ? { delivery: delivery.sequence } : {}) });
      // A session that worked this delivery and went on to another ticket: its conversation is still this ticket's record.
      const earlier = delivery ? self.store.movedOn(item.projectId, item.id, delivery.sequence)[0] : undefined;
      if (item.workType === "general" && !links.length && !sessions.length && !earlier) return null;
      if (!delivery && !links.length && !open.length && !sessions.length) return null;
      const current = currentLinks(self.store, item.projectId, item.id);
      const primary = primaryOf(current);
      const ordered = primary ? [primary, ...current.filter((l) => l.id !== primary.id), ...links.filter((l) => l.delivery !== primary.delivery).reverse()] : [...links].reverse();
      const deliveries = self.store.deliveries(item.projectId, item.id);
      const deliveryBySequence = new Map(deliveries.map((entry) => [entry.sequence, entry]));
      const rows: SectionRow[] = [];
      if (delivery && !current.length) rows.push({ label: w("delivery"), icon: "i-merge", state: "live", value: `#${delivery.sequence} · ${named(w, DELIVERY_STATES, delivery.state)}` });
      let shownDelivery: number | null = null;
      for (const l of ordered) {
        if (deliveries.length > 1 && shownDelivery !== l.delivery) {
          const entry = deliveryBySequence.get(l.delivery);
          rows.push({ label: w("delivery"), icon: "i-merge", state: entry?.state === "active" ? "live" : entry?.state === "completed" ? "ok" : "ended", value: `#${l.delivery} · ${entry ? named(w, DELIVERY_STATES, entry.state) : w("historical")}` });
          shownDelivery = l.delivery;
        }
        const repo = home.repos.get(item.projectId, l.repoId);
        const name = repo?.name ?? w("repository");
        if (l.branch) rows.push({ label: w("branch"), icon: "i-branch", mono: true, value: `${l.branch} · ${name}${l.ahead || l.behind ? ` · +${l.ahead} −${l.behind}` : ""}` });
        if (l.prNumber !== null || l.prUrl) {
          rows.push({
            label: w("pullRequest"),
            icon: "i-merge",
            state: l.prState === "merged" ? "ok" : l.prState === "closed" ? "ended" : l.prState === "open" ? "live" : undefined,
            value: `${l.prNumber !== null ? `#${l.prNumber}` : w("openIt")}${l.prState ? ` · ${named(w, PR_STATES, l.prState)}` : ""}`,
            href: l.prUrl ?? undefined
          });
        } else if (l.branch && !l.mergedSha && l.ahead > 0 && self.store.repoState(item.projectId, l.repoId)?.remote === "none") {
          rows.push({ label: w("pullRequest"), icon: "i-merge", value: w("mergeLocal", { base: repo?.defaultBranch ?? "main" }), command: "code-link.merge-local" });
        } else if (l.branch && !l.mergedSha && l.ahead > 0 && self.worktreeOf(item.projectId, item.id)) {
          rows.push({ label: w("pullRequest"), icon: "i-merge", value: w("openPr"), command: "code-link.open-pr" });
        }
        if (l.prState === "open" && l.prUrl && sessions.some((s) => s.blocked === "merge" && s.state !== "ended")) {
          rows.push({ label: w("mergeByHand"), icon: "i-warn", state: "warn", value: w("mergeBlocked"), href: l.prUrl });
        }
        if (l.mergedSha) rows.push({ label: w("merged"), icon: "i-check", state: "ok", mono: true, value: w("mergedOn", { sha: l.mergedSha.slice(0, 7), branch: repo?.defaultBranch ?? "main" }) });
        else if (!l.branch && l.headSha) rows.push({ label: w("landedElsewhere"), icon: "i-merge", mono: true, value: w("mergedOn", { sha: l.headSha.slice(0, 7), branch: repo?.defaultBranch ?? "main" }) });
        if (l.headAt) rows.push({ label: w("lastCommit"), icon: "i-clock", value: since(l.headAt) });
      }
      const live = sessions.find((s) => s.state !== "ended") ?? sessions[0];
      if (live) {
        const where = live.herdrPane ? w("inHerdr") : live.mode === "terminal" ? w("inTerminal") : w("runByTomrade");
        const when = since(live.lastEventAt ?? live.startedAt);
        // A blocked session waits on the person, with the reason it gave.
        const shownState = live.blocked && live.state === "error" ? "waiting" : live.state;
        const state = ({ running: "live", waiting: "waiting", idle: "idle", error: "warn", ended: "ended", lost: "lost" } as const)[shownState];
        // What it is doing beats what it last said; an error is what it last said.
        const doing = live.state === "error" ? (live.summary ?? w("stopped")) : (live.activity ?? live.summary ?? "");
        rows.push({
          label: w("session"),
          icon: live.mode === "terminal" ? "i-terminal" : "i-plug",
          state,
          value: `${named(w, SESSION_STATES, shownState)} · ${where}${doing ? ` · ${doing}` : ""} · ${w("lastSignal", { when })}`,
          // a session in a herdr pane is a click away
          ...(live.herdrPane && live.state !== "ended" ? { command: "code-link.open-terminal" } : {})
        });
        if (live.state !== "running") rows.push({ label: w("continue"), icon: "i-send", value: live.mode === "terminal" ? w("continueTerminal") : w("continueHere"), command: live.mode === "terminal" ? "code-link.start-terminal" : "code-link.start-run" });
        if (live.threadId) rows.push({ label: w("conversation"), icon: "i-panel", value: live.state === "waiting" ? w("openWaiting") : w("openInAssistant"), command: "code-link.open-thread" });
      }
      if (earlier) {
        const now = earlier.itemIds[0] ? home.items.get(item.projectId, earlier.itemIds[0])?.key : undefined;
        const value = [named(w, SESSION_STATES, earlier.state), earlier.title ?? earlier.agent, now ? w("movedOnTo", { key: now }) : null].filter(Boolean).join(" · ");
        rows.push({ label: w("earlierSession"), icon: "i-terminal", value, command: "code-link.open-earlier" });
      }
      const worktree = self.worktreeOf(item.projectId, item.id);
      if (worktree) rows.push({ label: w("worktree"), icon: "i-folder", mono: true, value: worktree, command: "code-link.open-terminal" });
      else if (live?.worktree && live.state !== "ended") rows.push({ label: w("worktree"), icon: "i-folder", mono: true, value: live.worktree });
      const proposal = open.find((p) => p.kind === "propose");
      if (proposal) {
        rows.push({ label: w("proposal"), icon: "i-warn", state: "warn", value: w("accept", { status: named(w, STATUSES, proposal.toStatus ?? "") }), command: "code-link.accept-proposal" });
        rows.push({ label: w("dismiss"), icon: "i-close", value: w("notThisTime"), command: "code-link.reject-proposal" });
      }
      const text = open.map((p) => (p.kind === "flag" ? `⚠ ${p.reason}` : `→ ${named(w, STATUSES, p.toStatus ?? "")}: ${p.reason}`)).join("\n");
      return { rows, text: text || undefined };
    }
  });

  ctx.contributions.badge({
    id: "code-link",
    compute: (items, { projectId }) => {
      const w = words();
      const byItem = new Map<string, CodeLinkView[]>();
      for (const l of self.store.links(projectId)) (byItem.get(l.itemId) ?? byItem.set(l.itemId, []).get(l.itemId)!).push(l);
      const flags = new Map<string, ProposalView>();
      for (const p of self.store.proposals(projectId)) if (p.kind === "flag" && !flags.has(p.itemId)) flags.set(p.itemId, p);
      const waiting = new Map<string, string>();
      const stuck = new Map<string, string>();
      for (const s of self.store.sessions(projectId, { live: true })) {
        for (const id of s.itemIds) {
          if (self.store.currentDelivery(projectId, id)?.sequence !== s.delivery) continue;
          if (s.state === "waiting") waiting.set(id, w("badgeWaitingTitle"));
          if (s.state !== "error") continue;
          const summary = s.summary ?? w("stopped");
          const repo = s.blocked === "merge" ? home.repos.get(projectId, s.repoId) : null;
          const checkout = repo ? home.repos.checkout(repo.remote).checkout : null;
          // A blocked merge or push waits on the person; it is not the agent failing.
          (s.blocked ? waiting : stuck).set(id, repo && !(checkout && fs.existsSync(checkout)) ? `${summary}\n${w("mergeUnseen", { repo: repo.name })}` : summary);
        }
      }
      const out: Record<string, Badge[]> = {};
      for (const item of items) {
        const allLinks = byItem.get(item.id) ?? [];
        const delivery = self.store.currentDelivery(projectId, item.id);
        const links = delivery ? allLinks.filter((link) => link.delivery === delivery.sequence) : [];
        const flag = flags.get(item.id);
        if (!links.length && !flag && !waiting.has(item.id) && !stuck.has(item.id)) continue;
        const badges: Badge[] = [];
        if (waiting.has(item.id)) badges.push({ id: "waiting", label: w("badgeWaiting"), tone: "strong", title: waiting.get(item.id) });
        if (stuck.has(item.id)) badges.push({ id: "stuck", label: w("badgeStuck"), tone: "strong", title: stuck.get(item.id) });
        if (flag) badges.push({ id: "mismatch", label: w("badgeMismatch"), tone: "strong", title: flag.reason });
        const primary = primaryOf(links);
        if (primary?.prState === "open") badges.push({ id: "pr", label: primary.prNumber !== null ? `PR #${primary.prNumber}` : "PR", tone: "strong", title: primary.prUrl ?? undefined });
        else if (links.some((l) => l.mergedSha)) badges.push({ id: "merged", label: w("badgeMerged"), tone: "faint" });
        else if (primary?.branch) badges.push({ id: "branch", label: w("badgeBranch"), tone: "neutral", title: primary.branch });
        if (badges.length) out[item.id] = badges;
      }
      return out;
    }
  });

  ctx.contributions.statusItem({
    id: "code-link",
    opens: "code-inbox",
    text: ({ projectId }) => {
      if (!projectId) return null;
      const w = words();
      const at = self.lastScanAt(projectId);
      const parts: string[] = [];
      const live = self.store.sessions(projectId, { live: true }).filter((s) => s.state !== "lost");
      const waiting = live.filter((s) => s.state === "waiting" || s.blocked).length;
      const stuck = live.filter((s) => s.state === "error" && !s.blocked).length;
      if (live.length) parts.push([w(live.length === 1 ? "sessionsOne" : "sessionsMany", { n: live.length }), waiting ? w("waitingCount", { n: waiting }) : "", stuck ? w("stuckCount", { n: stuck }) : ""].filter(Boolean).join(" · "));
      const unlinked = self.unlinked(projectId).length;
      const open = self.store.proposals(projectId).length;
      const unreachable = self.store.repoStates(projectId).filter((repo) => repo.remote === "unreachable").length;
      if (unlinked) parts.push(w("unlinked", { n: unlinked }));
      if (open) parts.push(w("toConfirm", { n: open }));
      if (unreachable) parts.push(w("unreachable", { n: unreachable }));
      if (!parts.length && !at) return null;
      return w("statusLine", { parts: parts.join(" · ") || w("inSync"), scanned: at ? w("statusScanned", { when: agoWords(w, Math.max(0, Math.round((Date.now() - at) / 1000))) }) : "" });
    }
  });

  const group = () => words()("group");
  const startCommand = (mode: StartMode) => async (scope: { projectId?: string; itemId?: string | null }) => {
    const w = words();
    if (!scope.projectId || !scope.itemId) return { toast: w("selectTicket") };
    const result = await self.start(scope.projectId, scope.itemId, { mode });
    // the Start dialog says what stopped it and offers the fix; the toast is for surfaces that cannot open it
    if (!result.ok) return { toast: result.message, startDialog: mode };
    const warning = result.warnings?.join("\n");
    const started = w(result.continued ? "continuing" : "started", { on: result.branch ? w("startedOn", { branch: result.branch }) : "" });
    // In herdr, shown in Tomrade's Terminal window when that is on.
    if (result.mode === "terminal" && result.launched && result.pane && (await self.showSession(scope.projectId, result.sessionId))) return { toast: `${started}${warning ? `\n${warning}` : ""}` };
    if (result.mode === "terminal") return { toast: `${result.launched ? `${started}${result.pane ? w("herdrHasIt", { pane: result.pane }) : w("terminalHasIt")}` : w("runThis", { command: result.command ?? "" })}${warning ? `\n${warning}` : ""}` };
    // a run here is followed in its conversation, which opens with it
    if (result.waitingOn) return { toast: w("waitingOn", { question: result.waitingOn }), showThread: result.threadId };
    return { toast: `${started}${warning ? `\n${warning}` : ""}`, showThread: result.threadId };
  };
  ctx.contributions.command({ id: "code-link.start-run", title: () => words()("cmdStartRun"), group, run: startCommand("run") });
  ctx.contributions.command({ id: "code-link.start-terminal", title: () => words()("cmdStartTerminal"), group, run: startCommand("terminal") });
  ctx.contributions.command({
    id: "code-link.open-pr",
    title: () => words()("cmdOpenPr"),
    group,
    run: async ({ projectId, itemId }) => {
      if (!projectId || !itemId) return { toast: words()("selectTicket") };
      const r = await self.openPr(projectId, itemId);
      return { toast: r.message };
    }
  });
  ctx.contributions.command({
    id: "code-link.merge-local",
    title: () => words()("cmdMergeLocal"),
    group,
    run: async ({ projectId, itemId }) => {
      if (!projectId || !itemId) return { toast: words()("selectTicket") };
      return { toast: (await self.mergeLocal(projectId, itemId)).message };
    }
  });
  ctx.contributions.command({
    id: "code-link.open-thread",
    title: () => words()("cmdOpenThread"),
    group,
    run: ({ projectId, itemId }) => {
      if (!projectId || !itemId) return { toast: words()("selectTicket") };
      const sessions = self.store.sessions(projectId, { itemId }).filter((s) => s.threadId);
      const threadId = (sessions.find((s) => s.state !== "ended") ?? sessions[0])?.threadId ?? self.store.links(projectId, itemId).find((l) => l.threadId)?.threadId;
      return threadId ? { showThread: threadId } : { toast: words()("noConversation") };
    }
  });
  ctx.contributions.command({
    id: "code-link.open-earlier",
    title: () => words()("cmdOpenEarlier"),
    group,
    run: async ({ projectId, itemId }) => {
      if (!projectId || !itemId) return { toast: words()("selectTicket") };
      const session = self.store.movedOn(projectId, itemId, self.store.currentDelivery(projectId, itemId)?.sequence)[0] ?? self.store.movedOn(projectId, itemId)[0];
      if (!session) return { toast: words()("noConversation") };
      return (await self.showSession(projectId, session.id)) ? {} : { toast: words()("earlierNotShown") };
    }
  });
  ctx.contributions.command({
    id: "code-link.open-terminal",
    title: () => words()("cmdOpenTerminal"),
    group,
    run: async ({ projectId, itemId }) => {
      if (!projectId || !itemId) return { toast: words()("selectTicket") };
      // The session already has a terminal, in herdr: show that one rather than open another, in Tomrade's Terminal window when that is on.
      const session = self.store.sessions(projectId, { itemId, live: true }).find((s) => s.herdrPane && s.state !== "lost");
      if (session && (await self.showSession(projectId, session.id))) return {};
      const shown = await self.showInHerdr(projectId, itemId);
      if (shown) return { toast: shown };
      const cwd = self.worktreeOf(projectId, itemId);
      if (!cwd) return { toast: words()("noWorktree") };
      const settings = await herdr.terminalSettings();
      const launch = await herdr.launch({ cwd, command: 'exec "${SHELL:-bash}"', dir: path.join(self.sessionDir("shell"), path.basename(cwd)), label: path.basename(cwd) }, settings.terminal);
      const fallback = herdr.fallbackNote(words().locale, launch);
      const said = launch.launched ? words()("opened", { cwd }) : `cd ${cwd}`;
      return { toast: fallback ? `${fallback}\n${said}` : said };
    }
  });
  const settle = (accept: boolean) => (scope: { projectId?: string; itemId?: string | null }) => {
    const w = words();
    if (!scope.projectId || !scope.itemId) return { toast: w("selectTicket") };
    const proposal = self.store.proposals(scope.projectId, scope.itemId, "open").find((p) => p.kind === "propose");
    if (!proposal) return { toast: w("nothingProposed") };
    self.resolve(scope.projectId, proposal.id, accept);
    return { toast: accept ? w("movedTo", { status: named(w, STATUSES, proposal.toStatus ?? "") }) : w("dismissed") };
  };
  ctx.contributions.command({ id: "code-link.accept-proposal", title: () => words()("cmdAccept"), group, run: settle(true) });
  ctx.contributions.command({ id: "code-link.reject-proposal", title: () => words()("cmdReject"), group, run: settle(false) });
  const connectCommand = (id: string, title: () => string, mode: ConnectMode) => ctx.contributions.command({
    id,
    title,
    group,
    run: async ({ projectId, itemId }) => {
      if (!projectId) return { toast: words()("openProject") };
      const item = itemId ? home.items.get(projectId, itemId) : null;
      const fromItem = item ? home.boards.get(projectId, item.boardId)?.repoId : null;
      const repos = home.repos.list(projectId);
      const repoId = fromItem ?? (repos.length === 1 ? repos[0]!.id : null);
      if (!repoId) return { toast: words()("pickWorkstream") };
      const r = await self.connect(projectId, repoId, mode);
      return { toast: r.message };
    }
  });
  connectCommand("code-link.connect-local", () => words()("cmdConnectLocal"), "local");
  connectCommand("code-link.connect", () => words()("cmdConnect"), "team");
  ctx.contributions.command({
    id: "code-link.rescan",
    title: () => words()("cmdRescan"),
    group,
    run: async ({ projectId }) => {
      if (!projectId) return { toast: words()("openProject") };
      const s = await self.scan(projectId);
      const w = words();
      return { toast: w("scanned", { scanned: s.scanned, repos: s.repos, changed: s.changed, proposals: s.proposals, skipped: s.skipped.length ? w("scannedSkipped", { n: s.skipped.length }) : "" }) };
    }
  });
}
