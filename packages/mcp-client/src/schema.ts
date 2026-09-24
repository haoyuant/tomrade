import { z } from "zod";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Draft-07 habits zod does not read: `definitions` refs, and objects that only imply their type. */
function normalize(json: unknown): unknown {
  if (!isRecord(json)) return { type: "object" };
  let text = JSON.stringify(json);
  if (isRecord(json.definitions) && json.$defs === undefined) {
    text = text.replaceAll('"#/definitions/', '"#/$defs/');
  }
  const out = JSON.parse(text) as Record<string, unknown>;
  if (isRecord(out.definitions) && out.$defs === undefined) {
    out.$defs = out.definitions;
    delete out.definitions;
  }
  if (out.type === undefined && (isRecord(out.properties) || out.properties === undefined)) out.type = "object";
  return out;
}

/**
 * A remote tool's JSON Schema as the zod object the registry takes. When the
 * schema cannot be read exactly the tool still registers, loose, and `exact`
 * says so — the caller then hands the model the original schema as text.
 */
export function inputSchemaOf(json: unknown): { schema: z.ZodObject; exact: boolean } {
  try {
    const converted = z.fromJSONSchema(normalize(json) as Parameters<typeof z.fromJSONSchema>[0]);
    if (converted instanceof z.ZodObject) return { schema: converted, exact: true };
  } catch {
    // falls through to the loose schema
  }
  return { schema: z.looseObject({}), exact: false };
}
