import type { Context } from "cordis";
import { z } from "zod";
import type { FieldDef, FieldOption } from "@tomrade/domain";
import { defineTool } from "@tomrade/tools";
import type {} from "@tomrade/ipc";
import type { CreateFieldInput, FieldOptionInput, FieldOptionPatch, FieldPatch } from "./service.js";

declare module "@tomrade/ipc" {
  interface Channels {
    "fields.list": (projectId: string) => FieldDef[];
    "fields.create": (input: CreateFieldInput) => FieldDef;
    "fields.update": (id: string, patch: FieldPatch) => FieldDef;
    "fields.remove": (id: string) => void;
    "fields.addOption": (fieldId: string, input: FieldOptionInput) => FieldOption;
    "fields.updateOption": (fieldId: string, optionId: string, patch: FieldOptionPatch) => FieldOption;
    "fields.removeOption": (fieldId: string, optionId: string, moveTo?: string) => number;
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
      execute: ({ projectId }, inv) => ctx.fields.list(projectId ?? inv.projectId ?? "default")
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
      execute: ({ projectId, ...rest }, inv) => ctx.fields.create({ ...rest, projectId: projectId ?? inv.projectId ?? "default" })
    })
  );
}

export function registerChannels(ctx: Context): void {
  ctx.ipc.handle("fields.list", (projectId) => ctx.fields.list(projectId));
  ctx.ipc.handle("fields.create", (input) => ctx.fields.create(input));
  ctx.ipc.handle("fields.update", (id, patch) => ctx.fields.update(id, patch));
  ctx.ipc.handle("fields.remove", (id) => ctx.fields.remove(id));
  ctx.ipc.handle("fields.addOption", (fieldId, input) => ctx.fields.addOption(fieldId, input));
  ctx.ipc.handle("fields.updateOption", (fieldId, optionId, patch) => ctx.fields.updateOption(fieldId, optionId, patch));
  ctx.ipc.handle("fields.removeOption", (fieldId, optionId, moveTo) => ctx.fields.removeOption(fieldId, optionId, { moveTo }));
}
