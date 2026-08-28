import { useEffect, useState, type ReactNode } from "react";
import type { LlmSettings } from "@tomrade/domain";
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
const HAND_DRAWN = new Set(["theme", "llm"]);

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
  const [llm, setLlm] = useState<LlmSettings | null | undefined>(undefined);
  const [active, setActive] = useState("appearance");

  useEffect(() => {
    if (settings.data && llm === undefined) setLlm(settings.data.llm ?? null);
  }, [settings.data, llm]);

  // The palette sends you straight to a pane; ⌘, leaves you on the last one.
  useEffect(() => {
    if (open && pane) setActive(pane);
  }, [open, pane]);

  const commit = (patch: Partial<LlmSettings>) => {
    if (!settings.data || !llm) return;
    const next = { ...llm, ...patch };
    setLlm(next);
    save.mutate({ ...settings.data, llm: next });
  };
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
    ...(llm
      ? [
          {
            id: "assistant",
            label: "Assistant",
            icon: "i-panel" as IconId,
            group: "app" as const,
            render: () => (
              <>
                <SectionHead title="Assistant">
                  The direct provider used for extraction, dedup judging and gap checks. Delegated execution goes to your own CLI agents instead.
                </SectionHead>
                <div className="panel stack-3">
                  <div className="grid-2">
                    <div className="field">
                      <label htmlFor="stBase">Base URL</label>
                      <input id="stBase" className="input num" value={llm.baseURL ?? ""} onChange={(e) => commit({ baseURL: e.target.value })} />
                    </div>
                    <div className="field">
                      <label htmlFor="stModel">Model</label>
                      <input id="stModel" className="input num" value={llm.model ?? ""} onChange={(e) => commit({ model: e.target.value })} />
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="stKey">API key</label>
                    <input id="stKey" className="input num" type="password" value={llm.apiKey ?? ""} onChange={(e) => commit({ apiKey: e.target.value })} />
                    <span className="meta-txt">Stored on this machine only. Never sent anywhere but the base URL above.</span>
                  </div>
                </div>
              </>
            )
          }
        ]
      : []),
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
