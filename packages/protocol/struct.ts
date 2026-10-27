/**
 * Shared structural-validation helpers.
 *
 * These replace the per-file `object()` / `identifier()` copies that had
 * drifted across protocol, games and main-process code. Semantics are frozen
 * to the loosest form that every former copy already agreed on; call sites
 * keep their local alias so diffs stay reviewable.
 */
import { canonical } from "./canonical";

export { canonical };

/**
 * Non-array plain-object guard. Returns the record, or `undefined` when the
 * value is not an object. Null is rejected; no key whitelist is applied.
 */
export function asRecord<
  T extends Record<string, unknown> = Record<string, unknown>,
>(value: unknown): T | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as T)
    : undefined;
}

/**
 * Type-predicate flavour of {@link asRecord} for validators that read better
 * as boolean guards.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== undefined;
}

/**
 * Strict object guard: the value must be a plain object whose keys are a
 * subset of `keys`. Returns the record, or `undefined`. Adapts the boolean
 * predicate used by protocol/fault.ts and the undefined-returning variant in
 * protocol/startup-reconciliation.ts.
 */
export function recordWithKeys(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    return undefined;
  return value as Record<string, unknown>;
}

/**
 * Identifier guard: a non-empty ASCII id built from `[A-Za-z0-9_:.-]` with a
 * length cap. The default cap (240) matches the agent-events/agent-goals
 * copies; callers with tighter rules keep their own regex.
 */
export function asIdentifier(value: unknown, maximum = 240): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    /^[A-Za-z0-9_:.-]+$/.test(value)
  );
}
