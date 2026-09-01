import { z } from "zod";

export const itemKindSchema = z.enum(["ticket", "epic"]);
export const itemStatusSchema = z.enum(["backlog", "todo", "doing", "verifying", "done", "cancelled"]);
export const prioritySchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

export const listItemsFilterSchema = z.object({
  projectId: z.string().optional(),
  boardId: z.string().optional(),
  status: itemStatusSchema.optional(),
  kind: itemKindSchema.optional(),
  priority: prioritySchema.optional(),
  label: z.string().optional(),
  parentId: z.string().nullable().optional()
});

export const createItemSchema = z.object({
  title: z.string().min(1),
  body: z.string().nullable().optional(),
  kind: itemKindSchema.optional(),
  status: itemStatusSchema.optional(),
  priority: prioritySchema.optional(),
  labels: z.array(z.string()).optional(),
  parentId: z.string().nullable().optional(),
  projectId: z.string().optional(),
  boardId: z.string().optional()
});

export const patchSchema = z.object({
  title: z.string().optional(),
  body: z.string().nullable().optional(),
  kind: itemKindSchema.optional(),
  status: itemStatusSchema.optional(),
  priority: prioritySchema.optional(),
  labels: z.array(z.string()).optional(),
  blocks: z.array(z.string()).optional(),
  parentId: z.string().nullable().optional(),
  rank: z.number().optional()
});
