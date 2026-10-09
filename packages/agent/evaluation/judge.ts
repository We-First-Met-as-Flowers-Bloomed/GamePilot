import { createHash } from "node:crypto";
import { canonical } from "../../acceptance/files";
import { agentToolNames } from "../../protocol/agent";
import type { PlannerResult } from "../../protocol/agent-planner";
import { createAgentTools } from "../tools";
import { createFixtureSnapshot } from "../fixture";
import type { EvaluationCase, Verdict, Review } from "./types";
import { evaluationSnapshot } from "./fixtures";
// Hash JSON as persisted, so optional undefined fields survive a disk round-trip.
export const legacyDigest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const resultDigest = (value: unknown) =>
  legacyDigest(JSON.parse(JSON.stringify(value)));
export function judgeResult(
  test: EvaluationCase,
  result: PlannerResult,
): Verdict {
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => {
    if (!ok) failures.push(message);
  };
  check(test.mode === "live", "故障用例不能按模型结果计分");
  check(
    result.source === (test.diagnostic ? "recorded" : "fixture") &&
      result.execution === "not-started" &&
      result.canExecute === false,
    "演练/未执行合同不符",
  );
  check(
    test.statuses.includes(result.status),
    `结果类型${result.status}不符合${test.statuses.join("/")}`,
  );
  check(Boolean(result.modelText?.trim()), "缺少模型说明");
  for (const tool of [
    "list_capabilities",
    "get_environment",
    ...(test.tools ?? []),
  ])
    check(
      result.trace.some((t) => t.tool === tool && t.success),
      `缺少${tool}成功证据`,
    );
  check(
    result.trace.length <= 12 &&
      result.trace.every((t) => agentToolNames.includes(t.tool)),
    "工具范围或预算不符",
  );
  if (test.diagnostic) {
    check(
      !result.draft && !result.trace.some((t) => t.tool === "compile_plan"),
      "诊断用例不能编译或携带恢复草稿",
    );
    const tools = createAgentTools(evaluationSnapshot(test));
    const environmentRevision = tools.call("get_environment").revision;
    const expected = test.diagnostic.requests.map((requestId) =>
      tools.call("get_incident", { requestId, environmentRevision }),
    );
    const required =
      test.diagnostic.incidentRequests ?? test.diagnostic.requests;
    const provided = result.incidents ?? [];
    check(
      provided.length <= expected.length &&
        new Set(provided.map((i) => i.run.requestId)).size === provided.length,
      "诊断证据数量不符",
    );
    for (const id of required)
      check(
        provided.some((i) => i.run.requestId === id),
        "缺少必需故障包",
      );
    for (const actual of provided) {
      const wanted = expected.find(
        (i) => i.run.requestId === actual.run.requestId,
      );
      check(
        !!wanted && resultDigest(actual) === resultDigest(wanted),
        "故障包与冻结宿主证据不符",
      );
    }
    check(result.records?.length === expected.length, "请求证据数量不符");
    check(
      result.trace.filter(
        (t) => t.success && ["get_run", "get_incident"].includes(t.tool),
      ).length >= expected.length,
      "缺少逐请求记录查询",
    );
    for (const incident of expected) {
      const records =
        result.records?.filter((r) => r.requestId === incident.run.requestId) ??
        [];
      check(
        records.length === 1 &&
          resultDigest(records[0]) === resultDigest(incident.run),
        "请求说明与冻结宿主证据不符",
      );
    }
    check(
      result.trace.filter((t) => t.tool === "get_incident" && t.success)
        .length >= provided.length,
      "缺少逐请求诊断调用",
    );
  }
  if (result.status !== "draft") check(!result.draft, "非草稿结果携带草稿");
  else {
    const d = result.draft;
    check(Boolean(d), "草稿缺失");
    if (d) {
      const tools = createAgentTools(createFixtureSnapshot());
      check(d.status === "valid" && d.canExecute === false, "草稿状态无效");
      check(
        d.catalogRevision === tools.call("list_capabilities").revision &&
          d.environmentRevision === tools.call("get_environment").revision,
        "目录或环境版本不符",
      );
      check(d.at === test.at, "冻结时间不符");
      const hash = resultDigest({
        catalogRevision: d.catalogRevision,
        environmentRevision: d.environmentRevision,
        at: d.at,
        lanes: d.lanes,
      });
      check(
        d.planHash === hash &&
          result.trace.filter((t) => t.tool === "compile_plan").at(-1)
            ?.planHash === hash,
        "草稿hash或编译证据不符",
      );
      check(
        JSON.stringify(d.lanes.map((l) => l.laneId).sort()) ===
          JSON.stringify([...(test.lanes ?? [])].sort()),
        "账号范围不符",
      );
      for (const lane of d.lanes) {
        check(
          lane.instance ===
            (lane.laneId === "lane-a" ? 0 : lane.laneId === "lane-b" ? 1 : -1),
          "实例绑定不符",
        );
        check(lane.games.length === test.games?.length, "游戏数量不符");
        lane.games.forEach((game, i) => {
          const expected = test.games?.[i];
          check(game.plan.gameId === expected?.gameId, "游戏顺序不符");
          const required = game.plan.skillIds.filter(
            (id) => !expected?.optionalSkills?.includes(id),
          );
          check(
            JSON.stringify(required) === JSON.stringify(expected?.skills) &&
              new Set(game.plan.skillIds).size === game.plan.skillIds.length,
            `${lane.laneId}/${game.plan.gameId}技能或顺序不符`,
          );
          for (const [key, value] of Object.entries(expected?.parameters ?? {}))
            check(
              game.parameters[key] === value,
              `${lane.laneId}/${key}参数不符`,
            );
          if (game.plan.gameId === "arknights")
            for (const key of ["medicine", "stone", "expiringMedicine"])
              check(game.parameters[key] === 0, `${key}违反零补充限制`);
        });
      }
    }
  }
  return { status: failures.length ? "failed" : "needs-review", failures };
}
export function reviewResult(
  verdict: Verdict,
  result: PlannerResult,
  review: Review,
): Verdict {
  if (review.digest !== resultDigest(result)) throw Error("复核证据hash不符");
  if (
    !review.reviewer?.trim() ||
    !review.note?.trim() ||
    !["pass", "fail"].includes(review.decision)
  )
    throw Error("复核缺少作者、判定或理由");
  if (verdict.status === "failed" && review.decision === "pass")
    throw Error("不能覆盖结构失败");
  return review.decision === "pass"
    ? { ...verdict, status: "passed" }
    : { status: "failed", failures: [...verdict.failures, review.note] };
}
