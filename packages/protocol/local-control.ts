import schemas from "./local-control-schema.json";
export type LocalControlMethod = keyof typeof schemas;
export const localControlMethods = Object.keys(schemas) as LocalControlMethod[];
export type LocalControlParams = Record<string, unknown>;
export type LocalControlResponse =
  | { id?: string; ok: true; result: unknown }
  | {
      id?: string;
      ok: false;
      error: { code: string; message: string; outcomeUnknown?: true };
    };
export type LocalControlHandlers = Partial<
  Record<
    LocalControlMethod,
    (params: LocalControlParams) => unknown | Promise<unknown>
  >
>;
export const localControlSchemas = schemas;

/** Validation runs before any injected App handler, independently of MCP hints. */
export function validLocalControlParams(
  method: LocalControlMethod,
  value: unknown,
): value is LocalControlParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const schema = localControlSchemas[method];
  const params = value as LocalControlParams;
  if (
    schema.required.some((key) => !Object.hasOwn(params, key)) ||
    Object.keys(params).some((key) => !Object.hasOwn(schema.properties, key))
  )
    return false;
  for (const [key, raw] of Object.entries(params)) {
    const property = (
      schema.properties as Record<
        string,
        {
          type: string;
          minimum?: number;
          maximum?: number;
          minLength?: number;
          maxLength?: number;
          pattern?: string;
        }
      >
    )[key];
    if (property.type === "integer") {
      if (
        !Number.isSafeInteger(raw) ||
        (raw as number) < (property.minimum ?? 0) ||
        (raw as number) > (property.maximum ?? Number.MAX_SAFE_INTEGER)
      )
        return false;
    } else if (property.type === "boolean") {
      if (typeof raw !== "boolean") return false;
    } else if (
      typeof raw !== "string" ||
      !raw.trim() ||
      raw.length < (property.minLength ?? 0) ||
      raw.length > (property.maxLength ?? 200) ||
      /\0/.test(raw) ||
      (property.pattern && !new RegExp(property.pattern).test(raw))
    )
      return false;
  }
  return true;
}
