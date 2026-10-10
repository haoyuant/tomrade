import type { Context } from "cordis";
import { z } from "zod";
import type { FieldDef, FieldOption } from "@tomradex/domain";
import { defineTool, requireProjectId } from "@tomradex/tools";
import type {} from "@tomradex/ipc";
import type { CreateFieldInput, FieldOptionInput, FieldOptionPatch, FieldPatch } from "./service.js";

declare module "@tomradex/ipc" {
  interface Channels {
    "fields.list": (projectId: string) => FieldDef[];
    "fields.create": (input: CreateFieldInput) => FieldDef;
    "fields.update": (projectId: string, id: string, patch: FieldPatch) => FieldDef;
    "fields.remove": (projectId: string, id: string) => void;
    "fields.addOption": (projectId: string, fieldId: string, input: FieldOptionInput) => FieldOption;
    "fields.updateOption": (projectId: string, fieldId: string, optionId: string, patch: FieldOptionPatch) => FieldOption;
    "fields.removeOption": (projectId: string, fieldId: string, optionId: string, moveTo?: string) => number;
  }
}

const optionInput = z.object({ name: z.string().min(1), description: z.string().nullable().optional() });

/** Definitions are read by every agent; creating one is deliberate, so it is its own tool rather than a side effect of a write. */
export function registerTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: "list_fields",
      title: "List fields",
      description:
        "List the fields items in a project can carry: built-in (status, priority, epic, labels, workstream…) and custom. Custom values are written through update_item's `fields` map, keyed by field id; a select takes an option id.",
      input: z.object({ projectId: z.string().optional() }),
      execute: ({ projectId }, inv) => ctx.fields.list(requireProjectId("list_fields", projectId, inv))
    })
  );

  ctx.tools.register(
    defineTool({
      name: "create_field",
      title: "Create a custom field",
      description: "Add a text, number, date or select field to a project. A select needs its options; more can be added later.",
      input: z.object({
        projectId: z.string().optional(),
        name: z.string().min(1),
        type: z.enum(["text", "number", "date", "select"]),
        options: z.array(optionInput).optional()
      }),
      execute: ({ projectId, ...rest }, inv) => ctx.fields.create({ ...rest, projectId: requireProjectId("create_field", projectId, inv) })
    })
  );
}

export function registerChannels(ctx: Context): void {
  ctx.ipc.handle("fields.list", (projectId) => ctx.fields.list(projectId));
  ctx.ipc.handle("fields.create", (input) => ctx.fields.create(input));
  ctx.ipc.handle("fields.update", (projectId, id, patch) => ctx.fields.update(projectId, id, patch));
  ctx.ipc.handle("fields.remove", (projectId, id) => ctx.fields.remove(projectId, id));
  ctx.ipc.handle("fields.addOption", (projectId, fieldId, input) => ctx.fields.addOption(projectId, fieldId, input));
  ctx.ipc.handle("fields.updateOption", (projectId, fieldId, optionId, patch) => ctx.fields.updateOption(projectId, fieldId, optionId, patch));
  ctx.ipc.handle("fields.removeOption", (projectId, fieldId, optionId, moveTo) => ctx.fields.removeOption(projectId, fieldId, optionId, { moveTo }));
}
