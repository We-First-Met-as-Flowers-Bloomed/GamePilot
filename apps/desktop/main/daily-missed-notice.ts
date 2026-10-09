import type { DailyScheduler, DailySlot } from "./scheduler";
export function dailyMissedNotices(
  laneName: string,
  daily: Awaited<ReturnType<DailyScheduler["dailyState"]>>,
  config: { scheduleEnabled: boolean; secondScheduleEnabled?: boolean },
  busy: boolean,
): { slot: DailySlot; day: string; message: string }[] {
  if (!config.scheduleEnabled || busy) return [];
  return [daily.primary, daily.secondary]
    .filter(
      (state) =>
        (state.slot !== "secondary" || config.secondScheduleEnabled) &&
        state.attempted &&
        !state.completed &&
        !state.retryAllowed,
    )
    .map((state) => ({
      slot: state.slot,
      day: daily.day,
      message: `${laneName} 今天的${state.slot === "primary" ? "第一轮" : "第二轮"}日常仍未确认完成（${state.slot === "primary" ? daily.scheduleTime : daily.secondScheduleTime}）：已尝试 ${state.attempts} 次，原时段状态「${state.lastStatus ?? "未知"}」。自动重试暂停；请核对原任务后按原进度续跑。`,
    }));
}
