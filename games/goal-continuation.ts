import type { Plan } from "../packages/protocol";
import type { GoalScope } from "../packages/protocol/agent-goal";
import type { ContinuationPreview } from "../packages/protocol/continuation";
import { continuationPlans } from "./continuation";
import type { StartupFailureProof } from "./startup-continuation";

/** Freeze the actual execution plans; preview defaults contain only business skills. */
export function goalContinuationPlans(
  preview: ContinuationPreview,
  proof?: StartupFailureProof,
): Plan[] {
  return continuationPlans(
    preview,
    {
      parentId: preview.parentId,
      fingerprint: preview.fingerprint,
      selections: preview.defaults,
      acknowledgePartial: true,
    },
    [],
    proof,
  );
}

/** Include each fresh login gate in the scope checked against the original grant. */
export function goalContinuationScopes(
  preview: ContinuationPreview,
  laneId: string,
  proof?: StartupFailureProof,
): GoalScope[] {
  if (!laneId.trim()) throw Error("续跑缺少冻结账号范围");
  return goalContinuationPlans(preview, proof).map((plan) => ({
    laneId,
    gameId: plan.gameId,
    skillIds: [...plan.skillIds],
    resources: { medicine: 0, stone: 0, expiringMedicine: 0 },
  }));
}
