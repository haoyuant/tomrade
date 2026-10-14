# TOM-94 implementation checkpoint

Stopped at the user's requested quota boundary on 2026-10-14: Codex account/rateLimits/read returned usedPercent 80 for the 300-minute window (20% remaining). Do not resume without a new user instruction. Branch: tom-94. Work is saved in the working tree, not committed.

## Authorized scope

Full Agent conversations through IM, rather than automatic ticket intake only. TOM-94 matched and confirmed by the user, currently Doing. Original ticket text remains intake-only; design artifact is attached to its active delivery. Do not silently re-scope TOM-92 or platform tickets or move their dependencies. User specifically required work on the tom-94 branch.

## Implemented in working tree

- packages/im: built-in ctx.im service, local Hub migrations, explicit connection/project/actor routes, SDK adapter registration, same assistant threads as desktop, inbox/message dedup, serialized input, scoped answer tokens, /answer /stop /status /new, output projection, media transfer, outbox retry/uncertain states, lifecycle and reconnect handling.
- Agent send optional requestId/source: persistent receipt with user message/run written transactionally; replay returns the original run, changed request refused. Permission answers also get receipts.
- SDK IM contract; extension facade wraps callbacks, enforces namespace, cleans up adapters. Plugin inspection records imAdapters. Plugin test host loads Agent and Im.
- Desktop composition, package dependencies, TypeScript project references and pnpm lock updated.
- docs/im-common-layer-design.md saved previously and already attached to TOM-94 through Files.

## Verification completed

- Full backend `pnpm exec tsc -b` passed BEFORE the latest connection/reconnect refinements.
- AFTER those refinements, `pnpm exec tsc -b packages/im packages/extensions` passed.
- BEFORE those refinements, targeted Vitest passed 43 tests across IM (11), Agent receipts (2), permissions (3), Agent (26), media integration (1).
- No tests run after the final reconnect/cleanup changes due to the quota stop.
- No real Slack or Feishu adapter built, no credentials used, no network-platform validation, no plugin_check/plugin_test CLI validation yet.

## Required next work

1. Re-run targeted tests after lifecycle changes; inspect outstanding edge cases before declaring completion.
2. Add a real loopback WebSocket test through an SDK-loaded adapter to establish persistent connections/reconnect/unload behavior. Current tests use fake adapters, not real sockets. Plugin CLI inspection/test runs in a sandbox; do not confuse that environment with installed extensions running through the facade.
3. Validate plugin_check and plugin_test using a fake adapter fixture. Current host now initializes Agent + Im for test plugins; assess avoiding unnecessary additions for unrelated plugins.
4. Review delivery ordering: selecting only due queued operations can allow later replies to overtake a rate-limited earlier reply. Preserve per-target order. Splitting long messages currently appends parts behind already queued messages; ensure sequence ordering. Editing split progress/question payloads may create duplicate or stale split operations.
5. Review question lifecycle: actions marked consumed on an IM answer may prevent the next polling pass from removing old buttons (desktop-answer case passes). Late edits while an outbox operation is sending can be lost; final-run status is now also projected from persisted runs, but question cleanup needs the same guarantee. Old actions after restart should never revive live in-memory permissions.
6. Review asynchronous input handling when a desktop run starts during attachment download. Re-check authorization and thread activity, and avoid turning a race into unnecessary failed input. Need recovery and rollback tests with media receipts.
7. Add tests for /new, role/source audit, route revocation mid-flight, callback expiration, input restart durability on disk, Unicode long-message chunks, reconnect, unknown delivery timeout, stale approvals and multi-selection/free-text workflows.
8. Consider bounded retention of inbox/outbox/actions and efficient incremental queries; current polling scans all bindings and histories. Do not claim permanent exactly-once delivery.
9. SDK IM additions require a version capability boundary. Suggested additive bump SDK contract and package 0.2.0 -> 0.2.1; new adapters require ^0.2.1, old ^0.2.0 plugins remain compatible. This has NOT been applied.
10. Localize user-facing IM strings consistently. Current transport statuses and messages mix English and Chinese. Settings arrays render with the existing JSON editor; a friendly connection setup is not yet implemented.
11. Output links, versioned Files export and arbitrary document import still need explicit implementation or accurately bounded documentation. Existing media is the supported subset. No IM human delivery-acceptance entry point added.
12. Review package/API docs and update design status with actual implementation and limitations. Run appropriate complete checks. Keep TOM-94 Doing until its real acceptance is satisfied; coding completion is driven by merge evidence.

## MCP

Local HTTP MCP: http://127.0.0.1:19090/mcp. Use SDK client from packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client.
ProjectId: 014ce729-9739-41b5-a148-8d73f7825928.
TOM-94 itemId: 4d5ebc6f-e8aa-4b8a-b977-51f2791763d7.
Prior design artifact fileId: 25200bd5-c43f-4907-938f-5c7ed297fab6; versionId: 7115f8fe61cb1e4eb460d0b46c92dce177da66f2.
`note_progress` said this external session is not tracked; skip it. Use get_item then update_item with the read baseVersion to append a factual checkpoint, without changing ticket goals or dependencies.
