import { createHash } from "node:crypto";
import type { ExecutionRecord } from "../protocol/execution";
import type { TaskRecord } from "../protocol/task-record";
import { parseExecutionSnapshot } from "../protocol/execution-snapshot";
import { validExitObservation } from "../protocol/execution-observation";
import { projectExecutionDetail } from "../../games/execution-detail";
import { evaluateGameSkillOutcome } from "../../games/goal-outcome";
import {
  arknightsPackage,
  defaultArknightsConfig,
} from "../../games/arknights/config";
import { asRecord } from "../protocol/struct";
import { canonical } from "./files";
import type { DailyExpectation, DailyInspection } from "./report";

export interface AcceptanceCheck {
  id: string;
  status: "passed" | "missing" | "failed";
  detail: string;
}
export interface RoundVerification {
  status: "passed" | "failed" | "insufficient-evidence";
  checks: AcceptanceCheck[];
}

export function acceptanceBindingHash(snapshot: {
  lane?: unknown;
  profile?: unknown;
}): string {
  return createHash("sha256")
    .update(
      canonical({
        lane: snapshot.lane ?? null,
        profile: snapshot.profile ?? null,
      }),
    )
    .digest("hex");
}

/** The request hash authenticates immutable context only, never mutable outcomes. */
export function immutableRequestMatches(r: ExecutionRecord): boolean {
  if (
    !Array.isArray(r.resources) ||
    !r.resources.length ||
    r.resources.some((v) => typeof v !== "string" || !v)
  )
    return false;
  const { startedAt: _time, ...snapshot } = r.snapshot;
  return (
    createHash("sha256")
      .update(
        canonical({
          id: r.id,
          source: r.source,
          resources: [...new Set(r.resources)].sort(),
          snapshot,
          ...(r.laneId ? { laneId: r.laneId } : {}),
          ...(r.batchId ? { batchId: r.batchId } : {}),
        }),
      )
      .digest("hex") === r.fingerprint
  );
}

/** Missing prospective evidence remains missing; legacy prose is never promoted to proof. */
export function verifyDailyEvidence(
  expected: DailyExpectation,
  row: DailyInspection,
  requests: ExecutionRecord[],
  tasks: TaskRecord[],
): RoundVerification {
  const checks: AcceptanceCheck[] = [];
  const check = (
    id: string,
    status: AcceptanceCheck["status"],
    detail: string,
  ) => checks.push({ id, status, detail });
  check(
    "flow",
    ["failed", "partial"].includes(row.state)
      ? "failed"
      : row.state === "flow-ended"
        ? "passed"
        : "missing",
    `原流程状态：${row.state}`,
  );
  check(
    "unattended",
    row.interventionRecorded || row.continuationIds.length
      ? "failed"
      : "passed",
    row.interventionRecorded
      ? "存在续跑介入，不能作为首轮无人值守通过"
      : "未记录宿主续跑；本地账本不证明其他软件未操作设备",
  );
  const candidates = requests.filter((r) => row.requestIds.includes(r.id));
  const r = candidates.length === 1 ? candidates[0] : undefined;
  const view = r && parseExecutionSnapshot(r.snapshot);
  const supported = !!view && ["legacy", "current"].includes(view.schemaStatus);
  check(
    "immutable-request",
    r && immutableRequestMatches(r) ? "passed" : "missing",
    "请求编号、冻结计划与资源指纹须一致",
  );
  check(
    "snapshot-schema",
    supported ? "passed" : "missing",
    "仅解释兼容的快照版本",
  );
  check(
    "baseline-binding",
    !expected.bindingHash || !supported
      ? "missing"
      : acceptanceBindingHash(view.raw) === expected.bindingHash
        ? "passed"
        : "failed",
    "账号档案和完整通道绑定必须与冻结验收基线一致",
  );
  const due = `${expected.date}T${expected.dueTime ?? (expected.slot === "secondary" ? "20:00" : "08:00")}:00+08:00`;
  const schedule = supported
    ? (view.raw.schedule as
        { origin?: unknown; slot?: unknown; dueAt?: string } | undefined)
    : undefined;
  const scheduled =
    r?.source === "daily" &&
    schedule?.origin === "scheduler" &&
    schedule.slot === (expected.slot ?? "primary") &&
    Date.parse(schedule.dueAt ?? "") === Date.parse(due) &&
    Date.parse(r.startedAt) >= Date.parse(due);
  check(
    "schedule-origin",
    scheduled
      ? "passed"
      : schedule?.origin && schedule.origin !== "scheduler"
        ? "failed"
        : "missing",
    "必须由宿主定时器记录准确槽位与到期时间；手动/Agent运行不计定时启动",
  );
  const exits =
    supported &&
    r &&
    Array.isArray(r.observations) &&
    r.observations.length <= 16 &&
    r.observations.every((o) => validExitObservation(o, r)) &&
    new Set(r.observations.map((o) => o.gameId)).size === r.observations.length
      ? r.observations.filter((o) => o.gameId === "arknights")
      : [];
  const linked = r ? tasks.filter((t) => t.executionId === r.id) : [];
  const arkTask = linked.find((t) => t.gameId === "arknights");
  const nextTask = linked.find((t) => t.gameId === "onmyoji");
  const exit = exits.length === 1 ? exits[0] : undefined;
  const clientType = asRecord(
    supported ? view.raw.profile : undefined,
  )?.clientType;
  const exited =
    !!exit &&
    (clientType === "Official" || clientType === "Bilibili") &&
    exit.packageName ===
      arknightsPackage({ ...defaultArknightsConfig, clientType }) &&
    !!arkTask?.finishedAt &&
    Date.parse(exit.firstObservedAt) >= Date.parse(arkTask.finishedAt) &&
    (!nextTask ||
      Date.parse(exit.observedAt) <= Date.parse(nextTask.startedAt));
  check(
    "arknights-exit",
    exited ? "passed" : "missing",
    "相同设备/包名两次独立进程检查必须位于方舟结束与下一游戏之间",
  );
  let detail;
  try {
    if (r && supported) detail = projectExecutionDetail(r, linked);
  } catch {
    /* Invalid records never supply coverage. */
  }
  for (const plan of expected.plans) {
    const game = detail?.games.find((g) => g.plan.gameId === plan.gameId);
    const reliable =
      game?.record &&
      !detail?.warnings.length &&
      canonical(game.plan) === canonical(plan);
    for (const skillId of plan.skillIds) {
      const step = reliable
        ? game.record!.steps.find((s) => s.skillId === skillId)
        : undefined;
      const snapshot = {
        ...(supported ? view.raw : {}),
        goalCriteria: { login: "verify-account" },
      };
      const outcome =
        step && evaluateGameSkillOutcome(plan.gameId, step, snapshot);
      const bounded =
        step?.startedAt &&
        step.finishedAt &&
        outcome?.evidenceTimestamp &&
        Date.parse(outcome.evidenceTimestamp) >= Date.parse(step.startedAt) &&
        Date.parse(outcome.evidenceTimestamp) <= Date.parse(step.finishedAt);
      check(
        `${plan.gameId}:${skillId}`,
        outcome?.goalSatisfied === false
          ? "failed"
          : outcome?.goalSatisfied === true &&
              bounded &&
              outcome.evidenceReference
            ? "passed"
            : "missing",
        outcome?.summary ?? "缺少唯一关联、时间有界的逐项结果证据",
      );
    }
  }
  return {
    status: checks.some((c) => c.status === "failed")
      ? "failed"
      : checks.every((c) => c.status === "passed")
        ? "passed"
        : "insufficient-evidence",
    checks,
  };
}

export function evaluateObservationWindow(
  rows: (DailyInspection & { verification: RoundVerification })[],
  context: {
    start: string;
    end: string;
    now: Date;
    dataErrors: string[];
    configChanges: string[];
  },
) {
  const start = Date.parse(context.start + "T00:00:00+08:00");
  const end = Date.parse(context.end + "T00:00:00+08:00");
  const reasons: string[] = [];
  if (
    !Number.isFinite(start) ||
    end - start !== 6 * 86400000 ||
    !Number.isFinite(context.now.getTime())
  )
    return {
      status: "insufficient-evidence" as const,
      reasons: ["观察窗口必须覆盖连续七天"],
    };
  if (context.configChanges.length) reasons.push("观察期间配置偏离冻结基线");
  if (rows.some((r) => r.verification.status === "failed"))
    reasons.push("至少一个计划轮次未通过无人值守验收");
  if (reasons.length) return { status: "failed" as const, reasons };
  if (context.now.getTime() < end + 86400000)
    return { status: "observing" as const, reasons: ["七天观察窗口尚未结束"] };
  const scopes = new Set(rows.map((r) => `${r.laneId}:${r.slot}`));
  const keys = new Set(rows.map((r) => `${r.date}:${r.laneId}:${r.slot}`));
  if (
    !scopes.size ||
    keys.size !== rows.length ||
    rows.length !== scopes.size * 7
  )
    reasons.push("观察轮次缺失或重复");
  for (let day = 0; day < 7; day++) {
    const date = new Date(start + day * 86400000 + 8 * 3600000)
      .toISOString()
      .slice(0, 10);
    for (const scope of scopes)
      if (!keys.has(`${date}:${scope}`)) reasons.push(`${date}缺少冻结轮次`);
  }
  if (context.dataErrors.length) reasons.push("原始证据读取异常");
  if (rows.some((r) => r.verification.status !== "passed"))
    reasons.push("逐项证据不完整");
  return {
    status: reasons.length
      ? ("insufficient-evidence" as const)
      : ("passed" as const),
    reasons: [...new Set(reasons)],
  };
}
