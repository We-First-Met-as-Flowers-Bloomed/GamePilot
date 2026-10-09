import { randomUUID } from "node:crypto";
import {
  AgentToolError,
  agentObject,
  agentString,
} from "../../../packages/protocol/agent";
import {
  agentExecutionActive,
  type AgentExecutionTarget,
  type AgentExecutionView,
} from "../../../packages/protocol/agent-execution";
import { compileGameDraft } from "../../../games/agent";
import type { LaneExecutionSnapshot } from "./lane-snapshot";

interface Dependencies {
  validate(
    target: AgentExecutionTarget,
  ): Promise<{ fingerprint: string; snapshots: LaneExecutionSnapshot[] }>;
  /** Resolves only after all lanes are admitted; failures must release every lease. */
  launch(
    snapshots: LaneExecutionSnapshot[],
    batchId: string,
    signal: AbortSignal,
  ): Promise<{ jobs: { laneId: string; job: Promise<unknown> }[] }>;
  stop(laneIds: string[], batchId: string): Promise<void>;
  now?: () => Date;
}
function targetInput(input: unknown, confirmation = false) {
  const v = agentObject(
    input,
    confirmation
      ? ["requestId", "planHash", "reviewId"]
      : ["requestId", "planHash"],
  );
  const requestId = agentString(v.requestId, "规划请求编号");
  const planHash = agentString(v.planHash, "计划校验值");
  if (!/^[a-f0-9]{64}$/.test(planHash))
    throw new AgentToolError("INVALID_INPUT", "计划校验值无效");
  return {
    requestId,
    planHash,
    ...(confirmation ? { reviewId: agentString(v.reviewId, "确认编号") } : {}),
  };
}

/** Human confirmation boundary. No method is registered as a model tool. */
export class AgentExecutionService {
  private state: AgentExecutionView = {
    revision: 0,
    status: "idle",
    message: "尚未检查执行条件",
    lanes: [],
  };
  private fingerprint?: string;
  private controller?: AbortController;
  private consumed = new Set<string>();
  private closed = false;
  private validating = false;
  private now: () => Date;
  constructor(private deps: Dependencies) {
    this.now = deps.now ?? (() => new Date());
  }
  snapshot(): AgentExecutionView {
    return structuredClone(this.state);
  }
  /** IPC retries must be answered before external busy guards. */
  existingConfirmation(input: unknown): AgentExecutionView | undefined {
    const target = targetInput(input, true);
    if (
      target.requestId === this.state.requestId &&
      target.planHash === this.state.planHash &&
      target.reviewId === this.state.reviewId &&
      (this.consumed.has(target.requestId) || this.state.status === "starting")
    )
      return this.snapshot();
    return undefined;
  }
  private update(patch: Partial<AgentExecutionView>) {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
  }
  get active() {
    return this.validating || agentExecutionActive(this.state);
  }
  private blocked(error: unknown) {
    this.update({
      status: "blocked",
      message:
        error instanceof AgentToolError
          ? error.message
          : "执行条件无法完整核对，请检查账号与任务记录后重新检查。",
    });
    return this.snapshot();
  }
  async review(input: unknown): Promise<AgentExecutionView> {
    const target = targetInput(input);
    if (this.closed || this.active)
      throw new AgentToolError(
        "EXECUTION_BUSY",
        "确认或任务正在进行，请等待结束或停止",
      );
    if (this.consumed.has(target.requestId))
      throw new AgentToolError(
        "ALREADY_SUBMITTED",
        "此草稿已提交过，请查看原任务记录，不能重复执行",
      );
    const controller = new AbortController();
    this.controller = controller;
    this.validating = true;
    this.fingerprint = undefined;
    this.state = {
      revision: this.state.revision + 1,
      ...target,
      status: "checking",
      message: "正在核对账号与执行记录，尚未操作游戏",
      lanes: [],
    };
    try {
      const prepared = await this.deps.validate({
        requestId: target.requestId,
        planHash: target.planHash,
      });
      controller.signal.throwIfAborted();
      this.fingerprint = prepared.fingerprint;
      this.update({
        status: "ready",
        reviewId: randomUUID(),
        expiresAt: new Date(this.now().getTime() + 120_000).toISOString(),
        message: "请核对本次账号与任务；确认后立即运行，不修改每日计划。",
        lanes: prepared.snapshots.map((s) => {
          const games = [s.arknightsPlan, s.onmyojiPlan]
            .filter((plan) => plan !== undefined)
            .map((plan) => ({
              gameId: plan.gameId,
              skillIds: [...plan.skillIds],
              parameters: compileGameDraft(
                { gameId: plan.gameId, skillIds: plan.skillIds },
                s.lane,
                s.profile,
                s.startedAt,
              ).parameters,
            }));
          return {
            laneId: s.lane.id,
            name: s.lane.name,
            instance: s.lane.instance,
            profileName: s.profile?.name ?? s.lane.name,
            ...(games.length === 1 ? { gameId: games[0].gameId } : {}),
            games,
            skillIds: games.flatMap((game) => game.skillIds),
            parameters: games.length === 1 ? games[0].parameters : {},
          };
        }),
      });
    } catch (error) {
      if (controller.signal.aborted)
        this.update({
          status: "cancelled",
          message: "检查已取消，没有启动游戏",
        });
      else this.blocked(error);
    }
    this.validating = false;
    return this.snapshot();
  }
  async confirm(input: unknown): Promise<AgentExecutionView> {
    const target = targetInput(input, true);
    if (
      target.requestId !== this.state.requestId ||
      target.planHash !== this.state.planHash ||
      target.reviewId !== this.state.reviewId
    )
      throw new AgentToolError(
        "REVIEW_MISMATCH",
        "确认卡与当前草稿不一致，请重新检查",
      );
    if (this.consumed.has(target.requestId) || this.state.status === "starting")
      return this.snapshot();
    if (this.closed || this.state.status !== "ready")
      throw new AgentToolError("NOT_READY", "请先检查执行条件");
    if (this.now().getTime() >= Date.parse(this.state.expiresAt!))
      return this.blocked(
        new AgentToolError(
          "REVIEW_EXPIRED",
          "确认卡已过期，请重新检查执行条件",
        ),
      );
    const controller = new AbortController();
    this.controller = controller;
    this.validating = true;
    this.update({ status: "starting", message: "正在重新核对并受理本次任务" });
    let submitted = false;
    try {
      const prepared = await this.deps.validate({
        requestId: target.requestId,
        planHash: target.planHash,
      });
      controller.signal.throwIfAborted();
      if (
        prepared.fingerprint !== this.fingerprint ||
        this.now().getTime() >= Date.parse(this.state.expiresAt!)
      )
        throw new AgentToolError(
          "REVIEW_CHANGED",
          "账号、任务记录或确认时间已变化，请重新检查",
        );
      // Consume before admission: errors or a lost IPC response must never replay a batch.
      this.consumed.add(target.requestId);
      submitted = true;
      const batchId = `agent-${randomUUID()}`;
      this.update({
        batchId,
        lanes: this.state.lanes.map((l) => ({
          ...l,
          executionId: `${batchId}:${l.laneId}`,
          status: "running",
        })),
      });
      const { jobs } = await this.deps.launch(
        prepared.snapshots,
        batchId,
        controller.signal,
      );
      this.update({
        status: controller.signal.aborted ? "stopping" : "running",
        message: controller.signal.aborted
          ? "正在停止本次任务"
          : "任务已交给游戏执行器，完成情况以任务记录为准",
      });
      void Promise.all(
        jobs.map(async ({ laneId, job }) => {
          let status: "succeeded" | "cancelled" | "unknown";
          try {
            await job;
            status = "succeeded";
          } catch (error) {
            status =
              error instanceof Error && error.name === "AbortError"
                ? "cancelled"
                : "unknown";
          }
          this.update({
            lanes: this.state.lanes.map((l) =>
              l.laneId === laneId ? { ...l, status } : l,
            ),
          });
        }),
      ).then(() => {
        const status = this.state.lanes.some((l) => l.status === "unknown")
          ? "unknown"
          : this.state.lanes.some((l) => l.status === "cancelled")
            ? "cancelled"
            : "succeeded";
        this.update({
          status,
          message:
            status === "succeeded"
              ? "本次所选任务的执行流程已结束；未标记整套每日计划完成。"
              : status === "cancelled"
                ? "本次任务已停止，请查看各账号已执行的步骤。"
                : "部分任务结果无法确认，请查看任务记录与现场；不会自动重跑。",
        });
      });
    } catch (error) {
      if (submitted)
        this.update({
          status: controller.signal.aborted ? "cancelled" : "unknown",
          lanes: this.state.lanes.map((l) => ({
            ...l,
            status: controller.signal.aborted ? "cancelled" : "unknown",
          })),
          message: "本次受理未完成，请核对任务记录；此草稿不会重复提交。",
        });
      else if (controller.signal.aborted)
        this.update({
          status: "cancelled",
          message: "启动已取消，没有启动游戏",
        });
      else this.blocked(error);
    }
    this.validating = false;
    return this.snapshot();
  }
  async cancel(requestId: unknown): Promise<AgentExecutionView> {
    if (requestId !== this.state.requestId)
      throw new AgentToolError("REQUEST_MISMATCH", "执行请求编号不符");
    const wasActive = this.active;
    this.controller?.abort();
    if (["checking", "ready"].includes(this.state.status))
      this.update({ status: "cancelled", message: "确认已取消，没有启动游戏" });
    else if (wasActive) {
      this.update({ status: "stopping", message: "正在停止本次任务" });
      if (this.state.batchId)
        await this.deps.stop(
          this.state.lanes
            .filter((l) => l.status === "running")
            .map((l) => l.laneId),
          this.state.batchId,
        );
    }
    return this.snapshot();
  }
  async close() {
    this.closed = true;
    if (this.state.requestId && this.active)
      await this.cancel(this.state.requestId);
  }
}
