# Repository agent connections

Connecting a repository writes a `tomrade/connect` branch and offers a pull request. Merge it, update the checkout and open a new agent session. The URL belongs to the Tomrade instance that generated it.

| Agent | Project configuration | Session reporting |
| --- | --- | --- |
| Claude Code | `.mcp.json`, `.claude/settings.json` | Lifecycle hooks, including start and end |
| Codex CLI | `.codex/config.toml` | Lifecycle hooks, including start and end; requires a hooks-capable version, a trusted project and review through `/hooks` |
| Cursor | `.cursor/mcp.json` | No lifecycle hooks; followed through its MCP connection once it claims a ticket |
| Gemini CLI | `.gemini/settings.json` using `httpUrl` | No lifecycle hooks; followed through its MCP connection once it claims a ticket |

`CLAUDE.md` and `AGENTS.md` explain ticket ownership and when progress reporting is available. Codex also gets the `tomrade-sync` skill.

An agent Tomrade did not start carries no session token, so its claim is tied to its MCP connection (the `Mcp-Session-Id` every Streamable HTTP client sends), whatever the agent: `claim_ticket` takes the hooks session on that repository that no one else holds, or starts one followed only through the connection, and the calls after it on that connection — `note_progress`, `link_code`, `report_merge_blocked` — need no key. A session followed only through its connection ends when the connection closes. After a reconnect or a Tomrade restart the connection is new: the agent names its ticket once (`key`) and the session is found again. A session that already holds a ticket is never handed to another terminal's claim. The result's `tracking.tracked` says whether progress notes will land. Existing `notify` commands and unrelated server definitions are retained. Invalid JSON or TOML is reported, not silently replaced.

Codex hooks carry the `X-Tomrade-Agent: codex` header and the native `session_id`, `cwd` and `hook_event_name` payload. Tomrade records the source as Codex, independently of Claude session IDs. The generated command requires `curl`, finishes within two seconds and does not block work when Tomrade is offline. Codex's own hook trust policy remains in control. Older versions without lifecycle hooks should be upgraded; `notify` alone only reports completed turns and cannot provide session start/end.

For other agents with Streamable HTTP MCP support, manually add a server named `tomrade` using the project URL shown in Repository settings. The connection does not create configuration for those agents. Reading `AGENTS.md` supplies instructions only; it does not itself grant tool access or session tracking.

Configuration references checked on 2026-10-15:

- [Codex hooks and trust](https://learn.chatgpt.com/docs/hooks): project inline TOML hooks and their input fields.
- [Codex notify](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications): turn-completion notifications.
- [Cursor MCP](https://cursor.com/docs/mcp): project `.cursor/mcp.json`, remote `url`.
- [Gemini CLI MCP](https://geminicli.com/docs/tools/mcp-server/): project `.gemini/settings.json`, Streamable HTTP `httpUrl`.
