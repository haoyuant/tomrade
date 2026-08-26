import { useEffect, useState } from "react";
import type { AppSettings } from "@tomrade/core";
import { Icon } from "~/components/icons";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { ThemeSwitch } from "~/components/ui/theme-switch";
import { Eyebrow, LiveDot, Num, Tag } from "~/components/ui/atoms";
import { useDbPath, useMcpUrl, useSaveSettings, useSettings } from "~/lib/queries";

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

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const settings = useSettings();
  const save = useSaveSettings();
  const mcp = useMcpUrl();
  const dbPath = useDbPath();
  const [llm, setLlm] = useState<AppSettings["llm"] | null>(null);

  useEffect(() => {
    if (settings.data && !llm) setLlm(settings.data.llm);
  }, [settings.data, llm]);

  const commit = (patch: Partial<AppSettings["llm"]>) => {
    if (!settings.data || !llm) return;
    const next = { ...llm, ...patch };
    setLlm(next);
    save.mutate({ ...settings.data, llm: next });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label="Settings" className="modal wide">
      <DialogHead title="Settings" aside={<Tag tone="neutral">local · this machine</Tag>} />
      <DialogBody>
        <div className="sec-head">
          <div>
            <h3 className="sec-title">Appearance</h3>
            <p className="sec-lede" style={{ marginTop: 4 }}>
              Three themes, one token block. Every colour in the app resolves from a single declaration set, so a theme is a class on the document —
              not a second copy of the stylesheet.
            </p>
          </div>
        </div>
        <div className="row" style={{ gap: "var(--space-3)", flexWrap: "wrap" }}>
          <ThemeSwitch />
          <p className="meta-txt">Applies immediately and crossfades. Persisted with the rest of your settings.</p>
        </div>
        <ThemePreview />

        <hr className="rule" />
        <div className="sec-head">
          <div>
            <h3 className="sec-title">Tokens</h3>
            <p className="sec-lede" style={{ marginTop: 4 }}>
              Resolved values for the theme you are looking at now. Switch above and this table re-resolves — nothing here is hard-coded.
            </p>
          </div>
        </div>
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

        <hr className="rule" />
        <div className="sec-head">
          <div>
            <h3 className="sec-title">Assistant</h3>
            <p className="sec-lede" style={{ marginTop: 4 }}>
              The direct provider used for extraction, dedup judging and gap checks. Delegated execution goes to your own CLI agents instead.
            </p>
          </div>
        </div>
        <div className="panel stack-3">
          <div className="grid-2">
            <div className="field">
              <label htmlFor="stBase">Base URL</label>
              <input id="stBase" className="input num" value={llm?.baseURL ?? ""} onChange={(e) => commit({ baseURL: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="stModel">Model</label>
              <input id="stModel" className="input num" value={llm?.model ?? ""} onChange={(e) => commit({ model: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="stKey">API key</label>
            <input id="stKey" className="input num" type="password" value={llm?.apiKey ?? ""} onChange={(e) => commit({ apiKey: e.target.value })} />
            <span className="meta-txt">Stored on this machine only. Never sent anywhere but the base URL above.</span>
          </div>
        </div>

        <hr className="rule" />
        <div className="sec-head">
          <div>
            <h3 className="sec-title">Agent access</h3>
            <p className="sec-lede" style={{ marginTop: 4 }}>
              What your coding agents may do to this backlog, and what they may not.
            </p>
          </div>
        </div>
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

        <hr className="rule" />
        <div className="sec-head">
          <div>
            <h3 className="sec-title">Data</h3>
            <p className="sec-lede" style={{ marginTop: 4 }}>
              One SQLite file holds every project on this machine, and the oplog inside it is the whole history — nothing about this workspace lives
              anywhere else.
            </p>
          </div>
        </div>
        <div className="panel">
          <div className="field">
            <label htmlFor="stDb">Database file</label>
            <input id="stDb" className="input num" readOnly value={dbPath.data ?? ""} />
            <span className="meta-txt">Local-first. Back it up by copying the file.</span>
          </div>
        </div>
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-secondary" onClick={() => onOpenChange(false)}>
          Done
        </button>
      </DialogFoot>
    </Dialog>
  );
}
