import { describe, expect, it } from "vitest";
import {
  recordedDailyQueryScopes,
  type DailyQueryEnvironment,
} from "../games/recorded-daily-query";
import { recordedDailyQueryReport } from "../games/recorded-query-report";
import type { AgentRunSummary } from "../packages/protocol/agent";
import realResult from "./fixtures/agent/recorded-daily-20261009.json";

const at = "2026-10-09T10:00:00Z";
const prompt =
  "今天两个账号的明日方舟日常完成了吗？阴阳师有什么没做完？只查看结果，不启动任务。";
function run(
  id = "daily",
  day = "2026-10-09",
  skills = ["login", "fight"],
): AgentRunSummary {
  return {
    requestId: id,
    laneId: "lane-a",
    requestSource: "daily",
    recordedStatus: "succeeded",
    recordedConclusion: "recorded-plan-complete",
    startedAt: `${day}T04:00:00Z`,
    finishedAt: `${day}T05:00:00Z`,
    complete: true,
    inGameCompletion: "not-verified",
    warnings: [],
    notes: [],
    tasks: [
      {
        runId: id,
        gameId: "arknights",
        gameDay: day,
        finishedGameDay: day,
        mode: "live",
        status: "succeeded",
        steps: skills.map((skillId) => ({ skillId, status: "succeeded" })),
      },
    ],
  };
}
function environment(records: AgentRunSummary[]): DailyQueryEnvironment {
  return {
    source: "recorded",
    historyAvailable: true,
    lanes: ["lane-a", "lane-b"].map((id) => ({
      id,
      enabled: true,
      games: {
        arknights: { enabled: true, defaultSkillIds: ["login", "fight"] },
        onmyoji: { enabled: true, defaultSkillIds: ["login", "mail"] },
      },
      recordedRequests: records
        .filter((record) => record.laneId === id)
        .map((record) => ({
          id: record.requestId,
          requestSource: record.requestSource,
          startedAt: record.startedAt,
          progress: { tasks: record.tasks },
        })),
    })),
  };
}
function report(records: AgentRunSummary[], message = prompt, now = at) {
  const scopes = recordedDailyQueryScopes(message, environment(records), now)!;
  return { scopes, text: recordedDailyQueryReport(records, scopes, now) };
}
describe("current game-day recorded queries", () => {
  it("reports the real successful child request independently from its unconfirmed ancestor chain", () => {
    const records = structuredClone(realResult.records) as AgentRunSummary[];
    const original = structuredClone(records);
    const env = environment(records);
    for (const lane of env.lanes) {
      lane.games.arknights.defaultSkillIds = [
        "login",
        "recruit",
        "fight",
        "infrastructure",
        "friends",
        "award",
      ];
      lane.games.onmyoji.defaultSkillIds = [
        "login",
        "check-in",
        "mail",
        "daily-gift",
        "guild-kirin",
        "realm-raid",
        "hana-claim",
      ];
    }
    const scopes = recordedDailyQueryScopes(
      realResult.prompt,
      env,
      realResult.at,
    )!;
    const text = recordedDailyQueryReport(records, scopes, realResult.at);
    expect(text.match(/今日所列任务流程已完成/g)).toHaveLength(2);
    const firstArk = text
      .split("账号一 · 明日方舟")[1]
      .split("账号一 · 阴阳师")[0];
    expect(firstArk).not.toContain("日期、关联或完成证据不完整");
    expect(firstArk).toContain("关联原计划是否补齐仍未确认");
    expect(firstArk).toContain(
      "流程完成：启动与上号、保守自动公招、理智作战、基建换班与收菜、好友与信用商店、领取任务奖励",
    );
    expect(text).toContain("跳过：每日礼包、地域鬼王、花合战奖励");
    expect(text).toContain("未知：启动与上号");
    expect(text).toContain(
      "未执行：每日签到、邮件附件、每日礼包、地域鬼王、花合战奖励",
    );
    expect(text).not.toContain("阴阳寮麒麟");
    expect(records).toEqual(original);
  });
  it.each([
    "incomplete",
    "own-warning",
    "missing-task",
    "duplicate-task",
    "cross-day",
    "unknown",
    "skipped",
  ])(
    "still refuses a %s task even if the parent progress claims completion",
    (kind) => {
      const record = structuredClone(realResult.records[0]) as AgentRunSummary;
      record.recordedProgress!.wholePlanComplete = true;
      record.recordedProgress!.warnings = [];
      const task = record.tasks.find((t) => t.gameId === "arknights")!;
      if (kind === "incomplete") record.complete = false;
      if (kind === "own-warning")
        record.warnings = ["原记录关联或原生证据不完整"];
      if (kind === "missing-task")
        record.tasks = record.tasks.filter((t) => t !== task);
      if (kind === "duplicate-task") record.tasks.push(structuredClone(task));
      if (kind === "cross-day") task.finishedGameDay = "2026-10-10";
      if (kind === "unknown" || kind === "skipped")
        task.steps.find((s) => s.skillId === "fight")!.status = kind;
      expect(
        report([record], realResult.prompt, realResult.at).text,
      ).not.toContain("今日所列任务流程已完成");
    },
  );
  it.each(["defaults", "routine"])(
    "uses the same Friday game calendar as execution for %s",
    (mode) => {
      const env = environment([]);
      for (const lane of env.lanes) {
        lane.games.onmyoji.defaultSkillIds = ["login", "mail", "guild-kirin"];
        if (mode === "routine")
          lane.games.onmyoji.routine = {
            version: 1,
            steps: [
              { skillId: "login", enabled: true },
              { skillId: "mail", enabled: true },
              { skillId: "guild-kirin", enabled: true },
            ],
          };
      }
      const friday = recordedDailyQueryScopes(prompt, env, at)!;
      expect(
        friday.filter((s) => s.gameId === "onmyoji").map((s) => s.skillIds),
      ).toEqual([
        ["login", "mail"],
        ["login", "mail"],
      ]);
      expect(recordedDailyQueryReport([], friday, at)).not.toContain(
        "阴阳寮麒麟",
      );
      const thursday = recordedDailyQueryScopes(
        prompt,
        env,
        "2026-10-08T10:00:00Z",
      )!;
      expect(thursday.find((s) => s.gameId === "onmyoji")?.skillIds).toContain(
        "guild-kirin",
      );
    },
  );
  it("keeps an actually recorded off-calendar step unknown instead of hiding its evidence", () => {
    const record = run();
    record.tasks[0].gameId = "onmyoji";
    record.tasks[0].steps = [
      { skillId: "login", status: "succeeded" },
      { skillId: "mail", status: "succeeded" },
      { skillId: "guild-kirin", status: "unknown" },
    ];
    const { text } = report([record]);
    expect(text).toContain("未知：阴阳寮麒麟");
    expect(text).not.toContain("今日所列任务流程已完成");
  });
  it("does not equate matching skill IDs in a single request with the full saved daily parameters", () => {
    const record = run();
    record.requestSource = "single";
    const { text } = report([record]);
    expect(text).toContain("今日所列任务流程已完成（仅覆盖所列原请求范围）");
    expect(text).toContain("不代表保存日常配置的全部次数均已执行");
    expect(text).not.toContain("保存范围内的今日日常流程已完成");
  });
  it("does not count old dates as today's completion or invent missing-account execution", () => {
    const { text, scopes } = report([run("old", "2026-10-08")]);
    expect(scopes).toHaveLength(4);
    expect(scopes.flatMap((scope) => scope.requestIds)).toEqual([]);
    expect(text).toContain("账号二 · 阴阳师");
    expect(text).toContain("日常完成状态未知");
    expect(text).not.toContain("任务流程已完成");
    expect(text).not.toContain("未执行：");
  });
  it("uses today's business record instead of a newer successful login", () => {
    const login = run("login", "2026-10-09", ["login"]);
    login.startedAt = "2026-10-09T08:00:00Z";
    const business = run();
    business.tasks[0].steps[1].status = "unknown";
    business.tasks[0].status = "unknown";
    const { text, scopes } = report([login, business]);
    expect(scopes[0].requestIds[0]).toBe("daily");
    expect(text).toContain("未知：理智作战");
    expect(text).not.toContain("任务流程已完成");
    expect(report([login]).text).toContain("仅有登录记录");
  });
  it("does not let a newer other-game request hide this game's daily business record", () => {
    const ark = run("ark");
    const yys = run("yys");
    yys.startedAt = "2026-10-09T08:00:00Z";
    yys.tasks[0].gameId = "onmyoji";
    yys.tasks[0].steps = [{ skillId: "login", status: "unknown" }];
    const { scopes, text } = report([yys, ark]);
    expect(scopes[0].requestIds).toEqual(["ark"]);
    expect(text).toContain("今日所列任务流程已完成");
  });
  it.each(["unknown", "skipped", "not-run", "failed", "cancelled"])(
    "keeps %s business unconfirmed while preserving another game's completed flow",
    (status) => {
      const record = run();
      record.tasks.push({
        runId: "yys",
        gameId: "onmyoji",
        gameDay: "2026-10-09",
        finishedGameDay: "2026-10-09",
        mode: "live",
        status: "unknown",
        steps: [
          { skillId: "login", status: "succeeded" },
          { skillId: "mail", status },
        ],
      });
      record.recordedStatus = "unknown";
      const { text } = report([record]);
      expect(text.match(/任务流程已完成/g)).toHaveLength(1);
      expect(text).toContain("今日日常尚未全部确认完成");
      expect(text).toContain("邮件附件");
    },
  );
  it("uses each game's reset day and refuses a record crossing its reset", () => {
    const { scopes } = report([], prompt, "2026-10-08T21:00:00Z");
    expect(scopes.slice(0, 2).map((scope) => scope.gameDay)).toEqual([
      "2026-10-09",
      "2026-10-08",
    ]);
    const record = run();
    record.tasks[0].finishedGameDay = "2026-10-10";
    expect(report([record]).text).not.toContain("任务流程已完成");
  });
  it("uses task game-day instead of the earlier request's day", () => {
    const record = run();
    record.startedAt = "2026-10-08T19:59:00Z";
    expect(report([record]).scopes[0].requestIds).toEqual(["daily"]);
  });
  it("keeps missing game's original daily request visible without declaring it not run", () => {
    const record = run();
    record.complete = false;
    record.warnings = ["missing game"];
    const { text, scopes } = report([record]);
    expect(scopes[1].requestIds).toEqual(["daily"]);
    expect(text).toContain("账号一 · 阴阳师");
    expect(text).toContain("未知：启动与上号、邮件附件");
    expect(text).not.toContain("未执行：");
  });
  it.each([
    "今天只查账号一的明日方舟日常，不查账号二，不查阴阳师。",
    "今天查账号一的明日方舟日常，账号二不要查，阴阳师也不要查。",
    "今天一号的明日方舟日常完成了吗？二号不要查。只看结果，不启动任务。",
    "今天只查账号一的明日方舟日常，无需查看阴阳师。",
    "今天只查账号一的明日方舟日常，无须查看阴阳师。",
  ])("preserves explicit query exclusions: %s", (message) => {
    const scopes = report([], message).scopes;
    expect(scopes.map((scope) => [scope.laneId, scope.gameId])).toEqual([
      ["lane-a", "arknights"],
    ]);
  });
  it("does not reinterpret another day, an explicit old goal, or a quoted example", () => {
    for (const message of [
      "昨天两个账号的日常完成了吗",
      "今天看看goal-old的日常结果",
      "解释‘今天两个账号的日常完成了吗’这个例子",
    ])
      expect(
        recordedDailyQueryScopes(message, environment([]), at),
      ).toBeUndefined();
  });
});
