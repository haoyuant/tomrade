/** Core domain types. Data shapes are sync-friendly: UUID ids, version, updated_by, timestamps. */
export type ItemKind = "ticket" | "epic";

export type ItemStatus = "backlog" | "todo" | "doing" | "verifying" | "done" | "cancelled";

/** Who wrote this change. Human edits are 'human'; AI writes are 'ai:<source>' (e.g. 'ai:mcp', 'ai:extraction'). */
export type Author = "human" | `ai:${string}`;

export interface Item {
  id: string;
  projectId: string;
  title: string;
  body: string | null;
  kind: ItemKind;
  status: ItemStatus;
  parentId: string | null;
  /** Float sort key for manual ordering (sync-friendly: no integer positions). */
  rank: number;
  updatedAt: number;
  updatedBy: Author;
  version: number;
  /** When set, AI writes may not touch title/body of this item. */
  humanLocked: boolean;
}

/** Fields an AI writer may propose. */
export type Patch = Partial<Pick<Item, "title" | "body" | "kind" | "status" | "parentId" | "rank">>;

export type OplogOp = "create" | "update" | "delete";

export interface OplogEntry {
  seq: number;
  entity: "item";
  entityId: string;
  op: OplogOp;
  baseVersion: number | null;
  before: unknown | null;
  after: unknown | null;
  by: Author;
  at: number;
}

export interface CreateItemInput {
  projectId?: string;
  title: string;
  body?: string | null;
  kind?: ItemKind;
  status?: ItemStatus;
  parentId?: string | null;
  rank?: number;
  by: Author;
}

export interface ListItemsFilter {
  projectId?: string;
  status?: ItemStatus;
  kind?: ItemKind;
  parentId?: string | null;
}
