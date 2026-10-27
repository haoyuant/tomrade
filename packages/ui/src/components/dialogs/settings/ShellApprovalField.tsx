import { useState } from "react";
import { SchemaField, fieldsOf, type JsonSchema } from "~/components/ui/schema-form";
import { useI18n } from "~/lib/i18n";
import { useSaveSettings, useSettings, useSettingsSections } from "~/lib/queries";
import { readableError } from "~/lib/toast";

/**
 * Settings › Sessions: how the built-in assistant's shell asks before a command — the same setting as Settings › Shell,
 * offered as its two asking choices, with the stored one listed too when it is another. Nothing while the shell is off.
 */
export function ShellApprovalField() {
  const { t, locale } = useI18n();
  const settings = useSettings();
  const sections = useSettingsSections(locale);
  const save = useSaveSettings();
  const [error, setError] = useState<string | null>(null);
  const shell = sections.data?.find((s) => s.id === "shell");
  if (!shell || !settings.data) return null;
  const current = settings.data;
  const stored = (current.shell as { approval?: string } | undefined)?.approval ?? "ask";
  const asking = stored === "ask" || stored === "checks";
  const field = fieldsOf(shell.schema as JsonSchema)?.find(([name]) => name === "approval")?.[1];
  const schema: JsonSchema = {
    type: "string",
    title: t("settingsDialog.shellApprovalTitle"),
    description: t(stored === "ask" ? "settingsDialog.shellApprovalAskNote" : stored === "checks" ? "settingsDialog.shellApprovalChecksNote" : "settingsDialog.shellApprovalOtherNote"),
    enum: asking ? ["ask", "checks"] : ["ask", "checks", stored],
    enumLabels: { ...(asking ? {} : { [stored]: field?.enumLabels?.[stored] ?? stored }), ask: t("settingsDialog.shellApprovalAsk"), checks: t("settingsDialog.shellApprovalChecks") }
  };
  const pick = (next: unknown) => {
    if (next === stored) return;
    save.mutateAsync({ ...current, shell: { ...(current.shell as object | undefined), approval: next } }).then(
      () => setError(null),
      (err: unknown) => setError(t("common.notSaved", { reason: readableError(err) }))
    );
  };
  return <SchemaField id="sessions" name="shellApproval" schema={schema} value={stored} error={error} onChange={() => {}} onCommit={pick} />;
}
