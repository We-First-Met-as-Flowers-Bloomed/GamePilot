import type { Plan, SkillResult } from "../packages/protocol";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { StartupReconciliationFact } from "../packages/protocol/startup-reconciliation";
import type {
  TaskRecord,
  TaskStepRecord,
} from "../packages/protocol/task-record";
import { validArknightsEvidence } from "./arknights/evidence";
import { projectExecutionDetail } from "./execution-detail";
import { mergeExecutionProgress } from "./execution-progress";
import { gamePlugins } from "./registry";
import type { ExecutionDetail } from "../packages/protocol/execution-detail";
import { gamePreferencePrompt } from "./agent-message-scope";
import { onmyojiObservedEffects } from "./onmyoji/evidence";

export type GoalOutcomeStatus =
  "verified" | "not-applicable" | "unknown" | "failed";
export interface GoalSkillOutcome {
  gameId?: string;
  skillId: string;
  status: string;
  goalSatisfied: boolean | null;
  skipReason?: SkillResult["skipReason"];
  evidenceTimestamp?: string;
  evidenceReference?: string;
  summary: string;
  effectEvidence?: {
    kind: string;
    observedAt: string;
    evidenceReference: string;
    summary: string;
  }[];
}
export interface GoalRequestOutcome {
  requestId: string;
  rootRequestId?: string;
  originalStatus?: ExecutionRecord["status"];
  laneId?: string;
  gameId?: string;
  status: ExecutionRecord["status"];
  flowComplete: boolean;
  goalSatisfied: boolean | null;
  skills: GoalSkillOutcome[];
}
export interface GoalOutcomeEvaluation {
  status: GoalOutcomeStatus;
  flowComplete: boolean;
  goalSatisfied: boolean | null;
  requests: GoalRequestOutcome[];
  summary: string;
}
export interface GoalOutcomeCriteria {
  fight?: "execute-task" | "consume-current-sanity";
  login?: "execute-task" | "verify-account";
}
/** Stronger objectives need stronger evidence than an executor task-end callback. */
export function goalOutcomeCriteriaForPrompt(
  prompt: string,
): GoalOutcomeCriteria {
  const clauses = gamePreferencePrompt(prompt)
    .split(/[，,。；;\n]/)
    .filter(
      (clause) =>
        !/(?:不要|无需|不用|不必|不要求|不需要).{0,8}(?:用尽|耗尽|刷完|核验|校验|验证)/.test(
          clause,
        ),
    );
  const text = clauses.join("；");
  return {
    ...(/(?:消耗|用尽|用完|耗尽|刷完).{0,10}理智|理智.{0,8}(?:用尽|用完|耗尽|刷完)/.test(
      text,
    )
      ? { fight: "consume-current-sanity" as const }
      : {}),
    ...(/(?:核验|校验|验证).{0,10}(?:账号|账户|角色|身份|UID)|(?:账号|账户|角色|身份|UID).{0,10}(?:核验|校验|验证)/i.test(
      text,
    )
      ? { login: "verify-account" as const }
      : {}),
  };
}
const date = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

/** Interpret adapter facts, never localized result/log prose. */
export function evaluateGameSkillOutcome(
  gameId: string,
  step: TaskStepRecord,
  snapshot: Record<string, unknown> = {},
): GoalSkillOutcome {
  const result = step.result;
  const effects =
    gameId === "onmyoji" && step.evidence !== "rehearsal"
      ? onmyojiObservedEffects(step)
      : [];
  const output: GoalSkillOutcome = {
    gameId,
    skillId: step.skillId,
    status: step.status,
    goalSatisfied: null,
    ...(result?.skipReason ? { skipReason: result.skipReason } : {}),
    ...(date(result?.evidenceTimestamp)
      ? { evidenceTimestamp: result.evidenceTimestamp }
      : {}),
    ...(result?.evidenceReference
      ? { evidenceReference: result.evidenceReference }
      : {}),
    summary: result?.summary ?? step.message,
    ...(effects.length ? { effectEvidence: effects } : {}),
  };
  if (["failed", "cancelled", "not-run"].includes(step.status))
    return { ...output, goalSatisfied: false };
  if (
    !["succeeded", "skipped"].includes(step.status) ||
    step.evidence === "rehearsal"
  )
    return output;
  const criteria = snapshot.goalCriteria as GoalOutcomeCriteria | undefined;
  const native =
    gameId === "arknights" && validArknightsEvidence(result?.arknights)
      ? result.arknights
      : undefined;
  if (native) {
    output.evidenceTimestamp = native.observedAt;
    output.evidenceReference = `native:${native.taskType}:${native.taskId ?? "unsubmitted"}`;
  }
  if (step.skillId === "login" && criteria?.login === "verify-account") {
    const evidence = result?.arknights;
    const profile = (snapshot.profile ?? snapshot.arknights) as
      { expectedUid?: string } | undefined;
    const verified =
      gameId === "arknights" &&
      validArknightsEvidence(evidence) &&
      evidence.completion === "native-confirmed" &&
      evidence.login?.home === true &&
      !!profile?.expectedUid &&
      evidence.login.expectedUid === profile.expectedUid &&
      evidence.login.observedUid === profile.expectedUid;
    return {
      ...output,
      goalSatisfied: verified ? true : null,
      ...(verified
        ? {
            evidenceTimestamp:
              evidence!.login!.homeObservedAt ?? evidence!.login!.observedAt,
          }
        : {}),
      summary: verified
        ? "当前游戏内 UID 已与冻结账号绑定核对一致"
        : gameId === "onmyoji"
          ? "已观察现有登录态；阴阳师当前角色或 UID 未作独立核验，账号核验目标尚未确认"
          : "登录流程结束；当前游戏内 UID 与冻结账号身份尚未核验",
    };
  }
  if (
    result?.goalSatisfied !== undefined &&
    date(result.evidenceTimestamp) &&
    result.evidenceReference
  ) {
    return { ...output, goalSatisfied: result.goalSatisfied };
  }
  if (gameId !== "arknights" || !validArknightsEvidence(result?.arknights))
    return output;
  const evidence = result!.arknights!;
  if (evidence.completion !== "native-confirmed") return output;
  if (step.skillId === "login")
    return { ...output, goalSatisfied: evidence.login?.home === true };
  const profile = (snapshot.profile ?? snapshot.arknights) as
    Record<string, unknown> | undefined;
  const statistics = evidence.statistics;
  if (step.skillId === "fight") {
    const count = statistics?.fight?.completedRunsObserved;
    const remaining = statistics?.fight?.latestSanity;
    const stageCost = profile?.stage === "LS-6" ? 36 : undefined;
    const consumed =
      remaining !== undefined &&
      (remaining === 0 || (stageCost !== undefined && remaining < stageCost));
    return {
      ...output,
      goalSatisfied:
        count !== undefined &&
        count > 0 &&
        (criteria?.fight !== "consume-current-sanity" || consumed)
          ? true
          : null,
      summary:
        count === undefined
          ? "作战流程结束；累计完成次数未确认"
          : `原生作战任务已核对完成；确认作战 ${count} 次${remaining === undefined ? "；剩余理智未确认" : `；观察到剩余理智 ${remaining}`}${criteria?.fight === "consume-current-sanity" && !consumed ? "；是否已用尽本关可用理智尚未确认" : ""}`,
    };
  }
  if (step.skillId === "friends") {
    const mall = statistics?.mall;
    const shopping = profile?.creditShopping;
    return {
      ...output,
      goalSatisfied:
        mall &&
        !mall.shoppingErrorObserved &&
        mall.creditCollected &&
        (shopping === false || mall.purchaseConfirmations > 0)
          ? true
          : null,
      summary: mall
        ? `信用收取${mall.creditCollected ? "已确认" : "未确认"}；确认购买 ${mall.purchaseConfirmations} 次${mall.shoppingErrorObserved ? "；购物分支出现警告" : ""}`
        : "好友与信用商店流程结束；实际收取和购买未确认",
    };
  }
  if (step.skillId === "award") {
    const award = statistics?.award;
    const mail = profile?.mail;
    const taskAward = profile?.taskAward !== false;
    const verified =
      award &&
      (!taskAward || award.claimActions > 0) &&
      (mail === false || ["empty", "claim-confirmed"].includes(award.mail));
    return {
      ...output,
      goalSatisfied: verified ? true : null,
      summary: award
        ? `确认奖励领取动作 ${award.claimActions} 次；邮件${award.mail === "empty" ? "已核对为空" : award.mail === "claim-confirmed" ? "已确认领取" : "未确认"}`
        : "奖励流程结束；实际奖励与邮件未确认",
    };
  }
  if (["recruit", "infrastructure"].includes(step.skillId))
    return {
      ...output,
      goalSatisfied: true,
      summary:
        step.skillId === "recruit"
          ? "公招任务已由匹配的原生回调核对完成；未声明招募干员数量"
          : "基建任务已由匹配的原生回调核对完成；未声明各项资源领取数量",
    };
  return output;
}

function plansFor(request: ExecutionRecord): Plan[] {
  const plans = [
    request.snapshot.plan,
    request.snapshot.arknightsPlan,
    request.snapshot.onmyojiPlan,
  ];
  return plans.filter((value): value is Plan =>
    Boolean(
      value &&
      typeof value === "object" &&
      typeof (value as Plan).gameId === "string" &&
      Array.isArray((value as Plan).skillIds),
    ),
  );
}
function satisfaction(skills: GoalSkillOutcome[]): boolean | null {
  return skills.some((s) => s.goalSatisfied === false)
    ? false
    : skills.length > 0 && skills.every((s) => s.goalSatisfied === true)
      ? true
      : null;
}

/** A missing later game is pending only while the frozen serial predecessor is
 * demonstrably running. This changes presentation, never completion evidence. */
function waitingForArknights(
  request: ExecutionRecord,
  detail: ExecutionDetail | undefined,
  tasks: TaskRecord[],
): boolean {
  if (
    request.source !== "daily" ||
    request.status !== "running" ||
    request.finishedAt !== undefined ||
    request.resolution ||
    request.snapshot.plan !== undefined ||
    request.snapshot.continuation !== undefined ||
    !detail ||
    detail.warnings.length ||
    detail.games.length !== 2
  )
    return false;
  const [first, next] = detail.games;
  const current = first.record;
  if (
    first.plan.gameId !== "arknights" ||
    next.plan.gameId !== "onmyoji" ||
    first.plan.mode !== "live" ||
    next.plan.mode !== "live" ||
    next.record ||
    !current ||
    current.status !== "running" ||
    current.finishedAt !== undefined ||
    current.maintenance ||
    current.fault
  )
    return false;
  // Include contradictory links from the same lane/batch. A filtered detail
  // alone cannot prove that the next game has never started.
  const related = tasks.filter(
    (task) =>
      task.executionId === request.id ||
      (request.batchId &&
        task.batchId === request.batchId &&
        task.laneId === request.laneId),
  );
  if (related.length !== 1 || related[0].runId !== current.runId) return false;
  const active = current.steps.findIndex((step) => step.status === "running");
  if (active < 0) return false;
  let previousEnd = Date.parse(current.startedAt);
  return current.steps.every((step, index) => {
    if (index > active)
      return (
        step.status === "pending" &&
        step.startedAt === undefined &&
        step.finishedAt === undefined &&
        step.result === undefined &&
        step.evidence === undefined &&
        step.diagnostics.length === 0
      );
    if (!date(step.startedAt) || Date.parse(step.startedAt) < previousEnd)
      return false;
    if (index === active) return step.finishedAt === undefined;
    if (
      !["succeeded", "skipped"].includes(step.status) ||
      !date(step.finishedAt)
    )
      return false;
    previousEnd = Date.parse(step.finishedAt);
    return true;
  });
}
/** Projection only: neither original request status nor daily coverage is rewritten. */
export function evaluateGoalOutcome(
  requests: ExecutionRecord[],
  tasks: TaskRecord[],
  criteria: GoalOutcomeCriteria = {},
  historyRequests: ExecutionRecord[] = requests,
  verifiedStartupFacts: StartupReconciliationFact[] = [],
): GoalOutcomeEvaluation {
  const details = new Map<string, ExecutionDetail>();
  for (const request of requests) {
    try {
      details.set(
        request.id,
        projectExecutionDetail(
          request,
          tasks.filter((task) => task.executionId === request.id),
        ),
      );
    } catch {
      /* Corrupt/unassociated evidence remains unknown. */
    }
  }
  const parentId = (request: ExecutionRecord) =>
    (request.snapshot.continuation as { parentId?: unknown } | undefined)
      ?.parentId;
  const roots = requests.filter(
    (request) => !requests.some((parent) => parent.id === parentId(request)),
  );
  const outcomes = roots.map((request): GoalRequestOutcome => {
    const plans = plansFor(request);
    let progress: ReturnType<typeof mergeExecutionProgress> | undefined;
    try {
      progress = mergeExecutionProgress(
        request.id,
        requests,
        details,
        verifiedStartupFacts,
        tasks,
        historyRequests,
      );
    } catch {
      /* Missing trustworthy progress is not completion. */
    }
    const reliable = progress && !progress.warnings.length;
    const latest = progress
      ? (requests.find((value) => value.id === progress.latestId) ?? request)
      : request;
    const serialWaiting =
      latest.id === request.id &&
      waitingForArknights(request, details.get(request.id), tasks);
    const skills = plans.flatMap((plan) =>
      plan.skillIds.map((skillId): GoalSkillOutcome => {
        const covered = progress
          ? progress.steps.find(
              (step) => step.gameId === plan.gameId && step.skillId === skillId,
            )
          : undefined;
        const source =
          requests.find((value) => value.id === covered?.sourceId) ?? request;
        const task = details
          .get(source.id)
          ?.games.find((game) => game.plan.gameId === plan.gameId)?.record;
        const step = task?.steps.find((value) => value.skillId === skillId);
        if (
          !step &&
          serialWaiting &&
          source.id === request.id &&
          plan.gameId === "onmyoji" &&
          plan.mode === "live" &&
          covered?.status !== "excluded"
        )
          return {
            gameId: plan.gameId,
            skillId,
            status: "pending",
            goalSatisfied: null,
            summary: "等待明日方舟完成后执行",
          };
        if (
          !step ||
          covered?.status === "excluded" ||
          plan.mode !== "live" ||
          task?.maintenance
        )
          return {
            gameId: plan.gameId,
            skillId,
            status: "unknown",
            goalSatisfied: null,
            ...(step &&
            covered?.status === "excluded" &&
            plan.mode === "live" &&
            !task?.maintenance &&
            step.evidence !== "rehearsal" &&
            plan.gameId === "onmyoji" &&
            onmyojiObservedEffects(step).length
              ? { effectEvidence: onmyojiObservedEffects(step) }
              : {}),
            summary:
              plan.mode !== "live" || task?.maintenance
                ? "演练或维护步骤不能作为目标的真实执行证据"
                : covered?.status === "excluded"
                  ? "原计划此项已排除；未作为目标完成证据"
                  : "没有与冻结计划匹配的步骤证据",
          };
        const result = step.result;
        const timestamp = result?.evidenceTimestamp;
        if (
          result?.goalSatisfied !== undefined &&
          (!date(timestamp) ||
            Date.parse(timestamp) <
              Date.parse(step.startedAt ?? task!.startedAt) ||
            Date.parse(timestamp) >
              Date.parse(step.finishedAt ?? task!.updatedAt))
        )
          return {
            gameId: plan.gameId,
            skillId,
            status: "unknown",
            goalSatisfied: null,
            summary: "步骤结果缺少执行时间范围内的有效观察证据",
          };
        const outcome = gamePlugins
          .get(plan.gameId)
          .outcome(step, { ...source.snapshot, goalCriteria: criteria });
        const native = result?.arknights;
        if (
          plan.gameId === "arknights" &&
          validArknightsEvidence(native) &&
          native.completion === "native-confirmed" &&
          date(outcome.evidenceTimestamp)
        )
          return {
            ...outcome,
            evidenceReference: `request:${source.id}:run:${task!.runId}:step:${skillId}:native:${native.taskType}:${native.taskId}`,
          };
        return outcome;
      }),
    );
    const exclusions = request.snapshot.exclusions;
    if (Array.isArray(exclusions))
      for (const raw of exclusions) {
        const excluded = raw as {
          gameId?: unknown;
          skillIds?: unknown;
          skipReason?: unknown;
          evidenceTimestamp?: unknown;
          evidenceReference?: unknown;
        };
        if (
          typeof excluded.gameId !== "string" ||
          !Array.isArray(excluded.skillIds) ||
          excluded.skipReason !== "not-open" ||
          !date(excluded.evidenceTimestamp) ||
          typeof excluded.evidenceReference !== "string" ||
          !excluded.evidenceReference
        )
          continue;
        for (const skillId of excluded.skillIds)
          if (
            typeof skillId === "string" &&
            !skills.some(
              (skill) =>
                skill.gameId === excluded.gameId && skill.skillId === skillId,
            )
          ) {
            skills.push({
              gameId: excluded.gameId,
              skillId,
              status: "skipped",
              goalSatisfied: null,
              skipReason: "not-open",
              evidenceTimestamp: excluded.evidenceTimestamp,
              evidenceReference: excluded.evidenceReference,
              summary: `${skillId}不在请求日期/时间的开放范围；本次未执行`,
            });
          }
      }
    return {
      requestId: latest.id,
      laneId: request.laneId,
      ...(latest.id !== request.id
        ? { rootRequestId: request.id, originalStatus: request.status }
        : {}),
      ...(plans.length === 1 ? { gameId: plans[0].gameId } : {}),
      status: latest.status,
      flowComplete: Boolean(reliable && progress!.wholePlanComplete),
      goalSatisfied: latest.status === "running" ? null : satisfaction(skills),
      skills,
    };
  });
  const allSkills = outcomes.flatMap((request) => request.skills);
  const goalSatisfied = outcomes.some(
    (request) => request.goalSatisfied === false,
  )
    ? false
    : outcomes.length > 0 &&
        outcomes.every((request) => request.goalSatisfied === true)
      ? true
      : null;
  const flowComplete =
    outcomes.length > 0 && outcomes.every((request) => request.flowComplete);
  const failed =
    outcomes.some((request) =>
      ["failed", "cancelled"].includes(request.status),
    ) || goalSatisfied === false;
  const notApplicable =
    flowComplete &&
    allSkills.length > 0 &&
    allSkills.every(
      (skill) =>
        skill.goalSatisfied === true ||
        ["not-open", "user-excluded"].includes(skill.skipReason ?? ""),
    ) &&
    allSkills.some((skill) => skill.goalSatisfied !== true);
  return {
    status: failed
      ? "failed"
      : goalSatisfied === true && flowComplete
        ? "verified"
        : notApplicable
          ? "not-applicable"
          : "unknown",
    flowComplete,
    goalSatisfied,
    requests: outcomes,
    summary: outcomes.length
      ? outcomes
          .map(
            (request) =>
              `${request.laneId ?? request.requestId}：${[...new Set(request.skills.map((skill) => skill.summary))].join("；")}`,
          )
          .join("\n")
      : "尚无已受理请求的结果证据",
  };
}
