import { useEffect, useState, type ReactNode } from "react";
import type { AgentSettings } from "@tomrade/agent";
import type { AppSettings } from "@tomrade/domain";
import type { ModelProfile, ModelsSettings } from "@tomrade/llm";
import { useEngines } from "~/lib/agent";
import type { SettingsSectionView } from "@tomrade/settings";
import { Icon, type IconId } from "~/components/icons";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { ThemeSwitch } from "~/components/ui/theme-switch";
import { PluginsPanel } from "./PluginsPanel";
import { Eyebrow, LiveDot, Num, SectionHead, Tag } from "~/components/ui/atoms";
import { SchemaField, fieldsOf, type JsonSchema } from "~/components/ui/schema-form";
import { useDbPath, useMcpUrl, useSaveSettings, useSettings, useSettingsSections, useStorageProviders } from "~/lib/queries";

/** Each preview re-declares the token block locally, so all three themes are
 *  visible at once — the clearest proof that one class swaps the lot. */
const MODES = [
  { cls: "", name: "Paper", hex: "#f5f4ed" },
  { cls: "dark", name: "Ink", hex: "#141413" },
  { cls: "matcha", name: "Matcha", hex: "oklch .275 .022 142" }
];

const TOKENS = [
  ["Canvas", "--bg", "Page and board background"],
  ["Surface", "--surface", "Cards, panels, title bar"],
  ["Raised", "--surface-warm", "Active sidebar row, secondary buttons"],
  ["Primary text", "--fg", "Issue titles, headings"],
  ["Subtext", "--muted", "Ledes, descriptions"],
  ["Metadata", "--meta", "Issue IDs, dates, counts"],
  ["Border", "--border", "Every hairline in the app"],
  ["Accent", "--accent", "Column numbers, provenance ticks, one CTA"]
] as const;

function ThemePreview() {
  return (
    <div className="mode-grid" style={{ marginTop: "var(--space-5)" }}>
      {MODES.map((m) => (
        <div className={`mode ${m.cls}`} key={m.name}>
          <div className="mode-top">
            <span className="mode-name">{m.name}</span>
            <span className="mode-hex num">{m.hex}</span>
          </div>
          <div className="mini-col">
            <span className="mini-num">02</span>
            <span className="mini-lbl">Doing</span>
          </div>
          <div className="mini-card">
            <span />
            <span>
              <span className="mini-m">TOM-31</span>
              <br />
              <span className="mini-t">AI panel: resize, collapse to rail</span>
            </span>
          </div>
          <div className="mini-card">
            <span style={{ display: "flex", justifyContent: "center" }}>
              <span className="prov-tick" style={{ height: 12 }} />
            </span>
            <span>
              <span className="mini-m">TOM-142</span>
              <br />
              <span className="mini-t">Add boards and view_item_rank</span>
            </span>
          </div>
          <div className="swatches">
            {["--surface", "--surface-warm", "--muted", "--accent"].map((t) => (
              <span key={t} className="sw" style={{ background: `var(${t})` }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Sections the dialog lays out by hand; every other registered section gets a pane drawn from its schema. */
const HAND_DRAWN = new Set(["theme", "models", "agent"]);

/** A plugin's settings pane. Edits commit as they are made and fall back to the stored value if refused. */
function PluginPane({ section, stored, onCommit }: { section: SettingsSectionView; stored: unknown; onCommit: (next: unknown, revert: () => void) => void }) {
  const [value, setValue] = useState<unknown>(stored);
  useEffect(() => setValue(stored), [stored]);
  const schema = section.schema as JsonSchema;
  const commit = (next: unknown) => {
    setValue(next);
    onCommit(next, () => setValue(stored));
  };
  const fields = fieldsOf(schema);
  return (
    <>
      <SectionHead title={section.title}>{section.description}</SectionHead>
      <div className="panel stack-3">
        {fields ? (
          fields.map(([name, field]) => (
            <SchemaField
              key={name}
              id={section.id}
              name={name}
              schema={field}
              value={(value as Record<string, unknown> | undefined)?.[name]}
              onChange={(v) => commit({ ...(value as Record<string, unknown>), [name]: v })}
            />
          ))
        ) : (
          <SchemaField id={section.id} name={section.id} schema={schema} value={value} onChange={commit} />
        )}
      </div>
    </>
  );
}

/** A row in the side menu and the pane it reveals are one and the same thing. */
interface Pane {
  id: string;
  label: string;
  icon: IconId;
  group: "app" | "plugins";
  render: () => ReactNode;
}

export function SettingsDialog({
  open,
  onOpenChange,
  pane
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens on this pane. Empty leaves the sheet on whichever one it was left showing. */
  pane?: string;
}) {
  const settings = useSettings();
  const sections = useSettingsSections();
  const save = useSaveSettings();
  const mcp = useMcpUrl();
  const dbPath = useDbPath();
  const providers = useStorageProviders();
  const [active, setActive] = useState("appearance");

  // The palette sends you straight to a pane; ⌘, leaves you on the last one.
  useEffect(() => {
    if (open && pane) setActive(pane);
  }, [open, pane]);
  // A destination's account is asked for where it is used — in a project's own
  // settings — so the section behind it is storage, not a screen. Whoever claims
  // one draws it; this dialog does not draw it twice.
  const claimed = new Set((providers.data ?? []).map((p) => p.settingsSection).filter(Boolean) as string[]);
  const pluginSections = (sections.data ?? []).filter((s) => !HAND_DRAWN.has(s.id) && !claimed.has(s.id));

  const panes: Pane[] = [
    {
      id: "appearance",
      label: "Appearance",
      icon: "i-sun",
      group: "app",
      render: () => (
        <>
          <SectionHead title="Appearance">
            Three themes, one token block. Every colour in the app resolves from a single declaration set, so a theme is a class on the document — not
            a second copy of the stylesheet.
          </SectionHead>
          <div className="row" style={{ gap: "var(--space-3)", flexWrap: "wrap" }}>
            <ThemeSwitch />
            <p className="meta-txt">Applies immediately and crossfades. Persisted with the rest of your settings.</p>
          </div>
          <ThemePreview />

          <hr className="rule" />
          <SectionHead title="Tokens">
            Resolved values for the theme you are looking at now. Switch above and this table re-resolves — nothing here is hard-coded.
          </SectionHead>
          <div className="panel" style={{ padding: "var(--space-2) var(--space-3)" }}>
            <table className="tok-table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Token</th>
                  <th>Where it lands</th>
                </tr>
              </thead>
              <tbody>
                {TOKENS.map(([role, token, where]) => (
                  <tr key={token}>
                    <td>
                      <span className="chip" style={{ background: `var(${token})` }} />
                      {role}
                    </td>
                    <td className="mono">{token}</td>
                    <td>{where}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )
    },
    {
      id: "assistant",
      label: "Assistant",
      icon: "i-panel" as IconId,
      group: "app" as const,
      render: () => (settings.data ? <AssistantPane settings={settings.data} onSave={(next) => save.mutate(next)} /> : null)
    },
    {
      id: "agents",
      label: "Agent access",
      icon: "i-lock",
      group: "app",
      render: () => (
        <>
          <SectionHead title="Agent access">What your coding agents may do to this backlog, and what they may not.</SectionHead>
          <div className="grid-2">
            <div className="panel">
              <div className="row" style={{ gap: 7, marginBottom: "var(--space-3)" }}>
                <LiveDot />
                <Eyebrow>MCP · listening</Eyebrow>
              </div>
              <p className="num" style={{ fontSize: 14, color: "var(--fg-2)" }}>
                {mcp.data ?? "not running"}
              </p>
              <p className="meta-txt dense" style={{ marginTop: "var(--space-3)" }}>
                Writes arrive with the <Num>baseVersion</Num> the agent read. A stale version is rejected, never merged.
              </p>
            </div>
            <div className="panel">
              <div className="row" style={{ gap: 7, marginBottom: "var(--space-3)" }}>
                <Icon name="i-lock" size={14} style={{ color: "var(--meta)" }} />
                <Eyebrow>Human work is protected</Eyebrow>
              </div>
              <ul className="dash">
                <li>Locked fields reject agent writes with a typed error</li>
                <li>Every write is recorded in the oplog with its author</li>
                <li>
                  <Num>⌘Z</Num> reverts any write, agent or human
                </li>
              </ul>
            </div>
          </div>
        </>
      )
    },
    {
      id: "data",
      label: "Data",
      icon: "i-archive",
      group: "app",
      render: () => (
        <>
          <SectionHead title="Data">
            One SQLite file holds every project on this machine, and the oplog inside it is the whole history. A project can also publish a copy of
            itself as text to a destination you choose — that copy is what a teammate clones, and the database itself never leaves.
          </SectionHead>
          <div className="panel">
            <div className="field">
              <label htmlFor="stDb">Database file</label>
              <input id="stDb" className="input num" readOnly value={dbPath.data ?? ""} />
              <span className="meta-txt">Local-first. Back it up by copying the file — or give a project a destination in its own settings.</span>
            </div>
          </div>
        </>
      )
    },
    ...pluginSections.map(
      (section): Pane => ({
        id: section.id,
        label: section.title,
        icon: "i-plug",
        group: "plugins",
        render: () => (
          <PluginPane
            section={section}
            stored={settings.data?.[section.id]}
            onCommit={(next, revert) => settings.data && save.mutate({ ...settings.data, [section.id]: next }, { onError: revert })}
          />
        )
      })
    ),
    { id: "plugins", label: "Manage plugins", icon: "i-plug", group: "plugins", render: () => <PluginsPanel /> }
  ];

  // A plugin switched off takes its pane with it, so the menu falls back rather than emptying the body.
  const current = panes.find((p) => p.id === active) ?? panes[0];
  const rows = (group: Pane["group"]) =>
    panes
      .filter((p) => p.group === group)
      .map((p) => (
        <button key={p.id} type="button" className="side-row" aria-current={p.id === current.id} onClick={() => setActive(p.id)}>
          <Icon className="ico" name={p.icon} size={14} />
          <span className="side-name">{p.label}</span>
        </button>
      ));

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label="Settings" className="sheet-settings">
      <DialogHead title="Settings" aside={<Tag tone="neutral">local · this machine</Tag>} />
      <div className="dlg-split">
        <nav className="dlg-nav" aria-label="Settings sections">
          <div className="side-group">
            <Eyebrow className="side-label">App</Eyebrow>
            {rows("app")}
          </div>
          <div className="side-group">
            <Eyebrow className="side-label">Plugins</Eyebrow>
            {rows("plugins")}
          </div>
        </nav>
        <DialogBody>{current.render()}</DialogBody>
      </div>
      <DialogFoot>
        <button type="button" className="btn btn-secondary" onClick={() => onOpenChange(false)}>
          Done
        </button>
      </DialogFoot>
    </Dialog>
  );
}

const PRESETS = [
  { title: "DeepSeek", provider: "openai-compatible" as const, baseURL: "https://api.deepseek.com", model: "deepseek-chat" },
  { title: "Anthropic", provider: "anthropic" as const, baseURL: "", model: "claude-sonnet-5" },
  { title: "OpenAI", provider: "openai-compatible" as const, baseURL: "https://api.openai.com/v1", model: "" },
  { title: "Kimi (Moonshot)", provider: "openai-compatible" as const, baseURL: "https://api.moonshot.cn/v1", model: "" },
  { title: "OpenRouter", provider: "openai-compatible" as const, baseURL: "https://openrouter.ai/api/v1", model: "" },
  { title: "Ollama (local)", provider: "openai-compatible" as const, baseURL: "http://127.0.0.1:11434/v1", model: "" },
  { title: "Custom", provider: "openai-compatible" as const, baseURL: "", model: "" }
];

const EMPTY_MODELS: ModelsSettings = { profiles: [], roles: { conversation: "", worker: "" } };
const EMPTY_AGENT: AgentSettings = { defaultEngine: "loop", confirmWritesOver: 0, engines: {} };

/** Model profiles + role bindings + the default engine: the two halves of "who does the work". */
function AssistantPane({ settings, onSave }: { settings: AppSettings; onSave: (next: AppSettings) => void }) {
  const engines = useEngines();
  const models = (settings.models as ModelsSettings | undefined) ?? EMPTY_MODELS;
  const agent = (settings.agent as AgentSettings | undefined) ?? EMPTY_AGENT;
  const [editing, setEditing] = useState<ModelProfile | null>(null);

  const saveModels = (next: ModelsSettings) => onSave({ ...settings, models: next });
  const saveAgent = (next: AgentSettings) => onSave({ ...settings, agent: next });

  const upsert = (profile: ModelProfile) => {
    const rest = models.profiles.filter((p) => p.id !== profile.id);
    const roles = {
      conversation: models.roles.conversation || profile.id,
      worker: models.roles.worker || profile.id
    };
    saveModels({ profiles: [...rest, profile], roles });
    setEditing(null);
  };

  const remove = (id: string) => {
    const profiles = models.profiles.filter((p) => p.id !== id);
    const fallback = profiles[0]?.id ?? "";
    saveModels({
      profiles,
      roles: {
        conversation: models.roles.conversation === id ? fallback : models.roles.conversation,
        worker: models.roles.worker === id ? fallback : models.roles.worker
      }
    });
  };

  const roleSelect = (role: "conversation" | "worker", label: string, help: string) => (
    <div className="field">
      <label htmlFor={`role-${role}`}>{label}</label>
      <select
        id={`role-${role}`}
        className="input"
        value={models.roles[role] || models.profiles[0]?.id || ""}
        onChange={(e) => saveModels({ ...models, roles: { ...models.roles, [role]: e.target.value } })}
      >
        {models.profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title || p.model}
          </option>
        ))}
      </select>
      <span className="meta-txt">{help}</span>
    </div>
  );

  return (
    <>
      <SectionHead title="Models">
        Profiles are endpoints + keys; roles decide which one each job uses. Keys stay on this machine and are only ever sent to the profile's own base URL.
      </SectionHead>
      <div className="panel stack-3">
        {models.profiles.length === 0 && <p className="meta-txt">No profile yet — add one below, or switch the thread's engine to Claude Code.</p>}
        {models.profiles.map((p) => (
          <div className="profile-row" key={p.id}>
            <span className="p-title">{p.title || p.model}</span>
            <span className="p-model num">{p.provider === "anthropic" ? "anthropic" : (p.baseURL ?? "")} · {p.model}</span>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(p)}>
              Edit
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => remove(p.id)}>
              Remove
            </button>
          </div>
        ))}
        {editing ? (
          <ProfileForm profile={editing} onCancel={() => setEditing(null)} onSave={upsert} />
        ) : (
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {PRESETS.map((preset) => (
              <button
                key={preset.title}
                type="button"
                className="chip-opt"
                onClick={() =>
                  setEditing({ id: `p${Date.now().toString(36)}`, title: preset.title === "Custom" ? "" : preset.title, provider: preset.provider, baseURL: preset.baseURL || undefined, apiKey: "", model: preset.model })
                }
              >
                + {preset.title}
              </button>
            ))}
          </div>
        )}
        {models.profiles.length > 0 && (
          <div className="grid-2">
            {roleSelect("conversation", "Conversation (conducts)", "What the assistant reasons with.")}
            {roleSelect("worker", "Worker (generates content)", "Used inside tools for drafting, dedup judging, planning. Can be cheaper.")}
          </div>
        )}
      </div>

      <hr className="rule" />
      <SectionHead title="Engines">Who conducts a new thread. Each thread can switch from its own chip in the panel.</SectionHead>
      <div className="panel stack-3">
        <div className="field">
          <label htmlFor="stEngine">Default engine</label>
          <select
            id="stEngine"
            className="input"
            value={agent.defaultEngine}
            onChange={(e) => saveAgent({ ...agent, defaultEngine: e.target.value })}
          >
            {(engines.data ?? []).map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </select>
        </div>
        <ul className="dash">
          {(engines.data ?? []).map((e) => (
            <li key={e.id}>
              {e.title} — {e.ok ? "ready" : (e.reason ?? "unavailable")}
            </li>
          ))}
        </ul>
        <div className="field">
          <label htmlFor="stConfirm">Pause a plan for confirmation when it writes more than</label>
          <input
            id="stConfirm"
            className="input num"
            type="number"
            min={0}
            style={{ maxWidth: 120 }}
            value={agent.confirmWritesOver}
            onChange={(e) => saveAgent({ ...agent, confirmWritesOver: Math.max(0, Number(e.target.value) || 0) })}
          />
          <span className="meta-txt">items. 0 never pauses — every run stays revertible in one click either way.</span>
        </div>
      </div>
    </>
  );
}

function ProfileForm({ profile, onSave, onCancel }: { profile: ModelProfile; onSave: (p: ModelProfile) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<ModelProfile>(profile);
  const set = (patch: Partial<ModelProfile>) => setDraft((d) => ({ ...d, ...patch }));
  const valid = draft.model.trim().length > 0 && (draft.provider !== "anthropic" || draft.apiKey.trim().length > 0);
  return (
    <div className="panel stack-3" style={{ background: "var(--bg)" }}>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="pfTitle">Name</label>
          <input id="pfTitle" className="input" value={draft.title} placeholder={draft.model || "My model"} onChange={(e) => set({ title: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="pfProvider">Provider</label>
          <select id="pfProvider" className="input" value={draft.provider} onChange={(e) => set({ provider: e.target.value as ModelProfile["provider"] })}>
            <option value="openai-compatible">OpenAI-compatible</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </div>
      </div>
      <div className="grid-2">
        {draft.provider === "openai-compatible" && (
          <div className="field">
            <label htmlFor="pfBase">Base URL</label>
            <input id="pfBase" className="input num" value={draft.baseURL ?? ""} onChange={(e) => set({ baseURL: e.target.value })} />
          </div>
        )}
        <div className="field">
          <label htmlFor="pfModel">Model</label>
          <input id="pfModel" className="input num" value={draft.model} onChange={(e) => set({ model: e.target.value })} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="pfKey">API key</label>
        <input id="pfKey" className="input num" type="password" value={draft.apiKey} onChange={(e) => set({ apiKey: e.target.value })} />
        <span className="meta-txt">A local endpoint (Ollama, LM Studio) needs none.</span>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-secondary" disabled={!valid} onClick={() => onSave({ ...draft, title: draft.title || draft.model })}>
          Save profile
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
