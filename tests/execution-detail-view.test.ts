import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ExecutionDetailContent } from "../apps/desktop/renderer/components/ExecutionDetail";
import type { ExecutionDetail } from "../packages/protocol/execution-detail";
import type { TaskRecord } from "../packages/protocol/task-record";

const at = "2026-09-30T01:00:00Z";
const detail = (): ExecutionDetail => ({
  request: {
    id: "exact-request",
    source: "daily",
    status: "unknown",
    startedAt: at,
    message: "本次执行中断，现场结果未确认",
    laneId: "lane-original",
    batchId: "batch-original",
    laneName: "冻结的第二账号",
    instance: 0,
    profileName: "冻结档案",
    agentRequestId: "agent-original",
  },
  games: [],
  warnings: [],
});
const render = (value: ExecutionDetail) =>
  renderToStaticMarkup(
    createElement(ExecutionDetailContent, { detail: value }),
  );

it("keeps an abandoned unknown result unknown and shows its separate resolution", () => {
  const value = detail();
  value.request.resolution = {
    action: "abandoned",
    at,
    note: "用户核对后结束处理",
  };
  const html = render(value);
  expect(html).toContain('data-state="unknown"');
  expect(html).toContain("结果未知");
  expect(html).toContain("已结束处理");
  expect(html).toContain("用户核对后结束处理");
  expect(html).toContain("未将原始结果标记为成功");
  expect(html).not.toContain('data-state="succeeded"');
});

it("shows frozen request scope and puts technical identifiers in a closed disclosure", () => {
  const html = render(detail());
  expect(html).toContain("冻结的第二账号");
  expect(html).toContain("冻结档案");
  expect(html).toContain("MuMu 0");
  expect(html).toContain("AI");
  expect(html).toContain("每日计划");
  const disclosure = html.match(
    /<details class="execution-detail-technical"[^>]*>(.*?)<\/details>/s,
  );
  expect(disclosure?.[0]).not.toContain('open=""');
  expect(disclosure?.[1]).toContain("exact-request");
  expect(disclosure?.[1]).toContain("agent-original");
  expect(disclosure?.[1]).toContain("batch-original");
  expect(disclosure?.[1]).toContain("lane-original");
});

it("shows the validated result summary without turning old or repaired requests into success", () => {
  const value = detail();
  value.games = [
    {
      plan: { gameId: "arknights", mode: "live", skillIds: ["fight"] },
      summary: {
        version: 1,
        mode: "live",
        counts: {
          completed: 0,
          skipped: 0,
          failed: 1,
          unknown: 0,
          notRun: 0,
          running: 0,
          pending: 0,
          cancelled: 0,
        },
        items: [
          {
            id: "battle",
            label: "作战",
            value: "已核对 5 次",
            note: "原生结算记录",
          },
        ],
        issues: [{ skillId: "fight", message: "后续结果未确认" }],
        scopeNote: "只展示本次请求，不合并后续单项结果。",
      },
    },
  ];
  const html = render(value);
  expect(html).toContain("已核对 5 次");
  expect(html).toContain("后续结果未确认");
  expect(html).toContain("只展示本次请求，不合并后续单项结果。");
  expect(html).toContain('data-state="unknown"');
});

it("shows absent records as uncertain plans without inventing step results", () => {
  const value = detail();
  value.games = [
    {
      plan: {
        gameId: "onmyoji",
        mode: "rehearsal",
        skillIds: ["mail", "future-skill"],
      },
      issue: "存在多条候选记录，无法确定本次结果",
    },
  ];
  value.warnings = ["旧账本记录不完整"];
  const html = render(value);
  expect(html).toContain("邮件附件");
  expect(html).toContain("future-skill");
  expect(html).toContain("演练计划");
  expect(html).toContain("无法确定本次结果");
  expect(html).toContain("旧账本记录不完整");
  expect(html).toContain("不推断是否执行或完成");
  expect(html).not.toContain("task-step-status");
  expect(html).not.toContain("0/2");
});

it("reuses exact step outcomes while preserving native success limits and collapsed diagnostics", () => {
  const value = detail();
  const record: TaskRecord = {
    version: 1,
    runId: "the-selected-run",
    gameId: "arknights",
    plan: {
      gameId: "arknights",
      mode: "live",
      skillIds: ["login", "recruit", "friends", "fight", "award"],
    },
    startedAt: at,
    updatedAt: at,
    status: "unknown",
    message: "准确记录中的运行摘要",
    steps: [
      {
        skillId: "login",
        status: "succeeded",
        evidence: "adapter-return",
        message: "原生流程返回",
        diagnostics: ["native diagnostic"],
        result: {
          arknights: {
            version: 1,
            taskType: "StartUp",
            submission: "submitted",
            completion: "native-confirmed",
            observedAt: at,
            taskId: 8,
          },
        },
      },
      {
        skillId: "recruit",
        status: "skipped",
        message: "无需公招",
        diagnostics: [],
      },
      {
        skillId: "friends",
        status: "failed",
        message: "信用商店未打开",
        diagnostics: [],
      },
      {
        skillId: "fight",
        status: "unknown",
        message: "原生完成未确认",
        diagnostics: [],
      },
      {
        skillId: "award",
        status: "not-run",
        message: "后续任务未执行",
        diagnostics: [],
      },
    ],
  };
  value.games = [{ plan: record.plan, record }];
  const html = render(value);
  for (const status of ["succeeded", "skipped", "failed", "unknown", "not-run"])
    expect(html).toContain(`data-state="${status}"`);
  expect(html).toContain("准确记录中的运行摘要");
  expect(html).toContain("执行器完成");
  expect(html).toContain("不代表每项奖励都实际产生");
  expect(html).toContain("收到对应任务编号的原生完成回调");
  expect(html).toContain('<details class="task-diagnostics">');
  expect(html).not.toContain('<details class="task-diagnostics" open');
});
