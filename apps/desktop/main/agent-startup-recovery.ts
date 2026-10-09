import { canonical } from "../../../packages/acceptance/files";
import { AgentToolError } from "../../../packages/protocol/agent";
import type {
  GoalRecoveryReference,
  GoalRun,
} from "../../../packages/protocol/agent-goal";
import { goalContinuationScopes } from "../../../games/goal-continuation";
import { games } from "../../../games/registry";
import type { ContinuationService } from "./continuation-service";
import type { GoalService, PreparedGoal } from "./agent-goals";

/** Registers host evidence only; neither observation nor restoration dispatches work. */
export function createGoalStartupRecovery(
  continuations: Pick<ContinuationService, "startupRecovery">,
  now = () => new Date(),
) {
  type Evidence = NonNullable<
    Awaited<ReturnType<ContinuationService["startupRecovery"]>>
  >;
  const registered = new Map<
    string,
    { goalId: string; evidence: Evidence; reference: GoalRecoveryReference }
  >();
  const completions = new Map<string, Promise<void>>();
  const owns = (goal: GoalRun, ref: GoalRecoveryReference) => {
    const entry = registered.get(ref.reference);
    return (
      !!entry &&
      entry.goalId === goal.id &&
      canonical(entry.reference) === canonical(ref)
    );
  };
  return {
    owns,
    async find(
      goal: GoalRun,
      candidates: string[],
    ): Promise<GoalRecoveryReference | undefined> {
      if (
        !goal.originalReview ||
        goal.cancelledAt ||
        goal.grant.revokedAt ||
        goal.retryCount >= Math.min(2, goal.grant.maxRetries) ||
        now().getTime() >= Date.parse(goal.grant.expiresAt)
      )
        return;
      for (const requestId of candidates) {
        const evidence = await continuations.startupRecovery(requestId);
        if (!evidence) continue;
        const attempt = goal.attempts.find((a) =>
          a.submission.requestIds.includes(requestId),
        );
        const laneId = attempt?.review.scopes.find(
          (s) => requestId === `${attempt.submission.batchId}:${s.laneId}`,
        )?.laneId;
        if (!laneId) continue;
        const remainingScopes = goalContinuationScopes(
          evidence.preview,
          laneId,
          evidence.proof,
        ).map((scope) => ({
          ...scope,
          resources: {
            ...goal.originalReview!.scopes.find(
              (original) =>
                original.laneId === scope.laneId &&
                original.gameId === scope.gameId,
            )?.resources,
          },
        }));
        const first = remainingScopes[0];
        if (!first) continue;
        const ref: GoalRecoveryReference = {
          ...first,
          requestId,
          remainingScopes,
          reference: `startup:${requestId}:${evidence.proof.fingerprint}`,
          safety: {
            kind: "native-not-submitted",
            nativeSubmission: "not-submitted",
            accountProof: "login-gate-before-effects",
            fingerprint: evidence.proof.fingerprint,
            observedAt: now().toISOString(),
          },
        };
        registered.set(ref.reference, {
          goalId: goal.id,
          evidence,
          reference: structuredClone(ref),
        });
        return ref;
      }
    },
    async prepare(
      goal: GoalRun,
      ref: GoalRecoveryReference,
    ): Promise<PreparedGoal> {
      const prior = registered.get(ref.reference);
      const fresh = await continuations.startupRecovery(ref.requestId);
      if (
        !owns(goal, ref) ||
        !prior ||
        !fresh ||
        fresh.proof.parentId !== prior.evidence.proof.parentId ||
        fresh.proof.fingerprint !== prior.evidence.proof.fingerprint ||
        canonical(fresh.preview) !== canonical(prior.evidence.preview)
      )
        throw new AgentToolError(
          "RECOVERY_CHANGED",
          "启动前未提交证明、冻结绑定或剩余计划已变化，不能执行旧恢复。",
        );
      return {
        fingerprint: fresh.preview.fingerprint,
        frozenPlan: {
          kind: "continuation",
          hash: fresh.preview.fingerprint,
          parentRequestId: ref.requestId,
        },
        scopes: structuredClone(ref.remainingScopes ?? [ref]),
        summary: [
          {
            laneName: fresh.preview.laneName,
            games: (ref.remainingScopes ?? [ref]).map((scope) => ({
              gameId: scope.gameId,
              title:
                games.find((game) => game.id === scope.gameId)?.name ??
                scope.gameId,
              steps: [...scope.skillIds],
            })),
          },
        ],
        payload: {
          continuation: {
            parentId: ref.requestId,
            fingerprint: fresh.preview.fingerprint,
            selections: fresh.preview.defaults,
            acknowledgePartial: false,
          },
        },
      };
    },
    /** Called only by jobs accepted in this process, never by refresh/reconcile/startup. */
    settled(
      goals: Pick<GoalService, "refresh" | "recover">,
      goalId: string,
    ): Promise<void> {
      const previous = completions.get(goalId) ?? Promise.resolve();
      const next = previous
        .catch(() => {})
        .then(async () => {
          const goal = (await goals.refresh(goalId)).find(
            (g) => g.id === goalId,
          );
          if (
            goal?.status === "recovering" &&
            goal.recovery &&
            owns(goal, goal.recovery)
          )
            await goals.recover(goal.id, {
              sessionId: goal.sessionId,
              turnId: goal.turnId,
            });
        });
      completions.set(goalId, next);
      void next
        .finally(() => {
          if (completions.get(goalId) === next) completions.delete(goalId);
        })
        .catch(() => {});
      return next;
    },
  };
}
