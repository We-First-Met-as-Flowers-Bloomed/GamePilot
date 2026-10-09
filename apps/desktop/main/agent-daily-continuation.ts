import type { DeviceLane } from "../../../packages/protocol";
import type { AgentRuntimePrincipal } from "../../../packages/protocol/agent-runtime";
import type { GoalRun } from "../../../packages/protocol/agent-goal";
import type { ExecutionRecord } from "../../../packages/protocol/execution";
import type { TaskRecord } from "../../../packages/protocol/task-record";
import type { ContinuationPreview } from "../../../packages/protocol/continuation";
import type { StartupReconciliationFact } from "../../../packages/protocol/startup-reconciliation";
import { AgentToolError } from "../../../packages/protocol/agent";
import { gameMessageAuthority } from "../../../packages/agent/game-message-authority";
import { assertAgentContinuationMessageScope } from "../../../games/agent-continuation-scope";
import { verifyStartupReconciliationFact } from "../../../games/arknights/startup-reconciliation";
import { arknightsGameDay } from "../../../games/arknights/result-policy";
import type { ArknightsProfiles } from "../../../games/arknights/config";
import { goalContinuationScopes } from "../../../games/goal-continuation";
import type { LaneExecutionSnapshot } from "./lane-snapshot";
import type { PreparedGoal } from "./agent-goals";

export interface DailyContinuationReference {
  parentRequestId: string;
  parentFingerprint: string;
}
export function createDailyContinuationPreparation(deps: {
  read(): Promise<{
    requests: ExecutionRecord[];
    tasks: TaskRecord[];
    startupFacts: StartupReconciliationFact[];
    lanes: DeviceLane[];
    profiles: ArknightsProfiles;
    goals: GoalRun[];
  }>;
  preview(id: string): Promise<ContinuationPreview>;
  assertOwner(sessionId: string, requestId: string): void;
  now?: () => Date;
}) {
  return async (
    principal: AgentRuntimePrincipal,
    reference?: DailyContinuationReference,
  ): Promise<PreparedGoal> => {
    if (!gameMessageAuthority(principal.prompt).resume)
      throw new AgentToolError(
        "MESSAGE_NOT_AUTHORIZED",
        "当前消息没有明确要求继续原日常",
      );
    const data = await deps.read(),
      now = (deps.now ?? (() => new Date()))();
    const scopeFor = (parent: ExecutionRecord) => {
      const snapshot = structuredClone(
        parent.snapshot,
      ) as unknown as LaneExecutionSnapshot;
      const scopes = [snapshot.arknightsPlan, snapshot.onmyojiPlan]
        .filter((plan) => !!plan)
        .map((plan) => ({
          laneId: parent.laneId!,
          gameId: plan!.gameId,
          skillIds: [...plan!.skillIds],
          resources: { medicine: 0, stone: 0, expiringMedicine: 0 },
        }));
      assertAgentContinuationMessageScope(
        principal.prompt,
        scopes,
        [snapshot],
        data.lanes,
        data.profiles,
      );
      return { snapshot, scopes };
    };
    const candidates = data.requests.filter((request) => {
      if (
        request.source !== "daily" ||
        !request.laneId ||
        !["failed", "unknown"].includes(request.status) ||
        !request.finishedAt ||
        request.resolution ||
        arknightsGameDay(new Date(request.startedAt)) !== arknightsGameDay(now)
      )
        return false;
      if (reference && request.id !== reference.parentRequestId) return false;
      if (
        data.goals.some(
          (goal) =>
            goal.attempts.some((a) =>
              a.submission.requestIds.includes(request.id),
            ) ||
            (goal.selection.kind === "continuation" &&
              goal.selection.parentRequestId === request.id &&
              (goal.sessionId !== principal.sessionId ||
                goal.turnId !== principal.turnId)),
        )
      )
        return false;
      if (
        data.requests.some(
          (other) =>
            (other.snapshot.continuation as { parentId?: string } | undefined)
              ?.parentId === request.id,
        )
      )
        return false;
      try {
        deps.assertOwner(principal.sessionId, request.id);
        scopeFor(request);
        return true;
      } catch {
        return false;
      }
    });
    if (candidates.length > 1)
      throw new AgentToolError(
        "DAILY_CONTINUATION_AMBIGUOUS",
        `有多条停止的日常，尚未续跑。请说明要继续哪个账号：${candidates
          .slice(0, 8)
          .map(
            (r) => `${(r.snapshot.lane as DeviceLane).name}（${r.startedAt}）`,
          )
          .join("、")}`,
      );
    const parent = candidates[0];
    if (!parent)
      throw new AgentToolError(
        reference
          ? "DAILY_CONTINUATION_CHANGED"
          : "DAILY_CONTINUATION_NOT_FOUND",
        "没有与当前消息唯一对应的可接管日常；其他会话或已有目标的任务需回原会话继续，其他账号没有因此启动。",
      );
    if (reference && parent.fingerprint !== reference.parentFingerprint)
      throw new AgentToolError(
        "DAILY_CONTINUATION_CHANGED",
        "原日常指纹已变化，不能换用另一条请求续跑",
      );
    const fact = data.startupFacts.find((f) => {
      const fresh = data.requests.find((r) => r.id === f.freshLogin.requestId);
      return (
        fresh &&
        Date.parse(f.reconciledAt) <= now.getTime() &&
        verifyStartupReconciliationFact(
          f,
          parent,
          data.tasks,
          fresh,
          data.tasks,
        )
      );
    });
    if (!fact)
      throw new AgentToolError(
        "DAILY_CONTINUATION_BLOCKED",
        "原日常停在启动阶段，尚缺独立登录、UID 和主页核验的对账事实；先核验对应账号，原失败结果保留。",
      );
    const preview = await deps.preview(parent.id);
    if (
      !preview.canContinue ||
      preview.reasons.length ||
      preview.successorId ||
      preview.needsAcknowledgement ||
      !preview.steps.length ||
      preview.steps.some((step) => step.status !== "pending")
    )
      throw new AgentToolError(
        "DAILY_CONTINUATION_BLOCKED",
        preview.reasons.join("；") ||
          "只有已核对启动失败且全部业务未开始的原日常能从聊天接管；部分执行情况需另行处理。",
      );
    const { snapshot, scopes } = scopeFor(parent);
    const remaining = goalContinuationScopes(preview, parent.laneId!);
    if (JSON.stringify(remaining) !== JSON.stringify(scopes))
      throw new AgentToolError(
        "DAILY_CONTINUATION_CHANGED",
        "原日常剩余范围变化，不能省略或增加业务步骤",
      );
    deps.assertOwner(principal.sessionId, parent.id);
    return {
      fingerprint: parent.fingerprint,
      frozenPlan: {
        kind: "continuation",
        hash: parent.fingerprint,
        parentRequestId: parent.id,
      },
      scopes,
      summary: [
        {
          laneName: snapshot.lane.name,
          games: scopes.map((s) => ({
            gameId: s.gameId,
            title: s.gameId === "arknights" ? "明日方舟" : "阴阳师",
            steps: [...s.skillIds],
          })),
        },
      ],
      payload: {
        snapshots: [snapshot],
        continuation: {
          parentId: parent.id,
          fingerprint: preview.fingerprint,
          selections: preview.defaults,
          acknowledgePartial: false,
        },
      },
    };
  };
}
