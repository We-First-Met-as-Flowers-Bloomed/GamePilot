import { expect, it } from "vitest";
import type {
  GoalRun,
  GoalRequestResult,
} from "../packages/protocol/agent-goal";
import { goalMatrix } from "../apps/desktop/renderer/goal-matrix-state";

const scope = {
  laneId: "lane-a",
  gameId: "onmyoji",
  skillIds: ["mail", "award"],
  resources: {},
};
function goal(requests: GoalRequestResult[] = []): GoalRun {
  return {
    status: "unknown",
    goalSatisfied: null,
    grant: { scopes: [scope] },
    requests,
  } as GoalRun;
}
function request(
  overrides: Partial<GoalRequestResult> = {},
): GoalRequestResult {
  return {
    requestId: "original:lane-a",
    laneId: "lane-a",
    gameId: "onmyoji",
    status: "succeeded",
    flowComplete: true,
    goalSatisfied: true,
    skills: scope.skillIds.map((skillId) => ({
      skillId,
      status: "succeeded",
      goalSatisfied: true,
      summary: "宿主核验",
    })),
    ...overrides,
  };
}
const cell = (value: GoalRun) => goalMatrix(value).rows[0].cells[0];
it("counts only actual host skills and preserves scoped and request IDs", () => {
  expect(cell(goal())).toMatchObject({
    tone: "unknown",
    verified: 0,
    total: 2,
    skillIds: ["mail", "award"],
  });
  expect(cell(goal([request()]))).toMatchObject({
    tone: "verified",
    verified: 2,
    requestIds: ["original:lane-a"],
  });
});
it("shows partial proof without promoting an unknown cell", () => {
  const value = cell(goal([request({ skills: [request().skills[0]] })]));
  expect(value).toMatchObject({ tone: "unknown", verified: 1, total: 2 });
});
it("does not guess game or account bindings from skill names", () => {
  expect(cell(goal([request({ gameId: undefined })])).verified).toBe(0);
  expect(cell(goal([request({ laneId: undefined })])).verified).toBe(0);
  expect(cell(goal([request({ gameId: "arknights" })])).verified).toBe(0);
  const exact = request({ gameId: undefined });
  exact.skills.forEach((skill) => {
    skill.gameId = "onmyoji";
  });
  expect(cell(goal([exact])).verified).toBe(2);
});
it("keeps duplicated or contradictory results unconfirmed", () => {
  expect(cell(goal([request(), request()]))).toMatchObject({
    tone: "unknown",
    verified: 0,
  });
  const conflicting = request();
  conflicting.skills[0].gameId = "arknights";
  expect(cell(goal([conflicting]))).toMatchObject({
    tone: "unknown",
    verified: 1,
  });
  conflicting.skills[0].gameId = "onmyoji";
  conflicting.skills[0].status = "failed";
  expect(cell(goal([conflicting]))).toMatchObject({
    tone: "unknown",
    verified: 1,
  });
});
it("retains the original scopes even after a narrower recovery review", () => {
  const value = goal([request()]);
  value.originalReview = { scopes: [scope] } as any;
  value.review = { scopes: [{ ...scope, skillIds: ["award"] }] } as any;
  expect(cell(value).total).toBe(2);
});
it("uses failure proof and keeps waiting neutral", () => {
  const failed = request();
  failed.skills[0].status = "failed";
  failed.skills[0].goalSatisfied = false;
  expect(cell(goal([failed])).tone).toBe("failed");
  const waiting = goal();
  waiting.status = "waiting";
  expect(cell(waiting)).toMatchObject({ tone: "waiting", verified: 0 });
});
it("does not trust goal status, native flow or result prose", () => {
  const value = goal([request({ skills: [] })]);
  value.status = "completed";
  value.goalSatisfied = true;
  value.flowComplete = true;
  value.message = "全部游戏已完成";
  expect(cell(value)).toMatchObject({ tone: "unknown", verified: 0 });
});
it("keeps ambiguous repeated scoped steps and another account out of verified progress", () => {
  const value = goal([request()]);
  value.grant.scopes = [{ ...scope, skillIds: ["mail", "mail"] }];
  expect(cell(value)).toMatchObject({ tone: "unknown", verified: 0, total: 2 });
  expect(cell(goal([request({ laneId: "lane-b" })]))).toMatchObject({
    tone: "unknown",
    verified: 0,
  });
});
it("does not infer a failed step from a false request or a skipped skill", () => {
  const value = request({ status: "failed", goalSatisfied: false });
  value.skills = [
    {
      skillId: "mail",
      status: "skipped",
      goalSatisfied: null,
      summary: "原生流程失败但业务结果未确认",
    },
  ];
  expect(cell(goal([value]))).toMatchObject({ tone: "unknown", verified: 0 });
});
it("counts host-verified satisfied skipped steps without treating unknown skips as complete", () => {
  const value = request();
  value.skills.forEach((skill) => {
    skill.status = "skipped";
  });
  expect(cell(goal([value]))).toMatchObject({ tone: "verified", verified: 2 });
  value.skills[0].goalSatisfied = null;
  expect(cell(goal([value]))).toMatchObject({ tone: "unknown", verified: 1 });
});
