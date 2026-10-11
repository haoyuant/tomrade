import { useEffect, useState, type KeyboardEvent } from "react";
import { Icon } from "~/components/icons";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { pickDirectory } from "~/lib/shell";

/** The slice of JSON Schema the renderer draws. Anything else falls back to text. */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  enum?: unknown[];
  /** Words for the enum's options, from the section's declared words; the raw value otherwise. */
  enumLabels?: Record<string, string>;
  title?: string;
  description?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  default?: unknown;
}

/** Top-level fields of an object schema, in declaration order; null when it is not one. */
export const fieldsOf = (schema: JsonSchema): [string, JsonSchema][] | null =>
  schema.type === "object" && schema.properties ? Object.entries(schema.properties) : null;

/** Defaults as an object, so a form can start from what the provider suggests. */
export function defaultsOf(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of fieldsOf(schema) ?? []) out[name] = field.default ?? (field.type === "boolean" ? false : "");
  return out;
}

/** "claudeCommand" → "Claude command": a field its plugin gave no title still reads as words. */
export function humanize(name: string): string {
  const words = name.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const typeOf = (schema: JsonSchema) => (Array.isArray(schema.type) ? schema.type[0] : schema.type);

/** Why a value would be refused, said before it is sent; null when the schema has nothing against it. */
export function problemOf(schema: JsonSchema, value: unknown, t: (key: MessageKey, vars?: Record<string, string | number>) => string): string | null {
  const type = typeOf(schema);
  if (type !== "integer" && type !== "number") return null;
  if (typeof value !== "number" || Number.isNaN(value)) return t("common.needNumber");
  if (type === "integer" && !Number.isInteger(value)) return t("common.needWholeNumber");
  // zod states an integer's safe range as its bounds; those are not worth saying
  const min = schema.minimum !== undefined && schema.minimum > Number.MIN_SAFE_INTEGER ? schema.minimum : undefined;
  const max = schema.maximum !== undefined && schema.maximum < Number.MAX_SAFE_INTEGER ? schema.maximum : undefined;
  if ((min === undefined || value >= min) && (max === undefined || value <= max)) return null;
  if (min !== undefined && max !== undefined) return t("common.numberBetween", { min, max });
  return min !== undefined ? t("common.numberAtLeast", { min }) : t("common.numberAtMost", { max: max! });
}

/** A list or an object has no input of its own: it is edited as JSON and kept only once it parses. */
function JsonInput({ id, value, disabled, onCommit }: { id: string; value: unknown; disabled?: boolean; onCommit: (value: unknown) => void }) {
  const { t } = useI18n();
  const shown = JSON.stringify(value ?? null, null, 2);
  const [draft, setDraft] = useState(shown);
  const [bad, setBad] = useState(false);
  useEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    try {
      const parsed: unknown = JSON.parse(draft);
      setBad(false);
      if (JSON.stringify(parsed) !== JSON.stringify(value ?? null)) onCommit(parsed);
    } catch {
      setBad(true);
    }
  };
  return (
    <>
      <textarea id={id} className="input num" rows={Math.min(8, shown.split("\n").length)} disabled={disabled} aria-invalid={bad} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />
      {bad && <span className="field-error" role="alert">{t("common.notJson")}</span>}
    </>
  );
}

/**
 * One field, drawn from its schema. A container decides commit semantics — the
 * settings dialog saves on `onCommit` (leaving a typed field, or any pick), the
 * project sheet keeps a draft from `onChange` — so this stays a controlled input.
 */
export function SchemaField({
  id,
  name,
  schema,
  value,
  onChange,
  onCommit,
  error,
  disabled
}: {
  id: string;
  name: string;
  schema: JsonSchema;
  value: unknown;
  onChange: (value: unknown) => void;
  /** The value is final: a typed field was left or Enter pressed, or an option was picked. */
  onCommit?: (value: unknown) => void;
  /** Why the value was not saved, shown under the field until it changes. */
  error?: string | null;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const inputId = `sf-${id}-${name}`;
  const errorId = `${inputId}-error`;
  const label = schema.title ?? humanize(name);
  const type = typeOf(schema);
  const numeric = type === "integer" || type === "number";
  const [picking, setPicking] = useState(false);
  const pick = (next: unknown) => {
    onChange(next);
    onCommit?.(next);
  };
  const typed = {
    "aria-invalid": !!error,
    "aria-describedby": error ? errorId : undefined,
    onBlur: () => onCommit?.(value),
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") onCommit?.(value);
    }
  };

  const choose = async () => {
    setPicking(true);
    const chosen = await pickDirectory(t("common.chooseFolderFor", { label }), t("common.chooseButton"));
    setPicking(false);
    if (chosen) pick(chosen);
  };

  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      {schema.enum ? (
        <select id={inputId} className="input" disabled={disabled} value={String(value ?? "")} onChange={(e) => pick(e.target.value)}>
          {schema.enum.map((option) => (
            <option key={String(option)} value={String(option)}>
              {schema.enumLabels?.[String(option)] ?? String(option)}
            </option>
          ))}
        </select>
      ) : type === "boolean" ? (
        <input id={inputId} type="checkbox" disabled={disabled} checked={!!value} onChange={(e) => pick(e.target.checked)} />
      ) : type === "array" || type === "object" ? (
        <JsonInput id={inputId} value={value} disabled={disabled} onCommit={pick} />
      ) : schema.format === "directory" ? (
        <div className="row" style={{ gap: "var(--space-2)" }}>
          <input
            id={inputId}
            className="input num"
            style={{ flex: 1 }}
            disabled={disabled}
            placeholder="/path/to/folder"
            value={value == null ? "" : String(value)}
            onChange={(e) => onChange(e.target.value)}
            {...typed}
          />
          {/* A path is chosen, not typed character by character — every keystroke
              would otherwise be a different destination. */}
          <button type="button" className="btn btn-secondary" disabled={disabled || picking} onClick={() => void choose()}>
            <Icon name="i-search" size={13} />
            {picking ? t("common.choosing") : t("common.choose")}
          </button>
        </div>
      ) : (
        <input
          id={inputId}
          className={numeric || schema.format === "password" ? "input num" : "input"}
          type={numeric ? "number" : schema.format === "password" ? "password" : "text"}
          disabled={disabled}
          min={schema.minimum}
          max={schema.maximum}
          step={type === "integer" ? 1 : undefined}
          value={value == null || (typeof value === "number" && Number.isNaN(value)) ? "" : String(value)}
          // an emptied number field is no number, not zero
          onChange={(e) => onChange(numeric ? (e.target.value === "" ? undefined : Number(e.target.value)) : e.target.value)}
          {...typed}
        />
      )}
      {error && (
        <span id={errorId} className="field-error" role="alert">
          {error}
        </span>
      )}
      {schema.description && <span className="meta-txt">{schema.description}</span>}
    </div>
  );
}
