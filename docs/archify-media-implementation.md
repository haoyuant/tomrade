# Archify and conversation media

## Usage

The desktop configuration enables `@tomradex/archify`. Ask the loop or a local
agent to draw an architecture, workflow, sequence, dataflow, or lifecycle diagram.
The shared `diagram.archify` playbook and `diagram_schema` / `diagram_render`
tools are available through the loop registry and run-bound local MCP.
Generated HTML appears in conversation with expanded preview, download, and
explicit Save to Files. Saving a diagram retains its editable JSON source.

Enable supported input modalities on the model profile in Settings. The panel
supports file selection, paste and drag/drop: at most eight files, 32 MiB each.
Capabilities follow the selected profile/engine and are checked by the backend.
For image generation/editing, select the OpenAI Images API provider and a suitable
model. Compatible chat providers can separately declare image or audio output.
Archify itself renders technical diagrams, not arbitrary AI illustrations.

## Runtime and persistence

- Tomrade owns installation, pinned to upstream commit
  `d673e8300df60a5c8166abe78787fdc78f6b8000`. First use fetches into
  `userData/runtimes/archify`; later runs reuse it. Git and GitHub access are
  required for first installation. Failed installation can retry.
- Rendering uses Electron's Node runtime. Local agents do not install their own
  Archify CLI or execute `npx skills add`.
- Media bytes use durable project/thread-scoped storage. Transcripts reference
  media IDs. Reload preserves media; deleting a thread removes its media.
- HTML previews are sandboxed without same-origin privileges and with network
  access disabled by CSP. Images/audio/video have inline previews; PDF and other
  supported files remain downloadable.
- Diagram export is explicit: after rendering, the playbook asks whether to use
  the recommended `diagrams/<short-slug>` directory or a user-provided Files
  directory. `diagram_export` then writes the complete `diagram.html` and
  editable `diagram.json` through the Files versioning service. The panel's
  generic Save to Files action remains available for any media block.
- Follow-up turns recover diagram JSON through `read_media_source`. Native
  agents publish generated workspace files through `display_media`.

## Transport coverage

| Engine/provider | Input | Output |
| --- | --- | --- |
| Compatible chat API | Configured image/audio/video/PDF | Text/tools, inline base64 image, streamed audio |
| Anthropic API | Images/PDF, profile gated | Text/tools and tool-published media |
| OpenAI Images API | Text, PNG/JPEG/WebP references | Generated/edited PNG |
| Claude SDK / legacy CLI | Images/PDF | Shared diagram/file publication tools |
| Codex app-server | Images, supported audio | Native image events and shared tools |
| Codex legacy CLI | Local image files | Native image events and shared tools |

Provider capabilities are configured explicitly, not inferred from model names.
Remote-URL-only image responses are rejected rather than silently fetched.
Image-only models are called without chat tools. Panel display support alone
does not imply a provider supports that modality.

## Verification

- Backend build and UI typecheck passed.
- 57 tests passed, including all five diagram types against the pinned renderer,
  loop/MCP delivery, persistence/isolation, provider payloads, Images API
  generation/editing, and native-agent protocols. Two live-agent tests skipped;
  no paid external model calls were made.
- Real Electron regression: 13 checks passed using the pinned local checkout
  and a deterministic HTTP model. Covers inline/expanded rendering, sandboxing,
  Files versions/source, image output, dropped image input, reload persistence,
  and text-only capability gating.
- Fresh online installation failed at GitHub TLS negotiation
  (`SSL_ERROR_SYSCALL`). Fresh network installation is therefore not claimed as
  verified in this environment; cached pinned runtime execution is verified.

Build the backend, start the UI dev server on port 5189 (or set `TOMRADE_DEV_URL`),
then run `pnpm --filter @tomrade/desktop test:media`. Optionally set
`ARCHIFY_TEST_SKILL` to the `archify` directory inside a pinned upstream checkout;
without it the harness attempts fresh installation. That variable also enables
actual-renderer integration tests:

```sh
ARCHIFY_TEST_SKILL=/path/to/checkout/archify pnpm exec vitest run packages/agent/tests packages/llm/tests packages/engine-claude-code/tests packages/engine-codex/tests packages/archify/tests packages/mcp/tests --maxWorkers=2
```

Tests passed with Node 26 in this environment. The shell's older Node 22 failed
native SQLite worker initialization; use a runtime compatible with the installed
native dependencies.
