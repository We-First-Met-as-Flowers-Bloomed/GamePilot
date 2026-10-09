import { expect, it } from "vitest";
import type { GoalRun } from "../packages/protocol/agent-goal";
import { goalResultReport } from "../games/goal-report";

const at = "2026-10-07T01:00:00.000Z";
function goal(): GoalRun {
  const scopes = [
    {
      laneId: "lane-a",
      gameId: "onmyoji",
      skillIds: ["mail", "hana-claim"],
      resources: {},
    },
  ];
  const review = {
    id: "review-a",
    fingerprint: "proof-a",
    reviewedAt: at,
    expiresAt: at,
    frozenPlan: { kind: "custom" as const, hash: "hash-a" },
    scopes,
    summary: [],
  };
  return {
    version: 1,
    id: "goal-a",
    revision: 1,
    sessionId: "session-a",
    turnId: "turn-a",
    prompt: "领取邮件和花合战",
    selection: { kind: "custom" },
    grant: {
      id: "grant-a",
      source: "user-message",
      sessionId: "session-a",
      turnId: "turn-a",
      issuedAt: at,
      expiresAt: "2026-10-07T07:00:00.000Z",
      maxRetries: 2,
      scopes,
    },
    createdAt: at,
    updatedAt: at,
    status: "completed",
    message: "所有日常已完成（不可用作证据）",
    originalReview: review,
    attempts: [
      {
        review,
        submission: {
          batchId: "batch-a",
          requestIds: ["batch-a:lane-a"],
          attempt: 1,
          acceptedAt: at,
          state: "received",
        },
      },
    ],
    retryCount: 0,
    requests: [
      {
        requestId: "batch-a:lane-a",
        laneId: "lane-a",
        gameId: "onmyoji",
        status: "succeeded",
        flowComplete: true,
        goalSatisfied: true,
        skills: ["mail", "hana-claim"].map((skillId) => ({
          skillId,
          gameId: "onmyoji",
          status: "succeeded",
          goalSatisfied: true,
          evidenceTimestamp: at,
          evidenceReference: "run-a:" + skillId,
          summary: "已确认",
        })),
      },
    ],
    flowComplete: true,
    goalSatisfied: true,
  };
}
it("limits a daily continuation report to its adopted account and preserves other-account uncertainty", () => {
  const g = goal();
  g.selection = {
    kind: "continuation",
    parentRequestId: "scheduled:lane-a",
    parentFingerprint: "a".repeat(64),
    laneIds: ["lane-a"],
  };
  g.originalReview!.summary = [{ laneName: "账号一", games: [] }];
  const text = goalResultReport(g).text;
  expect(text).toContain("账号一");
  expect(text).toContain("其他账号");
  expect(text).toContain("未在本次启动或核验");
  expect(text).not.toContain("两个账号已完成");
});
it("reports only the exact requested work, never expands a subset into all dailies", () => {
  const report = goalResultReport(goal());
  expect(report.outcome).toBe("completed");
  expect(report.counts).toMatchObject({ total: 2, completed: 2 });
  expect(report.text).toContain("本次交办的 2 项任务已核验完成");
  expect(report.text).not.toContain("所有日常");
});
it("does not trust a completed flag when a required step has no result proof", () => {
  const g = goal();
  g.requests[0].skills.pop();
  const report = goalResultReport(g);
  expect(report.outcome).toBe("unknown");
  expect(report.counts).toMatchObject({ completed: 1, unknown: 1 });
  expect(report.text).toContain("结果未完整确认");
  expect(report.text).not.toContain("2 项任务已核验完成");
});
it("rejects unrelated requests, future evidence, and skipped assertions as completion", () => {
  for (const change of [
    (g: GoalRun) => {
      g.requests[0].requestId = "foreign";
    },
    (g: GoalRun) => {
      g.requests[0].skills[0].evidenceTimestamp = "2026-10-08T01:00:00.000Z";
    },
    (g: GoalRun) => {
      g.requests[0].skills[0].status = "skipped";
      g.requests[0].skills[0].goalSatisfied = false;
    },
  ]) {
    const g = goal();
    change(g);
    expect(goalResultReport(g).outcome).not.toBe("completed");
  }
});
it("keeps both lanes accountable and uses the latest accepted continuation per lane", () => {
  const g = goal();
  const b = { ...g.grant.scopes[0], laneId: "lane-b" };
  g.grant.scopes.push(b);
  g.originalReview!.scopes = [...g.grant.scopes];
  g.attempts[0].review.scopes = [...g.grant.scopes];
  g.attempts[0].submission.requestIds.push("batch-a:lane-b");
  const continued = structuredClone(g.attempts[0]);
  continued.review.scopes = [g.grant.scopes[0]];
  continued.submission = {
    ...continued.submission,
    batchId: "batch-next",
    requestIds: ["batch-next:lane-a"],
    attempt: 2,
  };
  g.attempts.push(continued);
  expect(goalResultReport(g).counts.completed).toBe(0);
  g.requests.push({
    ...structuredClone(g.requests[0]),
    requestId: "batch-next:lane-a",
  });
  expect(goalResultReport(g).counts).toMatchObject({
    total: 4,
    completed: 2,
    unknown: 2,
  });
  expect(goalResultReport(g).outcome).toBe("unknown");
});
it("shows confirmed business effects separately from a failed navigation and never recommends replay", () => {
  const g = goal();
  g.status = "needs-user";
  g.goalSatisfied = false;
  g.flowComplete = false;
  g.requests[0].status = "failed";
  g.requests[0].flowComplete = false;
  g.requests[0].goalSatisfied = false;
  g.requests[0].skills[1] = {
    ...g.requests[0].skills[1],
    status: "failed",
    goalSatisfied: false,
    effectEvidence: [
      {
        kind: "hana-claim",
        observedAt: at,
        evidenceReference: "run-a:claimed",
        summary: "花合战奖励领取已确认",
      },
    ],
  };
  const report = goalResultReport(g);
  expect(report.outcome).toBe("needs-user");
  expect(report.counts).toMatchObject({ completed: 1, failed: 1 });
  expect(report.text).toContain("业务效果已确认");
  expect(report.text).toContain("不能据此重复领取或提交");
  expect(report.text).not.toContain("2 项任务已核验完成");
});
it("keeps excluded/cancelled work incomplete and withholds effects without valid references", () => {
  const g = goal();
  g.status = "cancelled";
  g.goalSatisfied = null;
  g.requests[0].skills[1] = {
    ...g.requests[0].skills[1],
    status: "excluded",
    goalSatisfied: false,
    effectEvidence: [
      {
        kind: "hana-reward",
        observedAt: at,
        evidenceReference: "",
        summary: "虚构完成",
      },
    ],
  };
  const report = goalResultReport(g);
  expect(report.outcome).toBe("cancelled");
  expect(report.counts.cancelled).toBe(1);
  expect(report.text).not.toContain("虚构完成");
});
it("does not claim an accepted running request stopped merely because a snapshot says cancelled", () => {
  const g = goal();
  g.status = "cancelled";
  g.goalSatisfied = null;
  g.requests[0].status = "running";
  const report = goalResultReport(g);
  expect(report.outcome).toBe("unknown");
  expect(report.text).toContain("停止结果未确认");
  expect(report.text).not.toContain("任务已停止");
});

function completedMailAndHana(): GoalRun {
  const g = goal();
  const scope = g.grant.scopes[0];
  scope.laneId = "lane-b";
  scope.skillIds = ["login", "mail", "hana-claim"];
  g.attempts[0].submission.requestIds = ["batch-a:lane-b"];
  g.requests[0].requestId = "batch-a:lane-b";
  g.requests[0].laneId = "lane-b";
  g.requests[0].skills = [
    {
      skillId: "login",
      gameId: "onmyoji",
      status: "succeeded",
      goalSatisfied: true,
      evidenceTimestamp: at,
      evidenceReference: "onmyoji:login:two-frames",
      summary: "do not trust arbitrary prose",
    },
    {
      skillId: "mail",
      gameId: "onmyoji",
      status: "succeeded",
      goalSatisfied: true,
      evidenceTimestamp: at,
      evidenceReference: "onmyoji:mail:reward-and-empty-mailbox",
      summary: "invented 999 rewards",
      effectEvidence: [
        {
          kind: "mail-claim",
          observedAt: at,
          evidenceReference: "onmyoji:mail:effect:1",
          summary: "invented 999 rewards",
        },
      ],
    },
    {
      skillId: "hana-claim",
      gameId: "onmyoji",
      status: "skipped",
      skipReason: "nothing-to-claim",
      goalSatisfied: true,
      evidenceTimestamp: at,
      evidenceReference: "onmyoji:hana-claim:verified-no-pending-reward",
      summary: "invented successful claim",
      effectEvidence: [
        {
          kind: "hana-claim",
          observedAt: at,
          evidenceReference: "onmyoji:hana-claim:effect:1",
          summary: "invented successful claim",
        },
      ],
    },
  ];
  return g;
}

it("answers the real completed B mail and hana result with received versus nothing-to-claim and login identity limits", () => {
  const g = completedMailAndHana();
  const before = structuredClone(g);
  const report = goalResultReport(g);
  expect(report.outcome).toBe("completed");
  expect(report.counts).toMatchObject({ total: 3, completed: 3 });
  expect(report.text).toContain(
    "账号二 · 阴阳师 · 邮件附件：本次已领取邮件附件，已核对无剩余待领取附件",
  );
  expect(report.text).toContain(
    "账号二 · 阴阳师 · 花合战奖励：本次检查无待领取奖励，未执行领取",
  );
  expect(report.text).toContain("当前角色身份未作独立核验");
  expect(report.text).not.toContain("invented");
  expect(report.text).not.toContain("999");
  expect(g).toEqual(before);
});

it("keeps each account's different claim results separate", () => {
  const g = completedMailAndHana();
  const a = structuredClone(g.grant.scopes[0]);
  a.laneId = "lane-a";
  g.grant.scopes.unshift(a);
  g.attempts[0].submission.requestIds.unshift("batch-a:lane-a");
  const request = structuredClone(g.requests[0]);
  request.requestId = "batch-a:lane-a";
  request.laneId = "lane-a";
  request.skills[1].status = "skipped";
  request.skills[1].skipReason = "nothing-to-claim";
  request.skills[1].evidenceReference = "onmyoji:mail:verified-empty";
  request.skills[2].status = "succeeded";
  delete request.skills[2].skipReason;
  g.requests.unshift(request);
  const report = goalResultReport(g);
  expect(report.text).toContain(
    "账号一 · 阴阳师 · 邮件附件：本次检查无待领取附件，未执行领取",
  );
  expect(report.text).toContain(
    "账号一 · 阴阳师 · 花合战奖励：本次已领取花合战奖励，已核对无剩余待领取奖励",
  );
  expect(report.text).toContain(
    "账号二 · 阴阳师 · 邮件附件：本次已领取邮件附件",
  );
  expect(report.text).toContain(
    "账号二 · 阴阳师 · 花合战奖励：本次检查无待领取奖励",
  );
  expect(report.counts).toMatchObject({ total: 6, completed: 6 });
});

it("does not borrow another account's completed mail when this account has no matching result", () => {
  const g = completedMailAndHana();
  const a = structuredClone(g.grant.scopes[0]);
  a.laneId = "lane-a";
  g.grant.scopes.unshift(a);
  g.attempts[0].submission.requestIds.unshift("batch-a:lane-a");
  const report = goalResultReport(g);
  expect(report.text).toContain("账号一 · 阴阳师 · 邮件附件：未确认");
  expect(report.text).not.toContain("账号一 · 阴阳师 · 邮件附件：本次已领取");
  expect(report.text).toContain("账号二 · 阴阳师 · 邮件附件：本次已领取");
  expect(report.outcome).toBe("unknown");
});

it.each([
  "missing-effect",
  "wrong-kind",
  "wrong-effect-reference",
  "future-effect",
  "effect-after-step",
  "duplicate-effect",
  "mixed-effect",
  "duplicate-skill",
  "wrong-reference",
  "conflicting-skip",
  "wrong-game",
])(
  "does not infer actual claims from prose or inconsistent structured evidence: %s",
  (kind) => {
    const g = completedMailAndHana();
    const mail = g.requests[0].skills[1];
    if (kind === "missing-effect") delete mail.effectEvidence;
    if (kind === "wrong-kind") mail.effectEvidence![0].kind = "hana-claim";
    if (kind === "wrong-effect-reference")
      mail.effectEvidence![0].evidenceReference = "onmyoji:hana-claim:effect:1";
    if (kind === "future-effect")
      mail.effectEvidence![0].observedAt = "2026-10-08T01:00:00Z";
    if (kind === "effect-after-step") {
      g.updatedAt = "2026-10-07T02:00:00Z";
      mail.effectEvidence![0].observedAt = "2026-10-07T01:30:00Z";
    }
    if (kind === "duplicate-effect")
      mail.effectEvidence!.push(structuredClone(mail.effectEvidence![0]));
    if (kind === "mixed-effect")
      mail.effectEvidence!.push({
        ...mail.effectEvidence![0],
        kind: "hana-claim",
      });
    if (kind === "duplicate-skill")
      g.requests[0].skills.push(structuredClone(mail));
    if (kind === "wrong-reference")
      mail.evidenceReference = "arbitrary-completion-prose";
    if (kind === "conflicting-skip") mail.skipReason = "nothing-to-claim";
    if (kind === "wrong-game") mail.gameId = "arknights";
    const text = goalResultReport(g).text;
    expect(text).not.toContain("本次已领取邮件附件");
    expect(text).not.toContain("invented");
  },
);
