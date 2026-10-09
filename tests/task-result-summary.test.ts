import { expect, it } from "vitest";
import { summarizeTaskResult } from "../games/task-result-summary";
import type {
  TaskRecord,
  TaskStepRecord,
} from "../packages/protocol/task-record";
import type { ArknightsExecutionEvidence } from "../games/arknights/evidence";

const at = "2026-09-30T05:00:00Z";
const native = (taskType: string): ArknightsExecutionEvidence => ({
  version: 1,
  taskType,
  taskId: 1,
  submission: "submitted",
  completion: "native-confirmed",
  observedAt: at,
});
function record(
  gameId = "arknights",
  steps: TaskStepRecord[] = [],
): TaskRecord {
  return {
    version: 1,
    runId: "run",
    gameId,
    plan: { gameId, mode: "live", skillIds: steps.map((s) => s.skillId) },
    startedAt: at,
    updatedAt: at,
    status: "succeeded",
    message: "结束",
    steps,
  };
}
function step(skillId: string, e?: ArknightsExecutionEvidence): TaskStepRecord {
  return {
    skillId,
    status: "succeeded",
    message: "执行器已完成此步骤",
    diagnostics: [],
    ...(e ? { result: { arknights: e } } : {}),
  };
}
const item = (r: TaskRecord, id: string) =>
  summarizeTaskResult(r).items.find((i) => i.id === id)!;

it("keeps old missing statistics unknown and the last settlement separate", () => {
  const e = {
    ...native("Fight"),
    lastSettlement: { stage: "LS-6", stars: 3, batchRuns: 5 },
  };
  const r = record("arknights", [
    step("fight", e),
    step("friends", native("Mall")),
  ]);
  expect(item(r, "fight-runs").value).toBe("未记录");
  expect(item(r, "fight-last").value).toContain("本批 5 次");
  expect(item(r, "sanity").value).toBe("未记录");
  expect(item(r, "shopping").value).toBe("未记录");
});

it("presents cumulative observations and sanity change without claiming exact cost", () => {
  const e = native("Fight");
  e.statistics = {
    version: 1,
    fight: { completedRunsObserved: 5, firstSanity: 210, latestSanity: 30 },
  };
  const r = record("arknights", [step("fight", e)]);
  expect(item(r, "fight-runs").value).toBe("已记录 5 次");
  expect(item(r, "fight-runs").note).toContain("最近一次次数报告");
  expect(item(r, "sanity").value).toBe("210 → 30");
  expect(item(r, "sanity").note).toContain("净变化 -180");
  expect(item(r, "sanity").note).toContain("不是精确消耗");
});

it("does not turn zero confirmations into verified no rewards or no purchases", () => {
  const mall = native("Mall"),
    award = native("Award");
  mall.statistics = {
    version: 1,
    mall: { purchaseConfirmations: 0, creditCollected: false },
  };
  award.statistics = {
    version: 1,
    award: { claimActions: 0, mail: "unobserved" },
  };
  const r = record("arknights", [step("friends", mall), step("award", award)]);
  expect(item(r, "shopping").value).toBe("未观察到购买确认");
  expect(item(r, "awards").value).toBe("未观察到领奖确认");
  expect(item(r, "mail").value).toBe("未记录核验结果");
});

it("uses positive empty mail evidence separately from reward actions", () => {
  const e = native("Award");
  e.statistics = { version: 1, award: { claimActions: 2, mail: "empty" } };
  const r = record("arknights", [step("award", e)]);
  expect(item(r, "awards").value).toBe("领奖确认 2 次");
  expect(item(r, "awards").note).toContain("不是物品数量");
  expect(item(r, "mail").value).toBe("已核对，无待领附件");
});

it("explains observed discount-policy stopping without claiming an empty shop", () => {
  const e = native("Mall");
  e.statistics = {
    version: 1,
    mall: {
      purchaseConfirmations: 0,
      creditCollected: false,
      discountOnlyStoppedAtCredit: 893,
      shoppingErrorObserved: true,
    },
  };
  const shopping = item(record("arknights", [step("friends", e)]), "shopping");
  expect(shopping.value).toBe("未观察到购买确认");
  expect(shopping.note).toContain("仅折扣策略停止");
  expect(shopping.note).toContain("893");
  expect(shopping.note).toContain("不能确认商店没有折扣商品");
  expect(shopping.note).toContain("购物分支报告未成功");
});

it("shows a verified shopping balance and preserves an above-limit failed step", () => {
  const e = native("Mall");
  e.statistics = {
    version: 1,
    mall: {
      purchaseConfirmations: 3,
      creditCollected: false,
      finalCredit: 493,
    },
  };
  const s = step("friends", e);
  s.status = "failed";
  s.message = "信用仍超过300";
  const r = record("arknights", [s]);
  r.status = "failed";
  expect(item(r, "shopping").note).toContain("余额 493");
  expect(item(r, "shopping").note).toContain("仍超过300");
  expect(summarizeTaskResult(r).counts.failed).toBe(1);
});

it("preserves failed and unknown outcomes while showing only partial observations", () => {
  const e = native("Fight");
  e.completion = "unknown";
  e.statistics = { version: 1, fight: { completedRunsObserved: 5 } };
  const s = step("fight", e);
  s.status = "failed";
  s.message = "连接中断，未确认结束";
  const r = record("arknights", [s]);
  r.status = "failed";
  const summary = summarizeTaskResult(r);
  expect(summary.counts.failed).toBe(1);
  expect(summary.counts.completed).toBe(0);
  expect(summary.issues).toEqual([{ skillId: "fight", message: s.message }]);
  expect(item(r, "fight-runs").note).toContain("部分观测");
  s.status = "succeeded";
  expect(summarizeTaskResult(r).counts.unknown).toBe(1);
});

it("keeps skipped and not-run separate and uses explicit onmyoji outcome", () => {
  const mail = step("mail");
  mail.status = "skipped";
  mail.result = { status: "skipped", summary: "邮箱无可领取附件" };
  const hana = step("hana-claim");
  hana.status = "not-run";
  hana.message = "前序中断";
  const r = record("onmyoji", [mail, hana]);
  const s = summarizeTaskResult(r);
  expect(s.counts).toMatchObject({ completed: 0, skipped: 1, notRun: 1 });
  expect(item(r, "mail").value).toBe("邮箱无可领取附件");
  expect(item(r, "hana-claim").value).toBe("未执行");
});

it("never shows synthetic execution numbers as real results in rehearsal", () => {
  const e = native("Fight");
  e.statistics = { version: 1, fight: { completedRunsObserved: 999 } };
  const r = record("arknights", [step("fight", e)]);
  r.plan.mode = "rehearsal";
  expect(summarizeTaskResult(r).items).toEqual([]);
  expect(summarizeTaskResult(r).scopeNote).toContain("未操作游戏");
});

it("does not invent measurements from human-readable diagnostics", () => {
  const s = step("fight");
  s.diagnostics = ["作战完成999次；理智0"];
  const r = record("arknights", [s]);
  expect(item(r, "fight-runs").value).toBe("未记录");
  expect(summarizeTaskResult(r).scopeNote).toContain("不合并其他请求");
});

it("does not show unsupported metrics for absent steps", () => {
  expect(
    summarizeTaskResult(record("arknights", [step("login", native("StartUp"))]))
      .items,
  ).toEqual([]);
});

it("preserves a run-level failure after all recorded steps ended", () => {
  const r = record("arknights", [step("login", native("StartUp"))]);
  r.status = "unknown";
  r.message = "步骤结束后应用中断，整轮结果未确认";
  expect(summarizeTaskResult(r).issues).toContainEqual({
    skillId: "$run",
    message: r.message,
  });
});

it.each(["pending", "not-run"] as const)(
  "rejects observed statistics on a %s step",
  (status) => {
    const e = native("Fight");
    e.statistics = { version: 1, fight: { completedRunsObserved: 5 } };
    const s = step("fight", e);
    s.status = status;
    const r = record("arknights", [s]);
    expect(item(r, "fight-runs").value).toBe("未记录");
    expect(summarizeTaskResult(r).issues[0].message).toContain("证据冲突");
  },
);
