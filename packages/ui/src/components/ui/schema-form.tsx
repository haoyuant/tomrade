import { useState } from "react";
import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";
import { pickDirectory } from "~/lib/shell";

/** The slice of JSON Schema the renderer draws. Anything else falls back to text. */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  enum?: unknown[];
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

/**
 * One field, drawn from its schema. A container decides commit semantics — the
 * settings dialog commits on change, the project sheet keeps a draft — so this
 * stays a controlled input and nothing more.
 */
export function SchemaField({
  id,
  name,
  schema,
  value,
  onChange,
  disabled
}: {
  id: string;
  name: string;
  schema: JsonSchema;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const inputId = `sf-${id}-${name}`;
  const label = schema.title ?? name;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  const numeric = type === "integer" || type === "number";
  const [picking, setPicking] = useState(false);

  const choose = async () => {
    setPicking(true);
    const chosen = await pickDirectory(t("common.chooseFolderFor", { label }), t("common.chooseButton"));
    setPicking(false);
    if (chosen) onChange(chosen);
  };

  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      {schema.enum ? (
        <select id={inputId} className="input" disabled={disabled} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          {schema.enum.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      ) : type === "boolean" ? (
        <input id={inputId} type="checkbox" disabled={disabled} checked={!!value} onChange={(e) => onChange(e.target.checked)} />
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
          value={value == null ? "" : String(value)}
          onChange={(e) => onChange(numeric ? Number(e.target.value) : e.target.value)}
        />
      )}
      {schema.description && <span className="meta-txt">{schema.description}</span>}
    </div>
  );
}
