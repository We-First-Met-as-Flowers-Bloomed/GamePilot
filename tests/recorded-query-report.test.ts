import { describe, expect, it } from "vitest";
import type { AgentRunSummary } from "../packages/protocol/agent";
import type { ExecutionProgress } from "../packages/protocol/execution-progress";
import { recordedQueryReport } from "../games/recorded-query-report";

function record(
  requestId: string,
  overrides: Partial<AgentRunSummary> = {},
): AgentRunSummary {
  return {
    requestId,
    laneId: "lane-a",
    requestSource: "daily",
    recordedStatus: "succeeded",
    recordedConclusion: "recorded-plan-complete",
    startedAt: "2026-10-07T04:00:00.000Z",
    finishedAt: "2026-10-07T04:01:00.000Z",
    complete: true,
    inGameCompletion: "not-verified",
    tasks: [
      {
        runId: `${requestId}:arknights`,
        gameId: "arknights",
        gameDay: "2026-10-07",
        mode: "live",
        status: "succeeded",
        steps: [{ skillId: "login", status: "succeeded" }],
      },
    ],
    warnings: [],
    notes: [],
    ...overrides,
  };
}

function progress(
  requestId: string,
  steps: ExecutionProgress["steps"],
): ExecutionProgress {
  return {
    version: 1,
    requestId,
    rootId: requestId,
    latestId: requestId,
    laneId: "lane-a",
    source: "daily",
    originalStatus: "cancelled",
    outcome: "unconfirmed",
    wholePlanComplete: false,
    startedAt: "2026-10-07T05:00:00.000Z",
    requests: [],
    steps,
    counts: {
      total: steps.length,
      completed: 0,
      skipped: 0,
      excluded: 0,
      remaining: steps.length,
    },
    warnings: [],
  };
}

describe("host recorded query report", () => {
  it("answers from each account and game's exact recorded steps and Beijing time", () => {
    const text = recordedQueryReport([
      record("a", {
        tasks: [
          {
            runId: "a:o",
            gameId: "onmyoji",
            gameDay: "2026-10-07",
            mode: "live",
            status: "failed",
            steps: [
              { skillId: "check-in", status: "succeeded" },
              { skillId: "mail", status: "skipped" },
              { skillId: "daily-gift", status: "failed" },
              { skillId: "hana-claim", status: "not-run" },
              { skillId: "realm-raid", status: "unknown" },
            ],
          },
        ],
        recordedStatus: "failed",
      }),
      record("b", {
        laneId: "lane-b",
        requestSource: "single",
        tasks: [
          {
            runId: "b:a",
            gameId: "arknights",
            mode: "live",
            status: "succeeded",
            steps: [{ skillId: "award", status: "succeeded" }],
          },
        ],
      }),
    ]);
    expect(text).toContain("账号一 · 阴阳师");
    expect(text).toContain("账号二 · 明日方舟");
    expect(text).toContain("2026-10-07 12:00:00");
    expect(text).toContain("2026-10-07 12:01:00");
    expect(text).toContain("流程完成：每日签到");
    expect(text).toContain("跳过：邮件附件");
    expect(text).toContain("失败：每日礼包");
    expect(text).toContain("未执行：花合战奖励");
    expect(text).toContain("未知：地域鬼王");
    expect(text).toContain("原范围：领取任务奖励");
    expect(text).toContain("历史记录");
    expect(text).toContain("非当前现场");
    expect(text).toContain("不代表当天全部日常或具体奖励已完成");
    expect(text).not.toMatch(/邮件已领取|今天全部完成|账号.*已全部完成/);
  });

  it("keeps a newer cancellation ahead of older success, independently of input order", () => {
    const older = record("old", {
      tasks: [
        {
          runId: "old:a",
          gameId: "arknights",
          mode: "live",
          status: "succeeded",
          steps: [
            { skillId: "login", status: "succeeded" },
            { skillId: "recruit", status: "succeeded" },
          ],
        },
      ],
    });
    const newer = record("new", {
      startedAt: "2026-10-07T05:00:00.000Z",
      finishedAt: "2026-10-07T05:01:00.000Z",
      recordedStatus: "cancelled",
      recordedConclusion: "unknown",
      complete: false,
      warnings: ["部分记录缺失"],
      tasks: [
        {
          runId: "new:a",
          gameId: "arknights",
          mode: "live",
          status: "cancelled",
          steps: [{ skillId: "login", status: "cancelled" }],
        },
      ],
    });
    const text = recordedQueryReport([older, newer]);
    expect(text).toContain("原请求已取消");
    expect(text).toContain("取消：启动与上号");
    expect(text).toContain("记录关联不完整");
    expect(text).toContain("较早记录");
    expect(text).toContain("流程完成：启动与上号、保守自动公招");
    expect(text.indexOf("2026-10-07 13:00:00")).toBeLessThan(
      text.indexOf("2026-10-07 12:00:00"),
    );
    expect(recordedQueryReport([newer, older])).toBe(text);
  });

  it("retains a missing game's latest original plan instead of substituting its earlier success", () => {
    const old = record("old", {
      tasks: [
        {
          runId: "old:o",
          gameId: "onmyoji",
          mode: "live",
          status: "succeeded",
          steps: [{ skillId: "mail", status: "succeeded" }],
        },
      ],
    });
    const newer = record("new", {
      startedAt: "2026-10-07T05:00:00.000Z",
      recordedStatus: "cancelled",
      complete: false,
      recordedProgress: progress("new", [
        {
          gameId: "arknights",
          skillId: "login",
          status: "cancelled",
          sourceId: "new",
          continued: false,
        },
        {
          gameId: "onmyoji",
          skillId: "mail",
          status: "unknown",
          sourceId: "new",
          continued: false,
        },
      ]),
    });
    const text = recordedQueryReport([old, newer]);
    const onmyoji = text.slice(text.indexOf("账号一 · 阴阳师"));
    expect(onmyoji).toContain("原范围：邮件附件");
    expect(onmyoji).toContain("游戏任务记录缺失");
    expect(onmyoji).toContain("未知：邮件附件");
    expect(onmyoji).toContain("较早记录");
    expect(onmyoji.indexOf("未知：邮件附件")).toBeLessThan(
      onmyoji.indexOf("流程完成：邮件附件"),
    );
    expect(onmyoji).not.toContain("未执行：邮件附件");
  });

  it("does not expand a single login flow or rehearsal success into daily completion", () => {
    const text = recordedQueryReport([
      record("live"),
      record("rehearsal", {
        laneId: "lane-b",
        tasks: [
          {
            runId: "rehearsal:a",
            gameId: "arknights",
            mode: "rehearsal",
            status: "succeeded",
            steps: [{ skillId: "award", status: "succeeded" }],
          },
        ],
      }),
    ]);
    expect(text).toContain("原范围：启动与上号");
    expect(text).toContain("演练记录");
    expect(text).toContain("演练流程完成：领取任务奖励");
    expect(text).not.toContain("日常已完成");
    expect(text).not.toContain("奖励已领取");
  });

  it("uses the original progress scope for retained and excluded steps without rewriting failure", () => {
    const original = record("original", {
      recordedStatus: "failed",
      tasks: [
        {
          runId: "original:o",
          gameId: "onmyoji",
          mode: "live",
          status: "failed",
          steps: [{ skillId: "mail", status: "failed" }],
        },
      ],
      recordedProgress: {
        ...progress("original", [
          {
            gameId: "onmyoji",
            skillId: "mail",
            status: "succeeded",
            sourceId: "retry",
            continued: true,
          },
          {
            gameId: "onmyoji",
            skillId: "hana-claim",
            status: "excluded",
            sourceId: "original",
            continued: false,
          },
        ]),
        latestId: "retry",
        outcome: "partial",
      },
    });
    const text = recordedQueryReport([original]);
    expect(text).toContain("原请求失败");
    expect(text).toContain("原范围：邮件附件、花合战奖励");
    expect(text).toContain("流程完成：邮件附件");
    expect(text).toContain("未选续跑：花合战奖励");
    expect(text).toContain("含关联续跑记录，原请求结果保留");
    expect(text).not.toContain("失败：邮件附件");
  });

  it("does not infer no execution from empty scope or merge unidentified accounts", () => {
    const text = recordedQueryReport([
      record("empty", { laneId: undefined, tasks: [] }),
      record("another", { laneId: undefined }),
    ]);
    expect(text).toContain("账号未知");
    expect(text).toContain("empty");
    expect(text).toContain("another");
    expect(text).toContain("原范围未知");
    expect(text).toContain("结果未知");
    expect(text).not.toContain("本轮未执行");
    expect(recordedQueryReport([])).toContain("尚未读取到可核对的历史记录");
  });

  it("shows undated records as unknown chronology and rejects a fabricated civil-time override", () => {
    const text = recordedQueryReport([
      record("known"),
      record("undated", {
        startedAt: "2026-02-30T09:00:00Z",
        finishedAt: undefined,
        recordedTime: {
          timeZone: "Asia/Shanghai",
          startedAt: "2099-01-01 12:00:00",
        },
        recordedStatus: "unknown",
        tasks: [],
      }),
    ]);
    expect(text).toContain("记录时间未知");
    expect(text).toContain("无法确定先后");
    expect(text).not.toContain("2099-01-01");
    expect(text).not.toContain("2026-03-02");
  });

  it("reports duplicate skill or game associations as unknown rather than choosing success", () => {
    const duplicate = record("duplicate", {
      tasks: [
        {
          runId: "duplicate:1",
          gameId: "onmyoji",
          mode: "live",
          status: "succeeded",
          steps: [{ skillId: "mail", status: "succeeded" }],
        },
        {
          runId: "duplicate:2",
          gameId: "onmyoji",
          mode: "live",
          status: "failed",
          steps: [{ skillId: "mail", status: "failed" }],
        },
      ],
    });
    const text = recordedQueryReport([duplicate]);
    expect(text).toContain("游戏任务记录重复");
    expect(text).toContain("未知：邮件附件");
    expect(text).not.toContain("流程完成：邮件附件");
    const steps = recordedQueryReport([
      record("duplicate-steps", {
        tasks: [
          {
            runId: "duplicate-steps:o",
            gameId: "onmyoji",
            mode: "live",
            status: "succeeded",
            steps: [
              { skillId: "mail", status: "succeeded" },
              { skillId: "mail", status: "failed" },
            ],
          },
        ],
      }),
    ]);
    expect(steps).toContain("未知：邮件附件");
    expect(steps).not.toContain("流程完成：邮件附件");
  });

  it("does not treat contradictory finish time as reliable or conceal a partial continuation ledger", () => {
    const text = recordedQueryReport([
      record("times", {
        finishedAt: "2026-10-07T03:00:00.000Z",
        recordedProgress: {
          ...progress("times", [
            {
              gameId: "arknights",
              skillId: "login",
              status: "succeeded",
              sourceId: "times",
              continued: false,
            },
          ]),
          warnings: ["续跑关联不可靠"],
        },
      }),
    ]);
    expect(text).toContain("结束时间不可核对");
    expect(text).toContain("关联进度不完整");
    expect(text).not.toContain("2026-10-07 11:00:00");
  });

  it("labels a descendant's reconstructed original scope and names the original request", () => {
    const text = recordedQueryReport([
      record("retry", {
        recordedProgress: {
          ...progress("retry", [
            {
              gameId: "arknights",
              skillId: "recruit",
              status: "succeeded",
              sourceId: "original",
              continued: false,
            },
          ]),
          rootId: "original",
          latestId: "retry",
        },
      }),
    ]);
    expect(text).toContain("关联原计划范围（original）");
    expect(text).toContain("保守自动公招");
  });

  it("bounds groups and preserves the history boundary without changing trusted inputs", () => {
    const records = Array.from({ length: 20 }, (_, i) =>
      record(`request-${i}`, { laneId: `lane-${i}` }),
    );
    const before = JSON.stringify(records);
    const text = recordedQueryReport(records);
    expect(text.match(/ · 明日方舟/g)).toHaveLength(8);
    expect(text).toContain("另有 12 组记录未展开");
    expect(text.length).toBeLessThanOrEqual(8000);
    expect(text).toContain("非当前现场");
    expect(JSON.stringify(records)).toBe(before);
  });
});
