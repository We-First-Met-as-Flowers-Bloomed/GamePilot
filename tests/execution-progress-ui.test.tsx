import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import ExecutionProgressPanel, {
  ExecutionProgressContent,
} from "../apps/desktop/renderer/components/ExecutionProgressPanel";
import { ExecutionDetailContent } from "../apps/desktop/renderer/components/ExecutionDetail";
import Daily from "../apps/desktop/renderer/views/Daily";
import type { DesktopController } from "../apps/desktop/renderer/hooks/useDesktop";
import type { DeviceLane, RunEvent } from "../packages/protocol";
import type { ExecutionProgress } from "../packages/protocol/execution-progress";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { ExecutionDetail } from "../packages/protocol/execution-detail";

const at = "2026-10-03T01:00:00Z";
const progress = (): ExecutionProgress => ({
  version: 1,
  requestId: "original",
  rootId: "original",
  latestId: "continuation",
  laneId: "lane-a",
  source: "daily",
  originalStatus: "failed",
  outcome: "recovered",
  wholePlanComplete: true,
  startedAt: at,
  counts: { total: 2, completed: 2, skipped: 0, excluded: 0, remaining: 0 },
  requests: [
    { id: "original", status: "failed", startedAt: at },
    { id: "continuation", status: "succeeded", startedAt: at },
  ],
  steps: [
    {
      gameId: "arknights",
      skillId: "login",
      status: "succeeded",
      sourceId: "continuation",
      continued: true,
    },
    {
      gameId: "arknights",
      skillId: "recruit",
      status: "succeeded",
      sourceId: "original",
      continued: false,
    },
    {
      gameId: "arknights",
      skillId: "award",
      status: "succeeded",
      sourceId: "continuation",
      continued: true,
    },
  ],
  warnings: [],
});
const render = (value: ExecutionProgress) =>
  renderToStaticMarkup(
    createElement(ExecutionProgressContent, { progress: value }),
  );

it.each([
  ["complete", "本轮原计划已完成"],
  ["recovered", "原计划已补齐"],
  ["partial", "已结束，含取消任务"],
  ["running", "原计划执行中"],
  ["incomplete", "原计划尚未完成"],
  ["unconfirmed", "原计划结果待核对"],
] as const)("renders %s as its own original-plan outcome", (outcome, label) => {
  const value = progress();
  value.outcome = outcome;
  value.wholePlanComplete = outcome === "complete" || outcome === "recovered";
  const html = render(value);
  expect(html).toContain(label);
  expect(html).toContain(`data-outcome="${outcome}"`);
  expect(html).not.toContain("今日日常已完成");
});

it("uses business counts without counting mandatory login and exposes record sources", () => {
  const html = render(progress());
  expect(html).toContain("2/2");
  expect(html).not.toContain("3/3");
  expect(html).toContain("启动与上号");
  expect(html).toContain("保守自动公招");
  expect(html).toContain("领取任务奖励");
  expect(html).toContain("必需前置");
  expect(html).toContain("登录核验为必需前置，不计入业务任务数量");
  expect(html).toContain("记录来源：<code>original</code>");
  expect(html).toContain("记录来源：<code>continuation</code>");
  expect(html).toContain("续跑记录");
  expect(html).toContain("原请求记录");
});

it("keeps excluded and skipped entries separate from completed business tasks", () => {
  const value = progress();
  value.outcome = "partial";
  value.wholePlanComplete = false;
  value.counts = {
    total: 3,
    completed: 1,
    skipped: 1,
    excluded: 1,
    remaining: 0,
  };
  value.steps[2].status = "excluded";
  value.steps.push({
    gameId: "arknights",
    skillId: "fight",
    status: "skipped",
    sourceId: "original",
    continued: false,
  });
  const html = render(value);
  expect(html).toContain("完成 <strong>1/3</strong>");
  expect(html).toContain("已跳过 <strong>1</strong>");
  expect(html).toContain("已取消 <strong>1</strong>");
  expect(html).toContain('data-progress-state="excluded"');
  expect(html).toContain("已取消，未计为完成");
  expect(html).not.toContain("原计划已补齐");
  expect(html).not.toContain("本轮原计划已完成");
});

it("preserves original failure and its evidence when showing recovered coverage in details", () => {
  const value: ExecutionDetail = {
    request: {
      id: "original",
      source: "daily",
      status: "failed",
      startedAt: at,
      message: "原请求信用商店失败",
      instance: 0,
    },
    warnings: [],
    games: [],
  };
  const before = structuredClone(value);
  const html = renderToStaticMarkup(
    createElement(ExecutionDetailContent, {
      detail: value,
      progress: createElement(ExecutionProgressContent, {
        progress: progress(),
      }),
    }),
  );
  expect(html).toContain('class="execution-detail-status" data-state="failed"');
  expect(html).toContain("原请求信用商店失败");
  expect(html).toContain("原计划已补齐");
  expect(html).toContain("MuMu 0");
  expect(html.indexOf("原计划已补齐")).toBeLessThan(
    html.indexOf('aria-label="游戏任务"'),
  );
  expect(value).toEqual(before);
});

it("distinguishes confirmed zero counts from missing original-plan records", () => {
  const value = progress();
  value.outcome = "unconfirmed";
  value.wholePlanComplete = false;
  value.steps = [];
  value.counts = {
    total: 0,
    completed: 0,
    skipped: 0,
    excluded: 0,
    remaining: 0,
  };
  expect(render(value)).toContain("0/0");
  const absent = renderToStaticMarkup(
    createElement(ExecutionProgressPanel, {}),
  );
  expect(absent).toContain("暂无可确认的原计划记录");
  expect(absent).not.toContain("0/0");
  expect(absent).not.toContain("本轮原计划已完成");
});

it.each(["single", "maintenance"] as const)(
  "limits %s success to its original request scope",
  (source) => {
    const value = progress();
    value.source = source;
    const html = render(value);
    expect(html).toContain("不代表整套日常完成");
    expect(html).not.toContain("本轮每日计划");
  },
);

it("renders uncertain step outcomes and host warnings without inventing registry titles", () => {
  const value = progress();
  value.outcome = "unconfirmed";
  value.wholePlanComplete = false;
  value.steps = [
    {
      gameId: "future-game",
      skillId: "future-skill",
      status: "unknown",
      sourceId: "original",
      continued: false,
    },
  ];
  value.warnings = ["旧记录缺少可信步骤证据"];
  const html = render(value);
  expect(html).toContain("future-skill");
  expect(html).toContain("future-game");
  expect(html).toContain("结果未知");
  expect(html).toContain("旧记录缺少可信步骤证据");
});

const lane: DeviceLane = {
  id: "lane-a",
  name: "账号 A",
  instance: 0,
  managerPath: "",
  enabled: true,
  arknights: { enabled: false, profileId: "default" },
  onmyoji: { enabled: false },
  closeEmulatorAfterSuccess: false,
};
const receipt = (id: string, continuation: boolean): ExecutionRecord => ({
  version: 1,
  id,
  source: "single",
  resources: [],
  snapshot: continuation ? { continuation: { parentId: "original" } } : {},
  laneId: lane.id,
  batchId: "batch",
  fingerprint: id,
  status: "succeeded",
  startedAt: at,
  finishedAt: at,
  message: "所选任务结束",
});
const renderDaily = (records: ExecutionRecord[], target: DeviceLane = lane) => {
  const lastRun: RunEvent = {
    runId: "batch",
    batchId: "batch",
    laneId: target.id,
    executionId: "current",
    executionSource: "single",
    type: "status",
    status: "succeeded",
    at,
    message: "所选任务结束",
  };
  const desktop = {
    deviceLanes: { version: 1, lanes: [target] },
    arknightsProfiles: { profiles: [] },
    snapshot: { executions: records },
    laneStatuses: { [target.id]: "succeeded" },
    laneDailyStates: { [target.id]: { status: null, lastRun } },
    taskRecords: [],
    active: false,
    lanesDirty: false,
  } as unknown as DesktopController;
  return renderToStaticMarkup(createElement(Daily, { desktop }));
};

it("shows the continuation guidance only for the exact matching current receipt", () => {
  const html = renderDaily([receipt("current", true)]);
  expect(html).toContain("续跑进度见下方");
  expect(html).toContain("最近续跑（仅所选任务）");
  expect(html).toContain('aria-label="原计划与续跑进度"');
  expect(html).not.toContain("今日日常待核对");
  const other = renderDaily([
    receipt("current", false),
    receipt("other", true),
  ]);
  expect(other).toContain("今日日常待核对");
  expect(other).not.toContain("续跑进度见下方");
  expect(other).not.toContain("最近续跑（仅所选任务）");
});

it("keeps an exact single-game continuation panel visible before the task disclosure", () => {
  const target = { ...lane, onmyoji: { enabled: true } };
  const current = receipt("current", true);
  current.snapshot.onmyojiPlan = {
    gameId: "onmyoji",
    mode: "live",
    skillIds: ["login"],
  };
  const html = renderDaily([current], target);
  const visible = html.split('<details class="daily-plan-details"')[0];
  expect(visible).toContain("续跑进度见下方");
  expect(visible).toContain("最近续跑（仅所选任务）");
  expect(visible).toContain('aria-label="原计划与续跑进度"');
  expect(html.match(/aria-label="原计划与续跑进度"/g)).toHaveLength(1);
});

it.each(["lane", "batch", "duplicate", "game"])(
  "does not borrow a continuation receipt with conflicting %s ownership",
  (conflict) => {
    const target = { ...lane, onmyoji: { enabled: true } };
    const current = receipt("current", true);
    current.snapshot.onmyojiPlan = {
      gameId: "onmyoji",
      mode: "live",
      skillIds: ["login"],
    };
    if (conflict === "lane") current.laneId = "different-account";
    if (conflict === "batch") current.batchId = "different-batch";
    if (conflict === "game") {
      delete current.snapshot.onmyojiPlan;
      current.snapshot.arknightsPlan = {
        gameId: "arknights",
        mode: "live",
        skillIds: ["login"],
      };
    }
    const html = renderDaily(
      conflict === "duplicate" ? [current, { ...current }] : [current],
      target,
    );
    expect(html).not.toContain("续跑进度见下方");
    expect(html).not.toContain("最近续跑（仅所选任务）");
  },
);
