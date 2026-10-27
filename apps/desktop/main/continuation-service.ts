import type {
  ContinuationInput,
  ContinuationPreview,
} from "../../../packages/protocol/continuation";
import type { LaneExecutionSnapshot } from "./lane-snapshot";
import { freezeLaneDevice } from "./lane-device";
import type {
  ExecutionCoordinator,
  ExecutionLease,
} from "./execution-coordinator";
import type { RunLedger } from "./run-ledger";
import type { ExecutionDetailService } from "./execution-detail";
import type { DeviceLanes } from "../../../packages/protocol";
import type { ArknightsProfiles } from "../../../games/arknights/config";
import {
  validateDeviceLanes,
  type DeviceLane,
} from "../../../packages/protocol";
import { validateRequestId } from "../../../packages/protocol/execution";
import {
  previewDailyContinuation,
  continuationPlans,
} from "../../../games/continuation";
import {
  assertContinuationHistory,
  ContinuationHistoryError,
} from "../../../games/continuation-history";
import {
  validateArknightsConfig,
  type ArknightsProfile,
} from "../../../games/arknights/config";
import { arknightsConfigForPlan } from "../../../games/arknights/daily-plan";
import { mumuResource } from "./execution-coordinator";
import { randomUUID } from "node:crypto";
import type {
  ContinuationSelection,
  ContinuationLink,
} from "../../../packages/protocol/continuation";
import type { StartupReconciliationFact } from "../../../packages/protocol/startup-reconciliation";
import { startupFailureProof } from "../../../games/startup-continuation";

export type ContinuationLauncher = (
  frozen: LaneExecutionSnapshot,
  batchId: string,
  lease: ExecutionLease,
) => Promise<unknown>;
export interface GoalContinuationSubmission {
  batchId: string;
  origin?: { requestId: string; kind: "continue" };
}

export class ContinuationService {
  private pending = new Set<string>();
  constructor(
    private deps: {
      executions: ExecutionCoordinator;
      ledger: RunLedger;
      details: ExecutionDetailService;
      lanes: () => Promise<DeviceLanes>;
      profiles: () => Promise<ArknightsProfiles>;
      appVersion: string;
      now?: () => Date;
      /** Host store verifies both original and fresh ledgers before exposing facts. */
      startupFacts?: () => StartupReconciliationFact[];
      assertCanStart?: (lane: DeviceLane) => Promise<void>;
    },
  ) {}
  private async context(id: string) {
    validateRequestId(id);
    this.deps.executions.assertHealthy();
    this.deps.ledger.assertHealthy();
    const [lanes, profiles] = await Promise.all([
      this.deps.lanes(),
      this.deps.profiles(),
    ]);
    await this.deps.ledger.flush();
    this.deps.executions.assertHealthy();
    const parent = this.deps.executions.get(id);
    const detail = this.deps.details.get(id);
    const now = (this.deps.now ?? (() => new Date()))();
    const startupFacts = this.deps.startupFacts?.() ?? [];
    const requests = this.deps.executions.snapshot(Number.MAX_SAFE_INTEGER);
    const tasks = this.deps.ledger.snapshot(Number.MAX_SAFE_INTEGER);
    const startupFailure = startupFailureProof(
      parent,
      requests,
      tasks,
      now,
      undefined,
      startupFacts,
    );
    const preview = previewDailyContinuation(
      detail,
      parent,
      now,
      startupFacts,
      startupFailure,
    );
    // Keep the original classifications for the immutable child link: an
    // independently blocked failed/pending item is explicitly excluded when
    // the user acknowledges a subset, never silently rewritten as completed.
    const originalSteps = structuredClone(preview.steps);
    let original: DeviceLane | undefined;
    let profile: ArknightsProfile | undefined;
    try {
      original = validateDeviceLanes({
        version: 1,
        lanes: [parent.snapshot.lane],
      }).lanes[0];
      const current = lanes.lanes.find((l) => l.id === parent.laneId);
      const originalGameIds = [
        parent.snapshot.arknightsPlan,
        parent.snapshot.onmyojiPlan,
      ]
        .filter(
          (plan): plan is import("../../../packages/protocol").Plan => !!plan,
        )
        .map((plan) => plan.gameId);
      const currentDevice =
        current && freezeLaneDevice(current, originalGameIds);
      // Historical execution targets are immutable, including legacy snapshots.
      delete original.deviceInstances;
      const resource = mumuResource(original.managerPath, original.instance);
      if (
        original.id !== parent.laneId ||
        !current?.enabled ||
        resource === "*" ||
        !currentDevice ||
        mumuResource(currentDevice.managerPath, currentDevice.instance) !==
          resource ||
        current.arknights.profileId !== original.arknights.profileId ||
        parent.resources.length !== 1 ||
        parent.resources[0] !== resource
      )
        throw Error("设备或账号绑定已变化，不能沿旧进度续跑");
      if (
        parent.snapshot.profile !== undefined ||
        parent.snapshot.arknightsPlan !== undefined
      ) {
        const saved = parent.snapshot.profile as ArknightsProfile;
        const { id: profileId, name, ...settings } = saved;
        const config = validateArknightsConfig(settings);
        const currentProfile = profiles.profiles.find(
          (p) => p.id === profileId,
        );
        if (
          profileId !== original.arknights.profileId ||
          typeof name !== "string" ||
          !config.expectedUid ||
          !currentProfile ||
          currentProfile.expectedUid !== config.expectedUid ||
          currentProfile.clientType !== config.clientType
        )
          throw Error("原账号UID或客户端绑定已变化，不能续跑");
        profile = { id: profileId, name, ...config };
      }
    } catch (error) {
      preview.reasons.push(
        error instanceof Error ? error.message : "原账号配置不完整",
      );
    }
    const raw = this.deps.ledger.forExecution(id);
    for (const game of detail.games) {
      if (!game.record && raw.some((t) => t.gameId === game.plan.gameId))
        preview.reasons.push(
          `${game.plan.gameId}存在无法唯一关联的旧步骤，不能跳过或重做`,
        );
    }
    if (preview.canContinue && !preview.reasons.length) {
      const historyReasons: string[] = [];
      for (const selection of preview.defaults) {
        for (const skillId of selection.skillIds) {
          try {
            const proposed = continuationPlans(
              preview,
              {
                parentId: id,
                fingerprint: preview.fingerprint,
                selections: [{ gameId: selection.gameId, skillIds: [skillId] }],
                acknowledgePartial: true,
              },
              startupFacts,
              startupFailure,
            );
            assertContinuationHistory(
              parent,
              requests,
              tasks,
              proposed,
              now,
              startupFacts,
            );
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : "同设备业务历史待核对，不能续跑";
            if (error instanceof ContinuationHistoryError) {
              preview.reasons.push(message);
              continue;
            }
            historyReasons.push(message);
            const step = preview.steps.find(
              (step) =>
                step.gameId === selection.gameId && step.skillId === skillId,
            )!;
            step.status = "blocked";
            step.message = message;
          }
        }
      }
      preview.defaults = preview.defaults
        .map((selection) => ({
          ...selection,
          skillIds: selection.skillIds.filter((skillId) =>
            preview.steps.some(
              (step) =>
                step.gameId === selection.gameId &&
                step.skillId === skillId &&
                ["retry", "pending"].includes(step.status),
            ),
          ),
        }))
        .filter((selection) => selection.skillIds.length);
      if (historyReasons.length) preview.needsAcknowledgement = true;
      if (!preview.defaults.length)
        preview.reasons.push(...historyReasons, "没有可安全续跑的业务任务");
    }
    const successor = requests.find(
      (r) =>
        (r.snapshot.continuation as ContinuationLink | undefined)?.parentId ===
        id,
    );
    if (successor) {
      preview.successorId = successor.id;
      preview.reasons.push("此请求已有续跑记录，请在后续任务查看进度");
    }
    preview.reasons = [...new Set(preview.reasons)];
    preview.canContinue = preview.canContinue && !preview.reasons.length;
    return {
      parent,
      preview,
      originalSteps,
      original,
      profile,
      now,
      startupFacts,
      startupFailure,
    };
  }
  async preview(id: string): Promise<ContinuationPreview> {
    return (await this.context(id)).preview;
  }
  /** Host-only evidence: no model output or projected absence can authorize a retry. */
  async startupRecovery(id: string) {
    const context = await this.context(id);
    if (
      !context.startupFailure ||
      !context.preview.canContinue ||
      context.preview.reasons.length ||
      context.preview.needsAcknowledgement ||
      context.preview.steps.some((step) => step.status !== "pending")
    )
      return;
    const plans = continuationPlans(
      context.preview,
      {
        parentId: id,
        fingerprint: context.preview.fingerprint,
        selections: context.preview.defaults,
        acknowledgePartial: false,
      },
      context.startupFacts,
      context.startupFailure,
    );
    const selected = plans.flatMap((plan) =>
      plan.skillIds.map((skillId) => [plan.gameId, skillId]),
    );
    const frozen = context.originalSteps.map((step) => [
      step.gameId,
      step.skillId,
    ]);
    if (JSON.stringify(selected) !== JSON.stringify(frozen)) return;
    return { proof: context.startupFailure, preview: context.preview };
  }
  async start(
    input: ContinuationInput,
    launch: ContinuationLauncher,
    signal?: AbortSignal,
    hostOrigin?: { requestId: string; kind: "continue" },
  ) {
    return this.startChecked(input, launch, signal, hostOrigin);
  }
  /** Host-only binding to a durably reserved Goal batch. Public IPC still calls start(). */
  async startForGoal(
    input: ContinuationInput,
    launch: ContinuationLauncher,
    signal: AbortSignal | undefined,
    submission: GoalContinuationSubmission,
  ) {
    if (
      !submission ||
      typeof submission !== "object" ||
      Object.keys(submission).some(
        (key) => !["batchId", "origin"].includes(key),
      )
    )
      throw Error("目标续跑受理绑定无效");
    const batchId = validateRequestId(submission.batchId);
    return this.startChecked(input, launch, signal, submission.origin, batchId);
  }
  private async startChecked(
    input: ContinuationInput,
    launch: ContinuationLauncher,
    signal?: AbortSignal,
    hostOrigin?: { requestId: string; kind: "continue" },
    reservedBatchId?: string,
  ) {
    signal?.throwIfAborted();
    if (!input || typeof input !== "object") throw Error("续跑参数无效");
    const id = validateRequestId(input.parentId);
    if (this.pending.has(id)) throw Error("此请求正在启动续跑，请勿重复点击");
    this.pending.add(id);
    try {
      const context = await this.context(id);
      const plans = continuationPlans(
        context.preview,
        input,
        context.startupFacts,
        context.startupFailure,
      );
      assertContinuationHistory(
        context.parent,
        this.deps.executions.snapshot(Number.MAX_SAFE_INTEGER),
        this.deps.ledger.snapshot(Number.MAX_SAFE_INTEGER),
        plans,
        context.now,
        context.startupFacts,
      );
      const lane = structuredClone(context.original!);
      lane.arknights.enabled = plans.some((p) => p.gameId === "arknights");
      lane.onmyoji.enabled = plans.some((p) => p.gameId === "onmyoji");
      await this.deps.assertCanStart?.(lane);
      // Re-read after asynchronous admission checks, before taking the device lease.
      const latest = await this.context(id);
      continuationPlans(
        latest.preview,
        input,
        latest.startupFacts,
        latest.startupFailure,
      );
      assertContinuationHistory(
        latest.parent,
        this.deps.executions.snapshot(Number.MAX_SAFE_INTEGER),
        this.deps.ledger.snapshot(Number.MAX_SAFE_INTEGER),
        plans,
        latest.now,
        latest.startupFacts,
      );
      signal?.throwIfAborted();
      const frozen: LaneExecutionSnapshot = {
        lane,
        startedAt: latest.now.toISOString(),
        arknightsPlan: plans.find((p) => p.gameId === "arknights"),
        onmyojiPlan: plans.find((p) => p.gameId === "onmyoji"),
      };
      if (latest.profile)
        frozen.profile = frozen.arknightsPlan
          ? {
              ...latest.profile,
              ...arknightsConfigForPlan(latest.profile, frozen.arknightsPlan),
            }
          : latest.profile;
      const group = (
        status: "retained" | "excluded",
      ): ContinuationSelection[] => {
        const selections: ContinuationSelection[] = [];
        for (const step of latest.originalSteps) {
          if (step.skillId === "login") continue;
          if (
            status === "retained"
              ? step.status !== "retained"
              : !["pending", "retry", "excluded"].includes(step.status) ||
                plans.some(
                  (p) =>
                    p.gameId === step.gameId &&
                    p.skillIds.includes(step.skillId),
                )
          )
            continue;
          let g = selections.find((g) => g.gameId === step.gameId);
          if (!g) {
            g = { gameId: step.gameId, skillIds: [] };
            selections.push(g);
          }
          g.skillIds.push(step.skillId);
        }
        return selections;
      };
      const link: ContinuationLink = {
        parentId: id,
        parentFingerprint: latest.parent.fingerprint,
        retained: group("retained"),
        excluded: group("excluded"),
        acknowledgedPartial: input.acknowledgePartial,
      };
      const batchId = reservedBatchId ?? `continue-${randomUUID()}`,
        requestId = `${batchId}:${lane.id}`;
      const lease = await this.deps.executions.begin(
        {
          id: requestId,
          source: "daily",
          laneId: lane.id,
          batchId,
          resources: [mumuResource(lane.managerPath, lane.instance)],
          snapshot: {
            appVersion: this.deps.appVersion,
            ...frozen,
            continuation: link,
            ...(hostOrigin
              ? {
                  agent: {
                    requestId: validateRequestId(hostOrigin.requestId),
                    kind: hostOrigin.kind,
                  },
                }
              : {}),
          },
        },
        signal,
      );
      void Promise.resolve()
        .then(() => {
          signal?.throwIfAborted();
          return launch(frozen, batchId, lease);
        })
        .catch(async (error) => {
          await lease.finish(
            error instanceof Error && error.name === "AbortError"
              ? "cancelled"
              : "unknown",
            String(error),
          );
        })
        .catch(() => {});
      return { requestId, batchId };
    } finally {
      this.pending.delete(id);
    }
  }
}
