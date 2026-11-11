import { useEffect, useId, useRef, useState } from "react";
import type { EngineView } from "@tomradex/agent";
import type { Item } from "@tomradex/domain";
import type { WorkRule } from "@tomradex/night-shift";
import { Icon } from "~/components/icons";
import { Fold } from "~/components/ui/atoms";
import { Field } from "~/components/dialogs/plugins/parts";
import { permissionLabel } from "~/lib/codeLink";
import { PRIORITIES, PRIORITY_LABEL } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { nodeConfig, useSetWorkRules, type NodeOverride } from "~/lib/nightShift";
import { errorSpec, useToast } from "~/lib/toast";

/** "" is "leave it to what comes next". */
const without = <T extends object, K extends keyof T>(from: T, key: K, value: T[K] | undefined): T => {
  const { [key]: _old, ...rest } = from;
  return (value === undefined ? rest : { ...rest, [key]: value }) as T;
};

function WhereSelect({ id, value, onChange }: { id: string; value: "terminal" | "run" | undefined; onChange: (next: "terminal" | "run" | undefined) => void }) {
  const { t } = useI18n();
  return (
    <select id={id} className="select" value={value ?? ""} onChange={(event) => onChange((event.target.value || undefined) as "terminal" | "run" | undefined)}>
      <option value="">{t("nightShift.asRun")}</option>
      <option value="terminal">{t("nightShift.whereTerminal")}</option>
      <option value="run">{t("nightShift.whereSession")}</option>
    </select>
  );
}

function EngineSelect({ id, value, engines, onChange }: { id: string; value: string | undefined; engines: EngineView[]; onChange: (next: string | undefined) => void }) {
  const { t } = useI18n();
  return (
    <select id={id} className="select" value={value ?? ""} onChange={(event) => onChange(event.target.value || undefined)}>
      <option value="">{t("nightShift.asRun")}</option>
      {value && !engines.some((e) => e.id === value) && <option value={value}>{value}</option>}
      {engines.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
    </select>
  );
}

function MergeSelect({ id, value, onChange }: { id: string; value: boolean | undefined; onChange: (next: boolean | undefined) => void }) {
  const { t } = useI18n();
  return (
    <select id={id} className="select" value={value === undefined ? "" : value ? "yes" : "no"} onChange={(event) => onChange(event.target.value ? event.target.value === "yes" : undefined)}>
      <option value="">{t("nightShift.asRun")}</option>
      <option value="yes">{t("nightShift.mergeYes")}</option>
      <option value="no">{t("nightShift.mergeNo")}</option>
    </select>
  );
}

/** One node's own settings. What the person leaves alone goes as a rule or the run says, and it shows which. */
export function NodeConfigPanel({ item, rule, override, engines, allEngines, onChange, onClose }: { item: Item; rule: WorkRule | undefined; override: NodeOverride | undefined; engines: EngineView[]; allEngines: EngineView[]; onChange: (next: NodeOverride | null) => void; onClose: () => void }) {
  const { t } = useI18n();
  const id = useId();
  const own = override ?? {};
  const { config, from } = nodeConfig(override, rule);
  const engine = allEngines.find((e) => e.id === config.engine);
  const permissions = config.mode !== "terminal" ? engine?.permissionModes : undefined;
  // it opens below the graph, which can leave it under the fold of the dialog
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.scrollIntoView({ block: "nearest" });
  }, [item.id]);
  return (
    <section ref={panel} className="plan-config" data-testid="plan-config" aria-label={t("nightShift.configure", { key: item.key })}>
      <div className="plan-config-head">
        <span className="cfg-name"><span className="num">{item.key}</span> {item.title}</span>
        <span className="meta-txt" data-testid="plan-config-from">{from === "manual" ? t("nightShift.fromManual") : from === "rule" ? t("nightShift.fromRule", { name: rule!.name }) : t("nightShift.fromRun")}</span>
        <button type="button" className="btn btn-icon" aria-label={t("common.close")} title={t("common.close")} onClick={onClose}><Icon name="i-close" size={13} /></button>
      </div>
      <div className="plan-config-grid">
        <Field label={t("nightShift.where")} htmlFor={`${id}-where`}>
          <WhereSelect id={`${id}-where`} value={own.mode} onChange={(mode) => onChange(without(own, "mode", mode))} />
        </Field>
        <Field label={t("nightShift.agent")} htmlFor={`${id}-engine`}>
          <EngineSelect id={`${id}-engine`} value={own.engine} engines={engines} onChange={(next) => { const { permissionMode: _old, ...rest } = own; onChange(without(rest, "engine", next)); }} />
        </Field>
        {permissions && (
          <Field label={t("nightShift.permissions")} htmlFor={`${id}-permission`}>
            <select id={`${id}-permission`} className="select" value={own.permissionMode ?? ""} onChange={(event) => onChange(without(own, "permissionMode", event.target.value || undefined))}>
              <option value="">{t("nightShift.asRun")}</option>
              {permissions.choices.map((choice) => <option key={choice.value} value={choice.value}>{permissionLabel(t, choice)}</option>)}
            </select>
          </Field>
        )}
        <Field label={t("nightShift.merge")} htmlFor={`${id}-merge`}>
          <MergeSelect id={`${id}-merge`} value={own.autoMerge} onChange={(next) => onChange(without(own, "autoMerge", next))} />
        </Field>
        <Field label={t("nightShift.whenLimited")} htmlFor={`${id}-limited`}>
          <select id={`${id}-limited`} className="select" data-testid="plan-config-when-limited" value={own.whenLimited ?? ""} onChange={(event) => onChange(without(own, "whenLimited", (event.target.value || undefined) as "switch" | "wait" | undefined))}>
            <option value="">{t("nightShift.asRun")}</option>
            <option value="switch">{t("nightShift.whenLimitedSwitch")}</option>
            <option value="wait">{t("nightShift.whenLimitedWait")}</option>
          </select>
        </Field>
      </div>
      {override && <button type="button" className="tlink" data-testid="plan-config-reset" onClick={() => onChange(null)}>{t("nightShift.resetNode")}</button>}
    </section>
  );
}

const hasCondition = (rule: WorkRule) => !!rule.when.label?.trim() || !!rule.when.titleHas?.trim() || rule.when.workType !== undefined || rule.when.minPriority !== undefined;

function RuleEditor({ rule, index, count, engines, onChange, onDelete, onMove }: { rule: WorkRule; index: number; count: number; engines: EngineView[]; onChange: (next: WorkRule) => void; onDelete: () => void; onMove: (by: -1 | 1) => void }) {
  const { t } = useI18n();
  const id = useId();
  const when = (next: WorkRule["when"]) => onChange({ ...rule, when: next });
  const then = (next: WorkRule["then"]) => onChange({ ...rule, then: next });
  const [name, setName] = useState(rule.name);
  return (
    <div className="plan-rule" data-testid="plan-rule">
      <div className="plan-rule-head">
        <input className="input" aria-label={t("nightShift.ruleName")} data-testid="plan-rule-name" value={name} onChange={(event) => setName(event.target.value)} onBlur={() => name.trim() && name !== rule.name && onChange({ ...rule, name: name.trim() })} />
        <button type="button" className="btn btn-icon" disabled={index === 0} aria-label={t("nightShift.ruleUp", { name: rule.name })} title={t("nightShift.ruleUp", { name: rule.name })} data-testid="plan-rule-up" onClick={() => onMove(-1)}><Icon name="i-chev" size={13} style={{ transform: "rotate(-90deg)" }} /></button>
        <button type="button" className="btn btn-icon" disabled={index === count - 1} aria-label={t("nightShift.ruleDown", { name: rule.name })} title={t("nightShift.ruleDown", { name: rule.name })} onClick={() => onMove(1)}><Icon name="i-chev" size={13} style={{ transform: "rotate(90deg)" }} /></button>
        <button type="button" className="btn btn-icon" aria-label={t("nightShift.ruleDelete", { name: rule.name })} title={t("nightShift.ruleDelete", { name: rule.name })} data-testid="plan-rule-delete" onClick={onDelete}><Icon name="i-trash" size={13} /></button>
      </div>
      <div className="plan-config-grid">
        <Field label={t("nightShift.whenLabel")} htmlFor={`${id}-label`}>
          <input id={`${id}-label`} className="input" data-testid="plan-rule-label" defaultValue={rule.when.label ?? ""} onBlur={(event) => event.target.value !== (rule.when.label ?? "") && when(without(rule.when, "label", event.target.value.trim() || undefined))} />
        </Field>
        <Field label={t("nightShift.whenTitle")} htmlFor={`${id}-title`}>
          <input id={`${id}-title`} className="input" defaultValue={rule.when.titleHas ?? ""} onBlur={(event) => event.target.value !== (rule.when.titleHas ?? "") && when(without(rule.when, "titleHas", event.target.value.trim() || undefined))} />
        </Field>
        <Field label={t("nightShift.whenType")} htmlFor={`${id}-type`}>
          <select id={`${id}-type`} className="select" value={rule.when.workType ?? ""} onChange={(event) => when(without(rule.when, "workType", (event.target.value || undefined) as WorkRule["when"]["workType"]))}>
            <option value="">{t("nightShift.anyValue")}</option>
            <option value="coding">{t("nightShift.typeCoding")}</option>
            <option value="general">{t("nightShift.typeGeneral")}</option>
          </select>
        </Field>
        <Field label={t("nightShift.whenPriority")} htmlFor={`${id}-priority`}>
          <select id={`${id}-priority`} className="select" value={rule.when.minPriority ?? ""} onChange={(event) => when(without(rule.when, "minPriority", event.target.value ? Number(event.target.value) : undefined))}>
            <option value="">{t("nightShift.anyValue")}</option>
            {PRIORITIES.filter((p) => p > 0).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </select>
        </Field>
      </div>
      {!hasCondition(rule) && <p className="meta-txt" data-testid="plan-rule-empty">{t("nightShift.ruleEmpty")}</p>}
      <label className="cfg-row" style={{ cursor: "pointer" }}>
        <input type="checkbox" data-testid="plan-rule-skip" checked={!!rule.then.skip} onChange={(event) => then(without(rule.then, "skip", event.target.checked || undefined))} />
        <span className="cfg-name">{t("nightShift.thenSkip")}</span>
      </label>
      {!rule.then.skip && (
        <div className="plan-config-grid">
          <Field label={t("nightShift.where")} htmlFor={`${id}-where`}>
            <WhereSelect id={`${id}-where`} value={rule.then.mode} onChange={(mode) => then(without(rule.then, "mode", mode))} />
          </Field>
          <Field label={t("nightShift.agent")} htmlFor={`${id}-engine`}>
            <EngineSelect id={`${id}-engine`} value={rule.then.engine} engines={engines} onChange={(engine) => then(without(rule.then, "engine", engine))} />
          </Field>
          <Field label={t("nightShift.merge")} htmlFor={`${id}-merge`}>
            <MergeSelect id={`${id}-merge`} value={rule.then.autoMerge} onChange={(merge) => then(without(rule.then, "autoMerge", merge))} />
          </Field>
        </div>
      )}
      <Field label={t("nightShift.thenNotOn")} htmlFor={`${id}-not-on`}>
        <input
          id={`${id}-not-on`}
          className="input"
          data-testid="plan-rule-not-on"
          placeholder={t("nightShift.thenNotOnHint")}
          defaultValue={(rule.then.notOn ?? []).join(", ")}
          onBlur={(event) => {
            const names = event.target.value.split(/[,，]/).map((name) => name.trim()).filter(Boolean).slice(0, 20);
            if (names.join("|") !== (rule.then.notOn ?? []).join("|")) then(without(rule.then, "notOn", names.length ? names : undefined));
          }}
        />
      </Field>
    </div>
  );
}

/** The project's standing rules, kept by the project and saved as they change. */
export function WorkRulesPanel({ projectId, rules, engines }: { projectId: string; rules: WorkRule[]; engines: EngineView[] }) {
  const { t } = useI18n();
  const toast = useToast();
  const save = useSetWorkRules(projectId);
  const [open, setOpen] = useState(false);
  const write = (next: WorkRule[]) => save.mutate(next, { onError: (err) => toast(errorSpec(err)) });
  const move = (at: number, by: -1 | 1) => {
    const next = [...rules];
    [next[at], next[at + by]] = [next[at + by]!, next[at]!];
    write(next);
  };
  return (
    <Fold id="plan-rules" title={rules.length ? t("nightShift.rulesCount", { n: rules.length }) : t("nightShift.rules")} open={open} onToggle={() => setOpen((o) => !o)}>
      <div className="plan-rules" data-testid="plan-rules">
        <p className="meta-txt">{t("nightShift.rulesHint")}</p>
        {rules.map((rule, index) => (
          <RuleEditor key={rule.id} rule={rule} index={index} count={rules.length} engines={engines} onChange={(next) => write(rules.map((r) => (r.id === rule.id ? next : r)))} onDelete={() => write(rules.filter((r) => r.id !== rule.id))} onMove={(by) => move(index, by)} />
        ))}
        <button type="button" className="btn btn-secondary" data-testid="plan-rule-add" style={{ alignSelf: "flex-start" }} onClick={() => write([...rules, { id: crypto.randomUUID(), name: t("nightShift.ruleNew", { n: rules.length + 1 }), when: {}, then: {} }])}>
          <Icon name="i-plus" size={13} /> {t("nightShift.ruleAdd")}
        </button>
      </div>
    </Fold>
  );
}
