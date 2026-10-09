import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DeviceLane, RunEvent } from "../packages/protocol";
import { deviceLanePlanKey } from "../packages/protocol";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { TaskRecord } from "../packages/protocol/task-record";
import { dailyLaneState } from "../apps/desktop/renderer/daily-state";
import { chatLaneActivity } from "../apps/desktop/renderer/chat-activity";
import ChatActivity from "../apps/desktop/renderer/components/ChatActivity";
import type { DesktopController } from "../apps/desktop/renderer/hooks/useDesktop";

const now = new Date("2026-10-04T12:00:00+08:00");
const lane: DeviceLane = {
  id: "lane-a",
  name: "账号一",
  instance: 0,
  managerPath: "",
  enabled: true,
  arknights: { enabled: true, profileId: "a" },
  onmyoji: { enabled: true },
  closeEmulatorAfterSuccess: false,
};
function event(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    type: "status",
    laneId: lane.id,
    runId: "batch",
    batchId: "batch",
    executionId: "request-a",
    executionSource: "daily",
    planKey: deviceLanePlanKey(lane),
    status: "succeeded",
    startedAt: now.toISOString(),
    at: now.toISOString(),
    message: "未经验证的全部任务完成声明",
    ...overrides,
  };
}
function receipt(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    version: 1,
    id: "request-a",
    laneId: lane.id,
    batchId: "batch",
    source: "daily",
    resources: [],
    snapshot: {},
    fingerprint: "test",
    status: "succeeded",
    startedAt: now.toISOString(),
    message: "完成",
    ...overrides,
  };
}
function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    version: 1,
    executionId: "request-a",
    runId: "ark-run",
    laneId: lane.id,
    batchId: "batch",
    gameId: "arknights",
    plan: { gameId: "arknights", skillIds: ["login", "mall"], mode: "live" },
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    status: "running",
    message: "任务运行中",
    steps: [
      {
        skillId: "login",
        status: "succeeded",
        message: "核验完成",
        diagnostics: [],
      },
      {
        skillId: "mall",
        status: "running",
        message: "执行中",
        diagnostics: [],
      },
    ],
    ...overrides,
  };
}
function select(
  run = event(),
  tasks: TaskRecord[] = [],
  requests = [receipt()],
) {
  return chatLaneActivity(
    lane,
    dailyLaneState(lane, [run], now, requests),
    tasks,
    requests,
  );
}

describe("chat lane facts", () => {
  it("shows a current daily result from its exact host receipt", () => {
    const value = select();
    expect(value).toMatchObject({
      label: "本轮日常已完成",
      scope: "daily",
      requestId: "request-a",
      dailyRequestId: "request-a",
      active: false,
      canDiagnose: false,
    });
  });
  it.each([
    { status: "succeeded" as const, executionSource: "single" as const },
    { status: "succeeded" as const, startedAt: "2026-10-03T01:00:00Z" },
    { status: "succeeded" as const, planKey: "old-plan" },
  ])(
    "does not describe an old, changed or single plan as today's completion: %j",
    (overrides) => {
      const requests = [
        receipt({ source: overrides.executionSource ?? "daily" }),
      ];
      expect(select(event(overrides), [], requests).label).toBe(
        "今日日常待核对",
      );
    },
  );
  it("labels a selected continuation separately from the whole daily plan", () => {
    const value = select(
      event(),
      [],
      [receipt({ snapshot: { continuation: { parentId: "original" } } })],
    );
    expect(value.scope).toBe("continuation");
    expect(value.label).toBe("续跑已结束 · 原计划待核对");
    expect(value.dailyRequestId).toBeUndefined();
  });
  it("keeps a running scoped task visible even though it cannot prove daily completion", () => {
    const value = select(
      event({ status: "running", executionSource: "single" }),
      [record()],
      [receipt({ status: "running", source: "single" })],
    );
    expect(value).toMatchObject({
      active: true,
      label: "单项任务运行中",
      scope: "single",
    });
    expect(value.currentStep).toMatchObject({
      gameId: "arknights",
      skillId: "mall",
      status: "running",
    });
  });
  it("does not hide an unknown task behind a succeeded batch", () => {
    const value = select(event(), [record({ status: "unknown" })]);
    expect(value.label).toBe("部分结果未知");
    expect(value.uncertain).toBe(true);
  });
  it("does not treat a host unknown receipt as a successful daily result", () => {
    expect(select(event(), [], [receipt({ status: "unknown" })]).label).toBe(
      "部分结果未知",
    );
  });
  it("does not attach another lane, batch or execution's task step", () => {
    const tasks = [
      record({ laneId: "lane-b" }),
      record({ batchId: "other" }),
      record({ executionId: "request-b" }),
    ];
    expect(
      select(event({ status: "running" }), tasks).currentStep,
    ).toBeUndefined();
  });
  it("refuses a shared-batch receipt ambiguity and conflicting exact receipt", () => {
    expect(
      select(
        event({ executionId: undefined }),
        [],
        [receipt(), receipt({ id: "second" })],
      ).requestId,
    ).toBeUndefined();
    expect(
      select(event(), [], [receipt({ laneId: "lane-b" })]).requestId,
    ).toBeUndefined();
  });
  it("does not display a step when the exact receipt binding is rejected or a batch is ambiguous", () => {
    expect(
      select(event(), [record()], [receipt({ laneId: "lane-b" })]).currentStep,
    ).toBeUndefined();
    expect(
      select(
        event({ executionId: undefined }),
        [record()],
        [receipt(), receipt({ id: "second" })],
      ).currentStep,
    ).toBeUndefined();
  });
  it("only offers failure diagnosis for an exact unresolved host failure", () => {
    const run = event({ status: "failed" });
    expect(select(run, [], [receipt({ status: "failed" })]).canDiagnose).toBe(
      true,
    );
    expect(select(run, [], [receipt({ status: "unknown" })]).canDiagnose).toBe(
      true,
    );
    expect(
      select(
        run,
        [],
        [
          receipt({
            status: "failed",
            resolution: {
              action: "abandoned",
              at: now.toISOString(),
              note: "已结束",
            },
          }),
        ],
      ).canDiagnose,
    ).toBe(false);
    expect(select(run, [], []).canDiagnose).toBe(false);
  });
  it("uses structured task status, never native log text as a current task", () => {
    const tasks = [
      record({
        steps: [
          {
            skillId: "mall",
            status: "succeeded",
            message: "正在执行没有完成",
            diagnostics: ["running"],
          },
        ],
      }),
    ];
    expect(select(event(), tasks).currentStep).toBeUndefined();
  });
  it("shows the failed step ahead of future pending steps", () => {
    const tasks = [
      record({
        status: "failed",
        steps: [
          {
            skillId: "login",
            status: "failed",
            message: "页面未确认",
            diagnostics: [],
          },
          {
            skillId: "mall",
            status: "pending",
            message: "等待",
            diagnostics: [],
          },
        ],
      }),
    ];
    expect(
      select(event({ status: "failed" }), tasks, [
        receipt({ status: "failed" }),
      ]).currentStep?.skillId,
    ).toBe("login");
  });
});

it("renders compact lane facts with expandable details and a per-account stop", () => {
  const run = event({ status: "running" });
  const request = receipt({ status: "running" });
  const desktop = {
    deviceLanes: { version: 1, lanes: [lane] },
    laneDailyStates: { [lane.id]: dailyLaneState(lane, [run], now, [request]) },
    taskRecords: [record()],
    allEvents: [run],
    snapshot: { executions: [request] },
    active: true,
  } as unknown as DesktopController;
  const html = renderToStaticMarkup(createElement(ChatActivity, { desktop }));
  expect(html).toContain("账号一");
  expect(html).toContain("本轮日常运行中");
  expect(html).toContain("停止账号一");
  expect(html).toContain("展开执行详情");
  expect(html).not.toContain(run.message);
});
