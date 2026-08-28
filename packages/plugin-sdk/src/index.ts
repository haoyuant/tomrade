import type { Plugin } from "cordis";

export { Context, Service } from "cordis";
export type { Fiber, Plugin } from "cordis";

export * from "@tomrade/domain";
export { defineTool, ToolInputError, UnknownToolError } from "@tomrade/tools";
export type { Tools, ToolCall, ToolDefinition, ToolDescriptor, ToolInvocation, ToolOutcome } from "@tomrade/tools";
export { write } from "@tomrade/write";
export type { WriteIntent } from "@tomrade/write";
export type { Db, Migration, Sqlite } from "@tomrade/db";
export type { Oplog, OplogAppend } from "@tomrade/oplog";
export type { Items } from "@tomrade/items";
export type { Boards, Views } from "@tomrade/boards";
export type { Projects } from "@tomrade/projects";
export type { Settings, SettingsSection, SettingsSectionView } from "@tomrade/settings";
export type { ProjectState, Storage, StorageHandle, StorageProvider, StorageProviderView, StorageStatus, SyncState } from "@tomrade/storage";
export type { LLMProvider, CompletionRequest } from "@tomrade/llm";
export type { Assistant, AiChatResult } from "@tomrade/assistant";
export type { Mcp } from "@tomrade/mcp";
export type { Contributions, Command, CommandResult, CommandScope, Badge, BadgeProvider, BadgeTone, StatusItem, Section, SectionRow } from "@tomrade/contributions";
export type { Ipc, Channels, Broadcasts, ChannelHandler, Invoke } from "@tomrade/ipc";

/** Identity with types: an object plugin with `name`, optional `inject`/`Config`, and `apply(ctx, config)`. */
export const definePlugin = <T = undefined>(plugin: Plugin.Object<T>): Plugin.Object<T> => plugin;
