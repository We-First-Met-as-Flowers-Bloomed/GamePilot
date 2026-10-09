import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runBudget, runFailure } from "../packages/runtime/run-budget";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => vi.useRealTimers());

it("includes preparation elapsed before the absolute deadline was attached", () => {
  const deadline = Date.now() + 10_000;
  vi.advanceTimersByTime(4_000);
  const budget = runBudget(new AbortController().signal, deadline);
  vi.advanceTimersByTime(5_999);
  expect(budget.signal.aborted).toBe(false);
  vi.advanceTimersByTime(1);
  expect(budget.signal.reason).toMatchObject({
    name: "TimeoutError",
    message: "明日方舟本轮运行已达到时限，已停止后续任务；请检查游戏状态",
  });
  expect(budget.signal.reason).toBeInstanceOf(Error);
  budget.dispose();
});
it("does not extend the deadline when another phase attaches a budget", () => {
  const parent = new AbortController();
  const deadline = Date.now() + 10_000;
  const first = runBudget(parent.signal, deadline);
  vi.advanceTimersByTime(6_000);
  const second = runBudget(parent.signal, deadline);
  vi.advanceTimersByTime(4_000);
  expect(first.signal.aborted).toBe(true);
  expect(second.signal.aborted).toBe(true);
  first.dispose();
  second.dispose();
});
it("preserves the parent's cancellation reason even after the deadline", () => {
  const parent = new AbortController();
  const budget = runBudget(parent.signal, Date.now() + 1_000);
  const reason = new Error("user cancelled");
  parent.abort(reason);
  vi.advanceTimersByTime(1_000);
  expect(budget.signal.reason).toBe(reason);
  budget.dispose();
});
it("prefers an already cancelled parent over an already expired deadline", () => {
  const reason = new Error("already cancelled");
  const budget = runBudget(AbortSignal.abort(reason), Date.now() - 1);
  expect(budget.signal.reason).toBe(reason);
  budget.dispose();
});
it("expires immediately when the deadline has already passed", () => {
  const budget = runBudget(new AbortController().signal, Date.now() - 1);
  expect(budget.signal.aborted).toBe(true);
  expect(budget.signal.reason.name).toBe("TimeoutError");
  budget.dispose();
});
it("disposes the timer without disabling parent cancellation", () => {
  const parent = new AbortController();
  const budget = runBudget(parent.signal, Date.now() + 1_000);
  budget.dispose();
  budget.dispose();
  vi.advanceTimersByTime(2_000);
  expect(budget.signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  const reason = new Error("stop");
  parent.abort(reason);
  expect(budget.signal.reason).toBe(reason);
});
it.each([NaN, Infinity, -Infinity])(
  "rejects nonfinite deadline %s",
  (deadline) => {
    expect(() => runBudget(new AbortController().signal, deadline)).toThrow(
      RangeError,
    );
  },
);

it("records deadline failure even when an abort-aware wait wraps it as AbortError", () => {
  const budget = runBudget(new AbortController().signal, Date.now() + 1_000);
  vi.advanceTimersByTime(1_000);
  const wrapped = new Error("The operation was aborted", {
    cause: budget.signal.reason,
  });
  wrapped.name = "AbortError";
  expect(runFailure(wrapped, budget.signal)).toBe(budget.signal.reason);
  expect((runFailure(wrapped, budget.signal) as Error).name).toBe(
    "TimeoutError",
  );
  budget.dispose();
});
it("keeps explicit user cancellation and unrelated errors distinguishable", () => {
  const controller = new AbortController();
  const error = new Error("native failure");
  expect(runFailure(error, controller.signal)).toBe(error);
  controller.abort();
  expect((runFailure(error, controller.signal) as Error).name).toBe(
    "AbortError",
  );
});
