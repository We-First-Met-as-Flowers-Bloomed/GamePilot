import { validateRequestId } from "./execution";

/** Bound to one active immutable plan. It grants no changes to skills or resource permissions. */
export interface PauseAfterStepInput {
  runId: string;
  revision: 1;
}
export interface PauseAfterStepReceipt extends PauseAfterStepInput {
  status: "queued" | "applied";
}
export function validatePauseAfterStepInput(
  input: unknown,
): PauseAfterStepInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("步骤边界暂停参数无效");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !["runId", "revision"].includes(key)) ||
    value.revision !== 1
  )
    throw Error(
      "步骤边界暂停只接受当前runId与计划版本1，不接受任务或资源权限变更",
    );
  return { runId: validateRequestId(value.runId), revision: 1 };
}
