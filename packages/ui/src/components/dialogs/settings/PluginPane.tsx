import { Fragment, useState, type ReactNode } from "react";
import type { SettingsSectionView } from "@tomradex/settings";
import { BuiltinTerminalNote, HerdrRecommendation } from "~/components/setup/HerdrRecommend";
import { Fold, SectionHead } from "~/components/ui/atoms";
import { SchemaField, fieldsOf, problemOf, type JsonSchema } from "~/components/ui/schema-form";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { isWindows } from "~/lib/keys";
import { readableError } from "~/lib/toast";
import { PetProfilesPanel } from "../PetProfilesPanel";
import { PushStatus } from "./PushStatus";
import { ScopeTag } from "./ScopeTag";
import { ShellApprovalField } from "./ShellApprovalField";

/**
 * A plugin's settings pane. A typed field saves when it is left, a pick at
 * once. A value that would be refused stays as typed, with the reason under
 * it, instead of springing back to what was stored. Fields the section marks
 * advanced wait behind one line until asked for.
 */
export function PluginPane({ section, stored, onSave, children }: { section: SettingsSectionView; stored: unknown; onSave: (next: unknown) => Promise<unknown>; children?: ReactNode }) {
  const { t } = useI18n();
  const [value, setValue] = useState<unknown>(stored);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // A field still being put right keeps what was typed; otherwise the pane follows the stored value.
  const unsettled = Object.keys(problems).length > 0;
  const [seen, setSeen] = useState(stored);
  if (!Object.is(seen, stored)) {
    setSeen(stored);
    if (!unsettled) setValue(stored);
  }
  const schema = section.schema as JsonSchema;
  const fields = fieldsOf(schema);
  const basic = fields?.filter(([, field]) => !field.advanced) ?? [];
  const advanced = fields?.filter(([, field]) => field.advanced) ?? [];
  const record = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const setProblem = (key: string, problem: string | null) =>
    setProblems((all) => {
      const { [key]: _, ...rest } = all;
      return problem ? { ...rest, [key]: problem } : rest;
    });

  const change = (name: string | null, next: unknown) => {
    setValue((current: unknown) => (name === null ? next : { ...record(current), [name]: next }));
    setProblem(name ?? "", null);
  };
  const commit = (name: string | null, field: JsonSchema, next: unknown) => {
    const key = name ?? "";
    const problem = problemOf(field, next, t);
    if (problem) return setProblem(key, problem);
    // other fields still wrong go out as stored, so one bad field cannot sink another's save
    const others = Object.fromEntries(Object.keys(problems).filter((k) => k !== key && k !== "").map((k) => [k, record(stored)[k]]));
    const payload = name === null ? next : { ...record(value), ...others, [name]: next };
    if (JSON.stringify(payload) === JSON.stringify(stored)) return setProblem(key, null);
    onSave(payload).then(
      () => setProblem(key, null),
      (err: unknown) => setProblem(key, t("common.notSaved", { reason: readableError(err) }))
    );
  };
  const draw = ([name, field]: [string, JsonSchema]) => {
    const extra = FIELD_EXTRAS[`${section.id}.${name}`];
    const labels = extra?.options && Object.fromEntries(Object.entries(extra.options).map(([option, key]) => [option, t(key)]));
    return (
      <Fragment key={name}>
        <SchemaField
          id={section.id}
          name={name}
          schema={labels ? { ...field, enumLabels: { ...field.enumLabels, ...labels } } : field}
          value={record(value)[name]}
          error={problems[name]}
          onChange={(v) => change(name, v)}
          onCommit={(v) => commit(name, field, v)}
        />
        {extra?.below?.()}
      </Fragment>
    );
  };
  return (
    <>
      <SectionHead title={section.title} aside={<ScopeTag scope={section.scope} />}>
        {section.description}
      </SectionHead>
      {fields ? (
        <>
          {basic.length > 0 && <div className="panel stack-3">{basic.map(draw)}</div>}
          {advanced.length > 0 && (
            <Fold id={`${section.id}-advanced`} title={t("common.advanced")} open={advancedOpen} onToggle={() => setAdvancedOpen((o) => !o)}>
              <div className="panel stack-3">{advanced.map(draw)}</div>
            </Fold>
          )}
        </>
      ) : (
        <div className="panel stack-3">
          <SchemaField id={section.id} name={section.id} schema={schema} value={value} error={problems[""]} onChange={(v) => change(null, v)} onCommit={(v) => commit(null, schema, v)} />
        </div>
      )}
      {children}
    </>
  );
}

/** What one plugin field shows beyond its schema: words for some of its options, and a line under it. */
const FIELD_EXTRAS: Record<string, { options?: Record<string, MessageKey>; below?: () => ReactNode }> = {
  // On Windows the choice is Tomrade's own terminal; herdr does not run there.
  "codeLink.terminal": { options: { herdr: "codeLink.herdrOption", builtin: "codeLink.builtinOption" }, below: () => (isWindows ? <BuiltinTerminalNote /> : <HerdrRecommendation />) },
  // The shell's own setting, offered where sessions are set too.
  "sessions.afterAnswer": { below: () => <ShellApprovalField /> }
};

import { AnalyticsIdentity } from "./AnalyticsIdentity";

/** What a plugin's pane shows beyond its schema, for the plugins whose settings are more than fields. */
export const PANE_EXTRAS: Record<string, () => ReactNode> = {
  pet: () => <PetProfilesPanel />,
  notifications: () => <PushStatus />,
  analytics: () => <AnalyticsIdentity />
};
