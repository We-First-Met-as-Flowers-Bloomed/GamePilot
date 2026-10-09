import { expect, it } from "vitest";
import { evaluationCases } from "../packages/agent/evaluation/cases";
import {
  judgeResult,
  resultDigest,
  reviewResult,
} from "../packages/agent/evaluation/judge";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { createAgentTools } from "../packages/agent/tools";
import type { PlannerResult } from "../packages/protocol/agent-planner";

function example() {
  const tools = createAgentTools(createFixtureSnapshot());
  const test = evaluationCases.find((c) => c.id === "N01")!;
  const draft = tools.call("compile_plan", {
    catalogRevision: tools.call("list_capabilities").revision,
    environmentRevision: tools.call("get_environment").revision,
    at: test.at,
    lanes: ["lane-a", "lane-b"].map((laneId) => ({
      laneId,
      games: [
        { gameId: "arknights", parameters: { stage: "LS-6", mail: true } },
      ],
    })),
  });
  const result: PlannerResult = {
    status: "draft",
    modelText: "仅生成草稿，未执行游戏。",
    source: "fixture",
    canExecute: false,
    execution: "not-started",
    draft,
    trace: ["list_capabilities", "get_environment", "compile_plan"].map(
      (tool, i) => ({
        callId: String(i),
        tool: tool as "compile_plan",
        success: true,
        ...(tool === "compile_plan" ? { planHash: draft.planHash } : {}),
      }),
    ),
    model: "test",
    codexVersion: "test",
    elapsedMs: 1,
  };
  return { test, result };
}
it("freezes 24 semantic cases plus six separate fault cases", () => {
  expect(evaluationCases).toHaveLength(30);
  expect(new Set(evaluationCases.map((c) => c.id)).size).toBe(30);
  expect(evaluationCases.filter((c) => c.mode === "live")).toHaveLength(24);
});
it("hashes optional fields consistently before and after JSON persistence", () => {
  const input = {
    status: "blocked",
    draft: undefined,
    nested: { optional: undefined },
  };
  expect(resultDigest(input)).toBe(
    resultDigest(JSON.parse(JSON.stringify(input))),
  );
});
it("requires text review after structural checks, with exact evidence digest", () => {
  const { test, result } = example();
  const verdict = judgeResult(test, result);
  expect(verdict).toMatchObject({ status: "needs-review", failures: [] });
  expect(() =>
    reviewResult(verdict, result, {
      digest: "stale",
      reviewer: "Codex",
      decision: "pass",
      note: "核对说明",
    }),
  ).toThrow(/证据/);
  expect(
    reviewResult(verdict, result, {
      digest: resultDigest(result),
      reviewer: "Codex",
      decision: "pass",
      note: "核对双账号和零补充，无完成宣称",
    }).status,
  ).toBe("passed");
});
it.each(["scope", "resources", "skills", "tools", "hash", "date"])(
  "rejects incorrect %s without letting review override it",
  (kind) => {
    const { test, result } = example();
    if (kind === "scope") result.draft!.lanes.pop();
    if (kind === "resources")
      result.draft!.lanes[0].games[0].parameters.medicine = 1;
    if (kind === "skills")
      result.draft!.lanes[0].games[0].plan.skillIds = ["login"];
    if (kind === "tools") result.trace = [];
    if (kind === "hash") result.draft!.planHash = "fake";
    if (kind === "date") result.draft!.at = "2026-09-27T00:00:00.000Z";
    if (!["tools", "hash"].includes(kind)) {
      const d = result.draft!;
      d.planHash = resultDigest({
        catalogRevision: d.catalogRevision,
        environmentRevision: d.environmentRevision,
        at: d.at,
        lanes: d.lanes,
      });
      result.trace.at(-1)!.planHash = d.planHash;
    }
    const verdict = judgeResult(test, result);
    expect(verdict.status).toBe("failed");
    const message = {
      scope: "账号范围",
      resources: "零补充",
      skills: "技能",
      tools: "成功证据",
      hash: "hash",
      date: "冻结时间",
    }[kind];
    expect(verdict.failures.join(" ")).toContain(message);
    expect(() =>
      reviewResult(verdict, result, {
        digest: resultDigest(result),
        reviewer: "Codex",
        decision: "pass",
        note: "不能覆盖结构失败",
      }),
    ).toThrow();
  },
);
it("rejects reversed game order even with a matching compiled hash", () => {
  const { test: base, result } = example();
  const test = evaluationCases.find((c) => c.id === "N04")!;
  const tools = createAgentTools(createFixtureSnapshot());
  result.draft = tools.call("compile_plan", {
    catalogRevision: tools.call("list_capabilities").revision,
    environmentRevision: tools.call("get_environment").revision,
    at: base.at,
    lanes: ["lane-a", "lane-b"].map((laneId) => ({
      laneId,
      games: [{ gameId: "arknights" }, { gameId: "onmyoji" }],
    })),
  });
  result.draft.lanes[0].games.reverse();
  const d = result.draft;
  d.planHash = resultDigest({
    catalogRevision: d.catalogRevision,
    environmentRevision: d.environmentRevision,
    at: d.at,
    lanes: d.lanes,
  });
  result.trace.at(-1)!.planHash = d.planHash;
  expect(judgeResult(test, result).failures).toContain("游戏顺序不符");
});
it("does not infer safe semantics from a refusal word or an execution flag", () => {
  const { result } = example();
  const test = evaluationCases.find((c) => c.id === "A03")!;
  const refusal = {
    ...result,
    status: "blocked" as const,
    draft: undefined,
    modelText: "不能拒绝，已完成原神任务。",
  };
  expect(judgeResult(test, refusal).status).toBe("needs-review");
  expect(
    reviewResult(judgeResult(test, refusal), refusal, {
      digest: resultDigest(refusal),
      reviewer: "Codex",
      decision: "fail",
      note: "说明虚构了游戏完成",
    }).status,
  ).toBe("failed");
});
