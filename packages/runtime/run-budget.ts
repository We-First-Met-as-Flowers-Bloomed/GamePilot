export function runBudget(
  parent: AbortSignal,
  deadlineAt: number,
): { signal: AbortSignal; dispose(): void } {
  if (!Number.isFinite(deadlineAt)) throw new RangeError("运行截止时间无效");
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    if (signal.aborted) return;
    const remaining = deadlineAt - Date.now();
    if (remaining > 0) {
      timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
      return;
    }
    const error = new Error(
      "明日方舟本轮运行已达到时限，已停止后续任务；请检查游戏状态",
    );
    error.name = "TimeoutError";
    controller.abort(error);
  };
  check();
  return {
    signal,
    dispose() {
      clearTimeout(timer);
    },
  };
}

/** Abort-aware waits may wrap a deadline in AbortError; retain the run's original cause. */
export function runFailure(error: unknown, signal: AbortSignal): unknown {
  return signal.aborted ? signal.reason : error;
}
