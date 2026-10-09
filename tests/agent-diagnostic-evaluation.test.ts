import { expect, it } from "vitest";
import { incidentEvaluationCases } from "../games/agent-incident-evaluation";
import { evaluationSnapshot } from "../packages/agent/evaluation/fixtures";
import { judgeResult, resultDigest } from "../packages/agent/evaluation/judge";
import { createAgentTools } from "../packages/agent/tools";
import { PlannerSession } from "../packages/agent/planner";
import type { PlannerResult } from "../packages/protocol/agent-planner";
function response(index = 0, minimal = false): PlannerResult {
  const test = incidentEvaluationCases[index],
    tools = createAgentTools(evaluationSnapshot(test));
  const session = new PlannerSession(tools, test.at);
  session.call("catalog", "list_capabilities", {});
  const env = JSON.parse(
    session.call("env", "get_environment", {}).contentItems[0].text,
  );
  for (const id of test.diagnostic!.requests) {
    if (minimal && !test.diagnostic!.incidentRequests?.includes(id))
      session.call(id, "get_run", { requestId: id });
    else
      session.call(id, "get_incident", {
        requestId: id,
        environmentRevision: env.revision,
      });
  }
  return {
    ...session.finish(
      JSON.stringify({
        kind: "answer",
        text: "测试说明，未运行游戏。",
        planHash: null,
      }),
    ),
    model: "fixture",
    codexVersion: "test",
    elapsedMs: 1,
  };
}
it("provides eight deterministic isolated diagnosis cases with structurally bound host evidence", () => {
  expect(incidentEvaluationCases).toHaveLength(8);
  for (const [index, test] of incidentEvaluationCases.entries()) {
    expect(resultDigest(evaluationSnapshot(test))).toBe(
      resultDigest(evaluationSnapshot(test)),
    );
    const result = response(index);
    expect(judgeResult(test, result)).toEqual({
      status: "needs-review",
      failures: [],
    });
    expect(result.incidents?.length).toBe(test.diagnostic?.requests.length);
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE|111111111|222222222|MuMuManager.exe|data:image/,
    );
  }
});
it("rejects absent, duplicated, forged and cross-case incident evidence despite plausible model text", () => {
  const test = incidentEvaluationCases[0];
  for (const mutate of [
    (r: PlannerResult) => {
      r.incidents = [];
    },
    (r: PlannerResult) => {
      r.incidents!.push(structuredClone(r.incidents![0]));
    },
    (r: PlannerResult) => {
      r.incidents![0].run.startupFault!.code = "mumu-boot-timeout";
    },
    (r: PlannerResult) => {
      r.records![0].recordedConclusion = "recorded-plan-complete";
    },
    (r: PlannerResult) => {
      r.trace.push({ callId: "compile", tool: "compile_plan", success: false });
    },
    (r: PlannerResult) => {
      r.source = "fixture";
    },
  ]) {
    const value = response();
    mutate(value);
    expect(judgeResult(test, value).status).toBe("failed");
  }
  expect(judgeResult(test, response(1)).status).toBe("failed");
});
it("distinguishes stored historical captures, watchdog noncapture, missing association and older other-account success", () => {
  expect(response(2).incidents![0].faults[0]).toMatchObject({
    code: "foster-return-failed",
    captureStatus: "stored",
    imageSent: false,
  });
  expect(response(3).incidents![0].faults[0]).toMatchObject({
    source: "watchdog",
    captureStatus: "not-attempted",
  });
  expect(response(4).incidents![0].faults).toEqual([]);
  const mixed = response(5).records!;
  expect(mixed[0]).toMatchObject({
    laneId: "lane-a",
    recordedConclusion: "unknown",
  });
  expect(mixed[1]).toMatchObject({
    laneId: "lane-b",
    recordedConclusion: "recorded-plan-complete",
  });
  expect(mixed[1].tasks[0].gameDay).toBe("2026-09-25");
  expect(response(6).records![0]).toMatchObject({
    complete: false,
    recordedConclusion: "unknown",
  });
});
it("accepts record queries for non-failure targets but still demands the failed account's incident bundle", () => {
  for (const index of [5, 6])
    expect(
      judgeResult(incidentEvaluationCases[index], response(index, true)).status,
    ).toBe("needs-review");
  const value = response(5, true);
  value.incidents = [];
  expect(judgeResult(incidentEvaluationCases[5], value).status).toBe("failed");
  const missing = response(6, true);
  missing.records = [];
  expect(judgeResult(incidentEvaluationCases[6], missing).status).toBe(
    "failed",
  );
});
