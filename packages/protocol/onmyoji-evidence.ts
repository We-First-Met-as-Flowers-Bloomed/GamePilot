/** Adapter observations of effects only; confirmed effects never imply successful navigation. */
export interface OnmyojiEffect {
  kind:
    | "one-key-chores"
    | "mail-claim"
    | "free-daily-gift"
    | "guild-submit"
    | "guild-reward"
    | "oboroguruma-equip"
    | "oboroguruma-start"
    | "hana-claim";
  observedAt: string;
  evidenceReference: string;
  summary: string;
}
export interface OnmyojiExecutionEvidence {
  version: 1;
  skillId:
    | "check-in"
    | "mail"
    | "daily-gift"
    | "guild-quest"
    | "oboroguruma"
    | "hana-claim";
  /** submitted is written before input; a failed input can still have reached the game. */
  phase: "not-submitted" | "submitted" | "confirmed";
  observedAt: string;
  effects: OnmyojiEffect[];
}
const kinds: Record<
  OnmyojiExecutionEvidence["skillId"],
  readonly OnmyojiEffect["kind"][]
> = {
  "check-in": ["one-key-chores"],
  mail: ["mail-claim"],
  "daily-gift": ["free-daily-gift"],
  "guild-quest": ["guild-submit", "guild-reward"],
  oboroguruma: ["oboroguruma-equip", "oboroguruma-start"],
  "hana-claim": ["hana-claim"],
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const date = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 50 &&
  Number.isFinite(Date.parse(value));
export function validOnmyojiEvidence(
  value: unknown,
): value is OnmyojiExecutionEvidence {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        !["version", "skillId", "phase", "observedAt", "effects"].includes(key),
    ) ||
    value.version !== 1 ||
    typeof value.skillId !== "string" ||
    !Object.hasOwn(kinds, value.skillId) ||
    typeof value.phase !== "string" ||
    !["not-submitted", "submitted", "confirmed"].includes(value.phase) ||
    !date(value.observedAt) ||
    !Array.isArray(value.effects) ||
    value.effects.length > 32 ||
    (value.phase === "confirmed" && value.effects.length === 0) ||
    (value.phase === "not-submitted" && value.effects.length > 0)
  )
    return false;
  const allowed = kinds[value.skillId as OnmyojiExecutionEvidence["skillId"]];
  return value.effects.every(
    (effect, index) =>
      object(effect) &&
      Object.keys(effect).every((key) =>
        ["kind", "observedAt", "evidenceReference", "summary"].includes(key),
      ) &&
      allowed.includes(effect.kind as OnmyojiEffect["kind"]) &&
      date(effect.observedAt) &&
      Date.parse(effect.observedAt) <= Date.parse(value.observedAt as string) &&
      effect.evidenceReference ===
        `onmyoji:${value.skillId}:effect:${index + 1}` &&
      typeof effect.summary === "string" &&
      effect.summary.trim().length > 0 &&
      effect.summary.length <= 512 &&
      !/[\x00-\x1f]/.test(effect.summary),
  );
}
