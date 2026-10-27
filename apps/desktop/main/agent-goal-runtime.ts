import { randomUUID } from "node:crypto";
import { canonical } from "../../../packages/protocol/canonical";
import {
  AgentToolError,
  type CompiledDraft,
} from "../../../packages/protocol/agent";
import type { AgentRuntimePrincipal } from "../../../packages/protocol/agent-runtime";
import type { GoalRun, GoalScope } from "../../../packages/protocol/agent-goal";
import { createGameGoalTools } from "../../../packages/agent/game-tools";
import { assertAgentGameMessageScope } from "../../../games/agent-message-scope";
import type { GoalService, PreparedGoal } from "./agent-goals";
import type { LaneExecutionSnapshot } from "./lane-snapshot";
import type { PlannerSource } from "../../../packages/protocol/agent-planner";
import type { DeviceLane } from "../../../packages/protocol";
import { agentLaneAlias } from "../../../packages/protocol/lane-alias";
import {
  agentMessageAccountSelection,
  agentMessageSkillSelection,
  gamePreferencePrompt,
} from "../../../games/agent-message-scope";
import { gameMessageAuthority } from "../../../packages/agent/game-message-authority";
import type { DailyContinuationReference } from "./agent-daily-continuation";

export function frozenGoalScopes(
  snapshots: LaneExecutionSnapshot[],
): GoalScope[] {
  return snapshots.flatMap((s) =>
    [s.arknightsPlan, s.onmyojiPlan]
      .filter((p) => !!p)
      .map((p) => ({
        laneId: s.lane.id,
        gameId: p!.gameId,
        skillIds: [...p!.skillIds],
        resources: { medicine: 0, stone: 0, expiringMedicine: 0 },
      })),
  );
}
export interface GoalRuntimeDependencies {
  goals: GoalService;
  assertCurrent(
    principal: AgentRuntimePrincipal,
    plannerRequestId: string,
  ): void | Promise<void>;
  prepareSaved(scope: "saved" | "both"): Promise<PreparedGoal>;
  prepareDraft(
    draft: CompiledDraft,
    plannerRequestId: string,
  ): Promise<PreparedGoal>;
  prepareContinuation?(
    principal: AgentRuntimePrincipal,
    reference?: DailyContinuationReference,
  ): Promise<PreparedGoal>;
  preferences(
    args: Record<string, unknown>,
    principal: AgentRuntimePrincipal,
  ): Promise<unknown>;
  inspect?(goal: GoalRun, signal: AbortSignal): Promise<unknown>;
  validateRequested?(
    principal: AgentRuntimePrincipal,
    prepared: PreparedGoal,
  ): Promise<void>;
  accountLanes?(): Promise<
    (Pick<DeviceLane, "id" | "name"> & Partial<Pick<DeviceLane, "enabled">>)[]
  >;
  now?: () => Date;
  /** Host-only proof from a reviewed local confirmation; never supplied by a model tool. */
  authorizeExecution?(
    principal: AgentRuntimePrincipal,
    prepared: PreparedGoal,
  ): Promise<
    | {
        confirmationId: string;
        fingerprint: string;
        scopes: GoalScope[];
        expiresAt: string;
        maxRetries: 0 | 1 | 2;
      }
    | undefined
  >;
}
function resumeAccountPrompt(
  prompt: string,
  lanes: Pick<DeviceLane, "id" | "name">[],
) {
  const preservedLaneIds: string[] = [];
  const accountPrompt = prompt
    .split(/[，,。；;!?？！\n]/)
    .map((clause) => {
      const match = clause
        .trim()
        .match(/^(?:请)?保留\s*(.+?)\s*(?:的)?已完成(?:的)?(?:结果|进度)$/);
      if (!match) return clause;
      const reference = match[1];
      const singleReference =
        /^(?:(?:账号|账户|槽位)\s*[零〇一二两三四五六七八九十\d]+|[零〇一二两三四五六七八九十\d]+号|第[零〇一二两三四五六七八九十\d]+(?:个)?(?:账号|账户|槽位))$/.test(
          reference,
        ) ||
        lanes.some((lane, index) =>
          [
            lane.id,
            lane.name,
            agentLaneAlias(index),
          ].includes(reference),
        );
      if (!singleReference) return clause;
      const selection = agentMessageAccountSelection(reference, lanes);
      const lane = lanes[selection.explicit[0]];
      if (selection.explicit.length !== 1 || !lane) return clause;
      preservedLaneIds.push(lane.id);
      return "";
    })
    .join("，");
  return { accountPrompt, preservedLaneIds };
}
function completedGoalLane(goal: GoalRun, laneId: string) {
  const scopes = goal.grant.scopes.filter((scope) => scope.laneId === laneId);
  const attempt = goal.attempts
    .slice()
    .reverse()
    .find((candidate) =>
      candidate.review.scopes.some((scope) => scope.laneId === laneId),
    );
  const requestId = attempt?.submission.requestIds.find(
    (id) => id === `${attempt.submission.batchId}:${laneId}`,
  );
  const result = goal.requests.find(
    (request) => request.requestId === requestId,
  );
  return (
    scopes.length > 0 &&
    result?.laneId === laneId &&
    result.status === "succeeded" &&
    result.flowComplete &&
    result.goalSatisfied === true &&
    scopes.every((scope) =>
      scope.skillIds.every((skillId) =>
        result.skills.some(
          (skill) =>
            skill.skillId === skillId &&
            (skill.gameId ?? result.gameId) === scope.gameId &&
            skill.goalSatisfied === true &&
            Number.isFinite(Date.parse(skill.evidenceTimestamp ?? "")) &&
            !!skill.evidenceReference,
        ),
      ),
    )
  );
}
/** The renderer/model cannot supply a principal, grant or frozen launch payload. */
export function createGoalRuntime(deps: GoalRuntimeDependencies) {
  const preparations = new Map<
    string,
    {
      principal: AgentRuntimePrincipal;
      requestId: string;
      scope?: "saved" | "both";
      draft?: CompiledDraft;
      continuation?: DailyContinuationReference;
    }
  >();
  const now = deps.now ?? (() => new Date());
  const key = (p: Pick<AgentRuntimePrincipal, "sessionId" | "turnId">) =>
    `${p.sessionId}:${p.turnId}`;
  const failure = (code: string, message: string) =>
    new AgentToolError(code, message);
  const goalReferences = (prompt: string) => [
    ...new Set(
      [...prompt.matchAll(/\bgoal-[A-Za-z0-9_-]+\b/gi)].map(
        (match) => match[0],
      ),
    ),
  ];
  const validateScope = async (
    principal: AgentRuntimePrincipal,
    prepared: PreparedGoal,
  ) => {
    const payload = prepared.payload as { snapshots?: LaneExecutionSnapshot[] };
    if (prepared.frozenPlan.kind === "continuation") {
      // The host-only preparation validates the exact original account/settings and
      // current resume constraints. Never relabel a resume as a fresh start grant.
      if (!gameMessageAuthority(principal.prompt).resume)
        throw failure("MESSAGE_NOT_AUTHORIZED", "当前消息未要求继续原日常");
      const input = (
        prepared.payload as {
          continuation?: {
            parentId: string;
            fingerprint: string;
            acknowledgePartial: boolean;
          };
        }
      ).continuation;
      if (
        !input ||
        input.parentId !== prepared.frozenPlan.parentRequestId ||
        input.fingerprint !== prepared.frozenPlan.hash ||
        prepared.fingerprint !== input.fingerprint ||
        input.acknowledgePartial ||
        prepared.scopes.some((scope) =>
          Object.values(scope.resources).some((n) => n !== 0),
        )
      )
        throw failure(
          "DAILY_CONTINUATION_CHANGED",
          "原日常续跑范围或父请求无法核对",
        );
      return;
    }
    assertAgentGameMessageScope(
      principal.prompt,
      prepared.scopes,
      payload.snapshots,
      {
        savedDaily: prepared.frozenPlan.kind === "saved-daily",
        ...(deps.accountLanes
          ? { accountLanes: await deps.accountLanes() }
          : {}),
      },
    );
  };
  async function queryTarget(
    principal: AgentRuntimePrincipal,
    goalId: string,
    requestId: string,
  ): Promise<GoalRun> {
    const goal = deps.goals.get(goalId, { sessionId: principal.sessionId });
    const prompt = gamePreferencePrompt(principal.prompt);
    const explicitIds = goalReferences(prompt);
    const ownedIds = deps.goals
      .snapshot(principal.sessionId)
      .goals.map((candidate) => candidate.id);
    const mismatch = () =>
      failure(
        "GOAL_QUERY_TARGET_MISMATCH",
        "该目标与当前消息指定的账号、游戏或目标编号不一致，不能用另一目标的结果作为本次答复依据。",
      );
    if (
      explicitIds.some((id) => !ownedIds.includes(id)) ||
      (explicitIds.length && !explicitIds.includes(goalId))
    )
      throw mismatch();
    const lanes = (await deps.accountLanes?.()) ?? [];
    const accounts = agentMessageAccountSelection(prompt, lanes);
    const selectedLanes = accounts.all
      ? lanes
          .filter(
            (lane, index) =>
              lane.enabled !== false && !accounts.denied.has(index),
          )
          .map((lane) => lane.id)
      : accounts.explicit.map((index) => lanes[index]?.id);
    if (
      accounts.client ||
      selectedLanes.some((id) => !id) ||
      (accounts.all && !lanes.length)
    )
      throw mismatch();
    const laneIds = [
      ...new Set(goal.grant.scopes.map((scope) => scope.laneId)),
    ];
    if (selectedLanes.length) {
      if (!laneIds.some((id) => selectedLanes.includes(id))) throw mismatch();
      if (laneIds.some((id) => !selectedLanes.includes(id)))
        throw failure(
          "GOAL_QUERY_SCOPE_MIXED",
          "该原目标包含多个账号，不能把整套结果视为指定账号的结果；请查看原任务详情或明确查询完整目标。",
        );
    }
    if (
      laneIds.some((id) =>
        lanes.some(
          (lane, index) => lane.id === id && accounts.denied.has(index),
        ),
      )
    )
      throw mismatch();
    const selectedGames: string[] = [
      ...new Set([
        ...(/双游戏|两个游戏/.test(prompt) ? ["arknights", "onmyoji"] : []),
        ...[...prompt.matchAll(/明日方舟|阴阳师/g)].map((match) =>
          match[0] === "明日方舟" ? "arknights" : "onmyoji",
        ),
      ]),
    ];
    const gameIds = [
      ...new Set(goal.grant.scopes.map((scope) => scope.gameId)),
    ];
    if (selectedGames.length) {
      if (!gameIds.some((id) => selectedGames.includes(id))) throw mismatch();
      if (gameIds.some((id) => !selectedGames.includes(id)))
        throw failure(
          "GOAL_QUERY_SCOPE_MIXED",
          "该原目标包含多个游戏，不能把整套结果视为指定游戏的结果；请查看原任务详情或明确查询完整目标。",
        );
    }
    await deps.assertCurrent(principal, requestId);
    return deps.goals.get(goalId, { sessionId: principal.sessionId });
  }
  async function targetFor(
    principal: AgentRuntimePrincipal,
    modelGoalId: string,
    action: "resume" | "cancel",
  ): Promise<GoalRun> {
    const prompt = gamePreferencePrompt(principal.prompt);
    if (
      /(?:改成|换成|更换|切换|修改|调整).{0,16}(?:账号|账户|游戏|任务|计划)|(?:账号|账户|任务|计划).{0,16}(?:改成|换成|修改|调整)/.test(
        prompt,
      )
    )
      throw failure(
        "GOAL_CORRECTION_REQUIRES_NEW_REQUEST",
        "原目标的账号和任务不能通过继续修改，请重新交办完整需求；原结果未知时须先核对。",
      );
    const lanes = (await deps.accountLanes?.()) ?? [];
    const { accountPrompt, preservedLaneIds } =
      action === "resume"
        ? resumeAccountPrompt(prompt, lanes)
        : { accountPrompt: prompt, preservedLaneIds: [] };
    const accounts = agentMessageAccountSelection(accountPrompt, lanes);
    const selectedLanes = accounts.all
      ? lanes
          .filter(
            (lane, index) =>
              lane.enabled !== false && !accounts.denied.has(index),
          )
          .map((lane) => lane.id)
      : accounts.explicit.map((index) => lanes[index]?.id);
    if (accounts.client || selectedLanes.some((id) => !id))
      throw failure(
        "GOAL_TARGET_NOT_FOUND",
        "无法按当前消息核对实际账号，请明确目标卡中的账号或目标编号。",
      );
    const selectedGames: string[] = [
      ...new Set([
        ...(/双游戏|两个游戏/.test(prompt) ? ["arknights", "onmyoji"] : []),
        ...[...prompt.matchAll(/明日方舟|阴阳师/g)].map((match) =>
          match[0] === "明日方舟" ? "arknights" : "onmyoji",
        ),
      ]),
    ];
    const all = deps.goals.snapshot(principal.sessionId).goals;
    const explicitIds = goalReferences(prompt);
    if (explicitIds.some((id) => !all.some((goal) => goal.id === id)))
      throw failure(
        "GOAL_TARGET_NOT_FOUND",
        "当前消息明确指定的目标不在本会话中，不能替换成另一个目标；请核对目标编号。",
      );
    const candidates = all.filter((goal) => {
      if (explicitIds.length && !explicitIds.includes(goal.id)) return false;
      if (
        action === "resume"
          ? ![
              "running",
              "waiting",
              "recovering",
              "needs-user",
              "failed",
              "unknown",
            ].includes(goal.status)
          : ![
              "preparing",
              "running",
              "waiting",
              "recovering",
              "needs-user",
              "failed",
              "unknown",
              "cancelling",
            ].includes(goal.status)
      )
        return false;
      const scopes =
        action === "resume" && goal.recovery
          ? (goal.recovery.remainingScopes ?? [goal.recovery])
          : goal.grant.scopes;
      if (
        preservedLaneIds.some(
          (laneId) =>
            scopes.some((scope) => scope.laneId === laneId) ||
            !completedGoalLane(goal, laneId),
        )
      )
        return false;
      const laneIds = [
        ...new Set(
          (accounts.all ? goal.grant.scopes : scopes).map(
            (scope) => scope.laneId,
          ),
        ),
      ];
      if (
        selectedLanes.length &&
        (laneIds.length !== selectedLanes.length ||
          laneIds.some((id) => !selectedLanes.includes(id)))
      )
        return false;
      if (
        accounts.hasAccountWords &&
        !accounts.explicit.length &&
        !accounts.all
      )
        return false;
      if (
        laneIds.some((id) =>
          lanes.some(
            (lane, index) => lane.id === id && accounts.denied.has(index),
          ),
        )
      )
        return false;
      const gameIds = [...new Set(scopes.map((scope) => scope.gameId))];
      if (
        selectedGames.length &&
        (gameIds.length !== selectedGames.length ||
          gameIds.some((id) => !selectedGames.includes(id)))
      )
        return false;
      if (
        action === "resume" &&
        scopes.some((scope) => {
          const skills = agentMessageSkillSelection(prompt, scope.gameId);
          return (
            skills.denied.some((id) => scope.skillIds.includes(id)) ||
            skills.requested.some(
              (id) =>
                !goal.grant.scopes.some(
                  (originalScope) =>
                    originalScope.gameId === scope.gameId &&
                    originalScope.skillIds.includes(id),
                ),
            ) ||
            (skills.requested.length > 0 &&
              !/日常|每日任务|每日计划/.test(prompt) &&
              scope.skillIds.some(
                (id) => id !== "login" && !skills.requested.includes(id),
              )) ||
            (gameMessageAuthority(prompt).constraints.shopping === false &&
              scope.skillIds.includes("friends"))
          );
        })
      )
        return false;
      return true;
    });
    const choices = candidates
      .slice(0, 8)
      .map(
        (goal) =>
          `${[...new Set(goal.grant.scopes.map((scope) => lanes.find((lane) => lane.id === scope.laneId)?.name ?? scope.laneId))].join("、")} · ${goal.prompt.slice(0, 120)} · ${goal.id}`,
      )
      .join("；");
    if (candidates.length > 1)
      throw failure(
        "GOAL_TARGET_AMBIGUOUS",
        `本会话有多个可操作目标，请指定账号或目标：${choices}`,
      );
    if (!candidates.length)
      throw failure(
        "GOAL_TARGET_NOT_FOUND",
        "当前消息未对应可操作的原目标；若要改变账号、任务或购物条件，请重新交办完整需求，未知结果先核对。",
      );
    if (candidates[0].id !== modelGoalId)
      throw failure(
        "GOAL_TARGET_MISMATCH",
        `当前消息对应的目标是 ${candidates[0].id}，模型选择的另一目标不会执行。`,
      );
    return candidates[0];
  }
  async function start(
    principal: AgentRuntimePrincipal,
    requestId: string,
    prepared: PreparedGoal,
    selection: GoalRun["selection"],
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    await deps.assertCurrent(principal, requestId);
    await validateScope(principal, prepared);
    await deps.validateRequested?.(principal, prepared);
    signal.throwIfAborted();
    const issued = now();
    const confirmation = await deps.authorizeExecution?.(principal, prepared);
    if (
      !confirmation ||
      !/^[A-Za-z0-9_:.-]{1,240}$/.test(confirmation.confirmationId) ||
      confirmation.fingerprint !== prepared.fingerprint ||
      canonical(confirmation.scopes) !== canonical(prepared.scopes) ||
      ![0, 1, 2].includes(confirmation.maxRetries) ||
      !Number.isFinite(Date.parse(confirmation.expiresAt)) ||
      Date.parse(confirmation.expiresAt) <= issued.getTime() ||
      Date.parse(confirmation.expiresAt) > issued.getTime() + 600000
    )
      throw failure(
        "LOCAL_CONFIRMATION_REQUIRED",
        "请在本地核对账号与任务清单并确认执行；自然语言和模型工具不会授予新执行权限。",
      );
    await deps.assertCurrent(principal, requestId);
    signal.throwIfAborted();
    const goal = await deps.goals.create({
      ...principal,
      selection,
      grant: {
        id: `grant-${confirmation.confirmationId}`,
        source: "local-confirmation",
        sessionId: principal.sessionId,
        turnId: principal.turnId,
        issuedAt: issued.toISOString(),
        expiresAt: confirmation.expiresAt,
        maxRetries: confirmation.maxRetries,
        planHash: prepared.fingerprint,
        scopes: prepared.scopes,
      },
    });
    if (signal.aborted) {
      if (!goal.submission) await deps.goals.cancel(goal.id, principal);
      signal.throwIfAborted();
    }
    return deps.goals.submit(goal.id, principal, signal);
  }
  return {
    async prepare(goal: GoalRun): Promise<PreparedGoal> {
      const registered = preparations.get(key(goal));
      if (!registered)
        throw failure(
          "GOAL_PREPARATION_LOST",
          "原目标准备已结束或应用已重启；只核对已有受理，不自动重放新动作",
        );
      await deps.assertCurrent(registered.principal, registered.requestId);
      const prepared = registered.continuation
        ? await deps.prepareContinuation!(
            registered.principal,
            registered.continuation,
          )
        : registered.draft
          ? await deps.prepareDraft(registered.draft, registered.requestId)
          : await deps.prepareSaved(registered.scope!);
      await validateScope(registered.principal, prepared);
      await deps.validateRequested?.(registered.principal, prepared);
      return prepared;
    },
    bind(
      principal: AgentRuntimePrincipal,
      requestId: string,
      source: PlannerSource,
    ) {
      return createGameGoalTools({
        principal,
        source,
        host: {
          assertCurrent: async () => {
            await deps.assertCurrent(principal, requestId);
          },
          runSaved: async (scope, signal) => {
            const prepared = await deps.prepareSaved(scope);
            preparations.set(key(principal), { principal, requestId, scope });
            return start(
              principal,
              requestId,
              prepared,
              {
                kind: "saved-daily",
                dailyScope: scope,
                laneIds: [...new Set(prepared.scopes.map((s) => s.laneId))],
              },
              signal,
            );
          },
          runPlan: async (draft, signal) => {
            const prepared = await deps.prepareDraft(draft, requestId);
            preparations.set(key(principal), {
              principal,
              requestId,
              draft: structuredClone(draft),
            });
            return start(
              principal,
              requestId,
              prepared,
              {
                kind: "custom",
                plannerRequestId: requestId,
                planHash: draft.planHash,
                laneIds: [...new Set(prepared.scopes.map((s) => s.laneId))],
              },
              signal,
            );
          },
          ...(deps.prepareContinuation
            ? {
                resumeDaily: async (signal: AbortSignal) => {
                  await deps.assertCurrent(principal, requestId);
                  const prepared = await deps.prepareContinuation!(principal);
                  const continuation = {
                    parentRequestId: prepared.frozenPlan.parentRequestId!,
                    parentFingerprint: prepared.frozenPlan.hash,
                  };
                  preparations.set(key(principal), {
                    principal,
                    requestId,
                    continuation,
                  });
                  return start(
                    principal,
                    requestId,
                    prepared,
                    {
                      kind: "continuation",
                      ...continuation,
                      laneIds: [
                        ...new Set(
                          prepared.scopes.map((scope) => scope.laneId),
                        ),
                      ],
                    },
                    signal,
                  );
                },
              }
            : {}),
          read: (goalId) => queryTarget(principal, goalId, requestId),
          inspect: async (goalId, signal) => {
            const goal = await queryTarget(principal, goalId, requestId);
            if (!deps.inspect)
              throw failure(
                "OBSERVATION_UNAVAILABLE",
                "当前宿主未提供现场观察",
              );
            const observation = await deps.inspect(goal, signal);
            await queryTarget(principal, goalId, requestId);
            return observation;
          },
          wait: async (goalId, timeoutMs) => {
            await queryTarget(principal, goalId, requestId);
            await deps.goals.wait(
              goalId,
              { sessionId: principal.sessionId },
              { timeoutMs: Math.min(timeoutMs, 10000) },
            );
            return queryTarget(principal, goalId, requestId);
          },
          cancel: async (goalId) => {
            await deps.assertCurrent(principal, requestId);
            await targetFor(principal, goalId, "cancel");
            await deps.assertCurrent(principal, requestId);
            return deps.goals.cancel(goalId, {
              sessionId: principal.sessionId,
            });
          },
          resume: async (goalId) => {
            await deps.assertCurrent(principal, requestId);
            const original = await targetFor(principal, goalId, "resume");
            await deps.goals.refresh(goalId);
            await deps.assertCurrent(principal, requestId);
            const refreshed = await targetFor(principal, goalId, "resume");
            if (["running", "waiting"].includes(refreshed.status))
              return refreshed;
            return deps.goals.recover(goalId, {
              sessionId: original.sessionId,
              turnId: original.turnId,
            });
          },
          preferences: async (args) => {
            await deps.assertCurrent(principal, requestId);
            return deps.preferences(args, principal);
          },
        },
      });
    },
  };
}
