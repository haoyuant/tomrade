# Repository agent connections

Connecting a repository writes a `tomrade/connect` branch and offers a pull request. Merge it, update the checkout and open a new agent session. The URL belongs to the Tomrade instance that generated it.

| Agent | Project configuration | Session reporting |
| --- | --- | --- |
| Claude Code | `.mcp.json`, `.claude/settings.json` | Lifecycle hooks, including start and end |
| Codex CLI | `.codex/config.toml` | Lifecycle hooks, including start and end; requires a hooks-capable version, a trusted project and review through `/hooks` |
| Cursor | `.cursor/mcp.json` | Tools only; this setup does not install Cursor hooks |
| Gemini CLI | `.gemini/settings.json` using `httpUrl` | Tools only; this setup does not install Gemini hooks |

`CLAUDE.md` and `AGENTS.md` explain ticket ownership and when progress reporting is available. Codex also gets the `tomrade-sync` skill. An agent without reporting can still claim a ticket, but must check `tracking.tracked` before calling `note_progress`. Existing `notify` commands and unrelated server definitions are retained. Invalid JSON or TOML is reported, not silently replaced.

Codex hooks carry the `X-Tomrade-Agent: codex` header and the native `session_id`, `cwd` and `hook_event_name` payload. Tomrade records the source as Codex, independently of Claude session IDs. The generated command requires `curl`, finishes within two seconds and does not block work when Tomrade is offline. Codex's own hook trust policy remains in control. Older versions without lifecycle hooks should be upgraded; `notify` alone only reports completed turns and cannot provide session start/end.

For other agents with Streamable HTTP MCP support, manually add a server named `tomrade` using the project URL shown in Repository settings. The connection does not create configuration for those agents. Reading `AGENTS.md` supplies instructions only; it does not itself grant tool access or session tracking.

Configuration references checked on 2026-10-15:

- [Codex hooks and trust](https://learn.chatgpt.com/docs/hooks): project inline TOML hooks and their input fields.
- [Codex notify](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications): turn-completion notifications.
- [Cursor MCP](https://cursor.com/docs/mcp): project `.cursor/mcp.json`, remote `url`.
- [Gemini CLI MCP](https://geminicli.com/docs/tools/mcp-server/): project `.gemini/settings.json`, Streamable HTTP `httpUrl`.
