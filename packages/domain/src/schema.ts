import { z } from "zod";

export const itemKindSchema = z.enum(["ticket", "epic"]);
export const workTypeSchema = z.enum(["coding", "general"]);
export const itemStatusSchema = z.enum(["backlog", "todo", "doing", "verifying", "done", "cancelled"]);
export const prioritySchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

export const listItemsFilterSchema = z.object({
  projectId: z.string().optional(),
  boardId: z.string().optional(),
  status: itemStatusSchema.optional(),
  kind: itemKindSchema.optional(),
  workType: workTypeSchema.optional(),
  priority: prioritySchema.optional(),
  label: z.string().optional(),
  parentId: z.string().nullable().optional()
});

export const fieldValueSchema = z.union([z.string(), z.number()]);

/** A key set to null clears the value. */
export const fieldsPatchSchema = z.record(z.string(), fieldValueSchema.nullable());

export const filterClauseSchema = z.object({
  field: z.string(),
  op: z.enum(["in", "not-in", "contains", "gte", "lte"]),
  values: z.array(fieldValueSchema.nullable())
});

export const sortKeySchema = z.object({ field: z.string(), dir: z.enum(["asc", "desc"]) });

export const createItemSchema = z.object({
  playbookId: z.string().min(1).nullable().optional(),
  title: z.string().min(1),
  body: z.string().nullable().optional(),
  kind: itemKindSchema.optional(),
  workType: workTypeSchema.optional(),
  status: itemStatusSchema.optional(),
  priority: prioritySchema.optional(),
  labels: z.array(z.string()).optional(),
  parentId: z.string().nullable().optional(),
  projectId: z.string().optional(),
  boardId: z.string().optional(),
  fields: fieldsPatchSchema.optional()
});

export const patchSchema = z.object({
  playbookId: z.string().min(1).nullable().optional(),
  title: z.string().optional(),
  body: z.string().nullable().optional(),
  kind: itemKindSchema.optional(),
  workType: workTypeSchema.optional(),
  status: itemStatusSchema.optional(),
  priority: prioritySchema.optional(),
  labels: z.array(z.string()).optional(),
  blocks: z.array(z.string()).optional(),
  parentId: z.string().nullable().optional(),
  rank: z.number().optional(),
  fields: fieldsPatchSchema.optional()
});
