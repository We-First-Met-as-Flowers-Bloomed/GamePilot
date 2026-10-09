import { expect, it } from "vitest";
import { incidentLogCodes, buildIncident } from "../packages/agent/incident";
import { createAgentTools } from "../packages/agent/tools";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { PlannerSession } from "../packages/agent/planner";

it("matches only local bounded hints and never treats a normal launch as failure", () => {
  expect(incidentLogCodes(["MuMu launch success"])).toEqual([]);
  expect(incidentLogCodes(["MuMu 实例 0 启动响应失败：PRIVATE"])).toEqual([
    "launch-response-failed",
  ]);
  expect(incidentLogCodes(["CloseAnno PRIVATE"], "onmyoji")).toEqual([]);
  expect(
    incidentLogCodes(
      ["寄养好友列表扫描第45页；寄养完成后未能返回庭院"],
      "onmyoji",
    ),
  ).toEqual(["foster-list-progress", "foster-return"]);
  expect(incidentLogCodes(["x".repeat(2000) + "超时"])).toEqual([]);
});
it("bounds output and refuses signals associated with another task", () => {
  const run = createAgentTools(createFixtureSnapshot()).call("get_run", {
    requestId: "fixture:lane-a",
  });
  const signals = Array.from({ length: 45 }, () => ({
    requestId: run.requestId,
    code: "task-timeout" as const,
    basis: "log-pattern" as const,
  }));
  const report = buildIncident(
    run,
    [...signals, { ...signals[0], runId: "other" }],
    "version",
  );
  expect(report.signals).toHaveLength(40);
  expect(report.omittedSignals).toBe(5);
  expect(report.recoverySkills).toEqual([]);
});

it("keeps other failure-diagnosis calls unknown in the fault query and its planner receipt", () => {
  const snapshot = createFixtureSnapshot();
  snapshot.source = "recorded";
  snapshot.historyAvailable = true;
  const original = structuredClone(snapshot);
  const tools = createAgentTools(snapshot);
  const session = new PlannerSession(tools, "2026-10-04T10:00:00.000Z");
  const reply = session.call("fault-query", "get_incident", {
    requestId: snapshot.requests[0].id,
    environmentRevision: tools.call("get_environment").revision,
  });
  expect(reply.success).toBe(true);
  const incident = JSON.parse(reply.contentItems[0].text);
  expect(incident).toMatchObject({
    recoverySkills: [],
    canExecute: false,
    execution: "not-started",
  });
  expect(incident.gaps).toContainEqual(
    expect.stringMatching(/未读取.*故障.*诊断.*历史.*不能.*未调用/),
  );
  expect(incident.gaps).toContainEqual(
    expect.stringMatching(/execution=not-started.*仅.*本次.*查询/),
  );
  const result = session.finish(
    JSON.stringify({
      kind: "answer",
      text: "当前查询没有提供其他故障诊断或模型调用历史，无法确认是否调用。",
      planHash: null,
    }),
  );
  expect(result.incidents).toEqual([incident]);
  expect(result.canExecute).toBe(false);
  expect(snapshot).toEqual(original);
});
