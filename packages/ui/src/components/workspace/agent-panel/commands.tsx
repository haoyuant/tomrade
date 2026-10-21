import type { IconId } from "~/components/icons";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { shortcut } from "~/lib/keys";

/** `fill` puts the prompt in the composer to finish; otherwise the prompt is sent as is. */
export type Starter = { label: MessageKey; prompt?: MessageKey; icon: IconId; fill?: boolean };

/**
 * What a fresh thread can do — hints, not a route. Static on purpose so they appear with
 * the panel, no model call. Shaping an idea into a backlog is only offered to a project
 * with no tickets yet.
 */
export const STARTERS: { fresh: Starter[]; backlog: Starter[] } = {
  fresh: [
    { label: "agentPanel.starterIdea", prompt: "agentPanel.starterIdeaPrompt", icon: "i-leaf", fill: true },
    { label: "agentPanel.starterTicket", prompt: "agentPanel.starterTicketPrompt", icon: "i-plus", fill: true },
    { label: "agentPanel.starterDoc", prompt: "agentPanel.starterDocPrompt", icon: "i-pen", fill: true },
    { label: "agentPanel.starterHelp", icon: "i-search" }
  ],
  backlog: [
    { label: "agentPanel.starterNext", prompt: "agentPanel.starterNextPrompt", icon: "i-chev" },
    { label: "agentPanel.starterGroom", prompt: "agentPanel.starterGroomPrompt", icon: "i-filter" },
    { label: "agentPanel.starterTicket", prompt: "agentPanel.starterTicketPrompt", icon: "i-plus", fill: true },
    { label: "agentPanel.starterDoc", prompt: "agentPanel.starterDocPrompt", icon: "i-pen", fill: true }
  ]
};

/** What a slash command may do to the panel. */
export type SlashContext = { newThread: () => void; help: () => void };
export type SlashCommand = { name: string; aliases?: string[]; hint: MessageKey; run: (c: SlashContext) => void };

/** Typed as `/name` at the start of the composer; anything else starting with `/` is sent as written. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "new", aliases: ["clear"], hint: "agentPanel.slashNew", run: (c) => c.newThread() },
  { name: "help", hint: "agentPanel.slashHelp", run: (c) => c.help() }
];

/** What the composer does — one list for the guide button and /help. */
export const GUIDE: { keys: string; text: MessageKey }[] = [
  { keys: "Enter", text: "agentPanel.guideSend" },
  { keys: "Shift+Enter", text: "agentPanel.guideNewline" },
  { keys: "Enter", text: "agentPanel.guideQueue" },
  { keys: shortcut("⌘↵"), text: "agentPanel.guideSteer" },
  { keys: "Esc", text: "agentPanel.guideStop" },
  { keys: "↑ ↓", text: "agentPanel.guideHistory" },
  { keys: "/", text: "agentPanel.guideSlash" },
  { keys: "/new · /clear", text: "agentPanel.guideNew" },
  { keys: "/help", text: "agentPanel.guideHelp" },
  { keys: "+", text: "agentPanel.guideAttach" }
];

export function GuideList() {
  const { t } = useI18n();
  return (
    <div className="agent-guide">
      {GUIDE.map((g) => (
        <div className="guide-row" key={g.text}>
          <kbd className="num">{g.keys}</kbd>
          <span>{t(g.text)}</span>
        </div>
      ))}
    </div>
  );
}

export const slashCommand = (text: string): SlashCommand | undefined => {
  const name = /^\/(\S+)$/.exec(text.trim())?.[1]?.toLowerCase();
  return name ? SLASH_COMMANDS.find((c) => c.name === name || c.aliases?.includes(name)) : undefined;
};

/** What the typed `/name` could be; the keyboard stays in the composer. */
export function SlashMenu({ matches, pick, onRun }: { matches: SlashCommand[]; pick: SlashCommand; onRun: (command: SlashCommand) => void }) {
  const { t } = useI18n();
  return (
    <div className="slash-menu" role="listbox" aria-label={t("agentPanel.slashMenu")}>
      {matches.map((c) => (
        <button
          key={c.name}
          type="button"
          role="option"
          aria-selected={c === pick}
          className={c === pick ? "slash-row is-on" : "slash-row"}
          // keeps the keyboard in the composer
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onRun(c)}
        >
          <span className="slash-name num">/{c.name}{c.aliases?.length ? ` · /${c.aliases.join(" · /")}` : ""}</span>
          <span className="slash-hint">{t(c.hint)}</span>
        </button>
      ))}
    </div>
  );
}
