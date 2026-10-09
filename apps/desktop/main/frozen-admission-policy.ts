import type { LaneExecutionSnapshot } from "./lane-snapshot";
import { dailyLaneScope } from "./daily-policy";
import type { DailySlot } from "./scheduler";

export interface FrozenIdentity {
  requestId: string;
  planHash?: string;
  kind?: string;
  daily?: { slot: DailySlot; scopes: Record<string, string> };
}

/** A saved daily uses the same observation and scheduler completion path as the timer. */
export function frozenAdmissionPolicy(
  identity: FrozenIdentity,
  frozen: LaneExecutionSnapshot,
) {
  const saved = identity.kind === "saved-daily";
  if (
    saved &&
    (!identity.daily ||
      !["primary", "secondary"].includes(identity.daily.slot) ||
      typeof identity.daily.scopes[frozen.lane.id] !== "string")
  )
    throw new Error("保存日常缺少原设备日程范围，不能受理");
  return {
    source: saved ? ("daily" as const) : ("single" as const),
    custom: !saved,
    scope: saved
      ? identity.daily!.scopes[frozen.lane.id]
      : dailyLaneScope(frozen.lane),
    ...(saved ? { slot: identity.daily!.slot } : {}),
  };
}
