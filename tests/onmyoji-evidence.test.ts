import { expect, it } from "vitest";
import {
  validOnmyojiEvidence,
  type OnmyojiExecutionEvidence,
} from "../packages/protocol/onmyoji-evidence";
import { onmyojiStepEvidence } from "../games/onmyoji/evidence";

const at = "2026-10-07T04:00:00.000Z";
const evidence = (): OnmyojiExecutionEvidence => ({
  version: 1,
  skillId: "daily-gift",
  phase: "confirmed",
  observedAt: at,
  effects: [
    {
      kind: "free-daily-gift",
      observedAt: at,
      evidenceReference: "onmyoji:daily-gift:effect:1",
      summary: "已核验免费礼包",
    },
  ],
});
it.each([
  "object-phase",
  "cross-skill-effect",
  "extra-authority",
  "invented-reference",
  "future-effect",
  "empty-confirmation",
])("rejects malformed or authority-bearing effect evidence (%s)", (invalid) => {
  const value: any = evidence();
  if (invalid === "object-phase") value.phase = new String("confirmed");
  if (invalid === "cross-skill-effect") value.effects[0].kind = "guild-submit";
  if (invalid === "extra-authority") value.accountVerified = true;
  if (invalid === "invented-reference")
    value.effects[0].evidenceReference = "model-says-done";
  if (invalid === "future-effect")
    value.effects[0].observedAt = "2026-10-07T04:00:01.000Z";
  if (invalid === "empty-confirmation") value.effects = [];
  expect(validOnmyojiEvidence(value)).toBe(false);
});
it("retains valid adapter effects only inside their matching completed step", () => {
  const step: any = {
    skillId: "daily-gift",
    status: "failed",
    startedAt: at,
    finishedAt: at,
    result: { onmyoji: evidence() },
  };
  expect(onmyojiStepEvidence(step)).toEqual(evidence());
  step.skillId = "mail";
  expect(onmyojiStepEvidence(step)).toBeUndefined();
  step.skillId = "daily-gift";
  step.startedAt = "2026-10-07T04:00:01.000Z";
  expect(onmyojiStepEvidence(step)).toBeUndefined();
});
