import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateFieldInput, FieldOptionInput, FieldOptionPatch, FieldPatch } from "@tomradex/fields";
import { invoke } from "../api";
import { keys } from "./keys";

export const useFields = (projectId: string) => useQuery({ queryKey: keys.fields(projectId), queryFn: () => invoke("fields.list", projectId) });

/* ── the field registry ─────────────────────────────────────────────────
   Definitions are schema: every change lands live and refetches the items,
   because removing a field or an option takes values with it. */

function useFieldMutation<A, R>(projectId: string, fn: (args: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.fields(projectId) });
      void qc.invalidateQueries({ queryKey: keys.items(projectId) });
    }
  });
}

export const useCreateField = (projectId: string) =>
  useFieldMutation(projectId, (input: Omit<CreateFieldInput, "projectId">) => invoke("fields.create", { ...input, projectId }));
export const useUpdateField = (projectId: string) => useFieldMutation(projectId, (args: { id: string; patch: FieldPatch }) => invoke("fields.update", projectId, args.id, args.patch));
export const useRemoveField = (projectId: string) => useFieldMutation(projectId, (id: string) => invoke("fields.remove", projectId, id));
export const useAddFieldOption = (projectId: string) =>
  useFieldMutation(projectId, (args: { fieldId: string; input: FieldOptionInput }) => invoke("fields.addOption", projectId, args.fieldId, args.input));
export const useUpdateFieldOption = (projectId: string) =>
  useFieldMutation(projectId, (args: { fieldId: string; optionId: string; patch: FieldOptionPatch }) => invoke("fields.updateOption", projectId, args.fieldId, args.optionId, args.patch));
export const useRemoveFieldOption = (projectId: string) =>
  useFieldMutation(projectId, (args: { fieldId: string; optionId: string; moveTo?: string }) => invoke("fields.removeOption", projectId, args.fieldId, args.optionId, args.moveTo));
