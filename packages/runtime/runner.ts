import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  TaskFaultError,
  type FailureCapture,
  type FailureEvidence,
} from "../protocol/fault";
import {
  validatePlan,
  type Game,
  type Plan,
  type RunEvent,
  type RunStatus,
  type SkillResult,
} from "../protocol";
import {
  validatePauseAfterStepInput,
  type PauseAfterStepReceipt,
} from "../protocol/step-control";
export type ControlledRunEvent = RunEvent & {
  stepControl?: PauseAfterStepReceipt;
};
export type ExecuteSkill = (
  id: string,
  signal: AbortSignal,
  log: (message: string, result?: SkillResult) => void,
  plan: Plan,
) => Promise<void | SkillResult>;
export class Runner {
  private active?: {
    id: string;
    gameId: string;
    abort: AbortController;
    finished: Promise<void>;
    phase: "executing" | "settling" | "terminal";
    stepId?: string;
    pause?: PauseAfterStepReceipt;
  };
  constructor(
    private games: Game[],
    private emit: (event: ControlledRunEvent) => void,
    private execute?: ExecuteSkill,
    private captureFailure?: (signal: AbortSignal) => Promise<FailureCapture>,
  ) {}
  get busy(): boolean {
    return Boolean(this.active);
  }
  start(input: Plan): { runId: string; finished: Promise<void> } {
    if (this.active) throw new Error("已有任务正在运行，请先停止");
    const plan = validatePlan(input, this.games);
    const id = randomUUID(),
      abort = new AbortController();
    // Defer execution so the active lock exists before the first event.
    const finished = Promise.resolve()
      .then(() => this.run(id, plan, abort.signal))
      .finally(() => {
        if (this.active?.id === id) this.active = undefined;
      });
    this.active = {
      id,
      gameId: plan.gameId,
      abort,
      finished,
      phase: "executing",
    };
    return { runId: id, finished };
  }
  pauseAfterStep(input: unknown): PauseAfterStepReceipt {
    const command = validatePauseAfterStepInput(input),
      active = this.active;
    if (!active) throw Error("没有正在执行的任务，不能排队步骤边界暂停");
    if (active.id !== command.runId)
      throw Error("原run已变化，不能控制其他任务");
    if (
      active.abort.signal.aborted ||
      active.phase !== "executing" ||
      !active.stepId
    )
      throw Error("任务未在执行步骤、已经停止或正在结算失败，不能排队暂停");
    if (active.pause) return structuredClone(active.pause);
    active.pause = { ...command, status: "queued" };
    this.emit({
      runId: active.id,
      gameId: active.gameId,
      type: "log",
      skillId: active.stepId,
      message: "步骤边界暂停请求已排队；当前任务继续完成，不开始后续任务",
      at: new Date().toISOString(),
      stepControl: structuredClone(active.pause),
    });
    return structuredClone(active.pause);
  }
  private status(
    id: string,
    status: RunStatus,
    message: string,
    stepControl?: PauseAfterStepReceipt,
  ) {
    this.emit({
      runId: id,
      gameId: this.active?.gameId,
      type: "status",
      status,
      message,
      at: new Date().toISOString(),
      ...(stepControl ? { stepControl: structuredClone(stepControl) } : {}),
    });
  }
  private async run(id: string, plan: Plan, signal: AbortSignal) {
    let currentStep = "";
    let currentId = "";
    try {
      this.emit({
        runId: id,
        gameId: plan.gameId,
        type: "status",
        status: "queued",
        plan: { ...plan, skillIds: [...plan.skillIds] },
        message: "计划已通过校验",
        at: new Date().toISOString(),
      });
      signal.throwIfAborted();
      this.status(
        id,
        "running",
        plan.mode === "rehearsal" ? "开始流程演练，不操作游戏" : "开始执行",
      );
      for (const [index, skillId] of plan.skillIds.entries()) {
        signal.throwIfAborted();
        const skill = this.games
          .find((g) => g.id === plan.gameId)!
          .skills.find((s) => s.id === skillId)!;
        currentStep = skill.title;
        currentId = skillId;
        if (this.active?.id === id) this.active.stepId = skillId;
        this.emit({
          runId: id,
          gameId: this.active?.gameId,
          type: "step",
          skillId,
          stepStatus: "running",
          message: `${plan.mode === "rehearsal" ? "演练" : "执行"} · ${skill.title}`,
          at: new Date().toISOString(),
        });
        let result: void | SkillResult = undefined;
        if (plan.mode === "rehearsal") await delay(900, undefined, { signal });
        else {
          if (!this.execute) throw new Error("没有注册游戏执行适配器");
          result = await this.execute(
            skillId,
            signal,
            (message, result) =>
              this.emit({
                runId: id,
                gameId: this.active?.gameId,
                type: "log",
                skillId,
                message,
                ...(result ? { result } : {}),
                at: new Date().toISOString(),
              }),
            plan,
          );
          signal.throwIfAborted();
          if (result)
            this.emit({
              runId: id,
              gameId: plan.gameId,
              type: "log",
              skillId,
              result,
              message: `${skill.title}执行记录已更新`,
              at: new Date().toISOString(),
            });
        }
        signal.throwIfAborted();
        this.emit({
          runId: id,
          gameId: plan.gameId,
          type: "step",
          skillId,
          stepStatus: result?.status ?? "succeeded",
          stepEvidence:
            plan.mode === "rehearsal"
              ? "rehearsal"
              : result?.status
                ? "adapter-result"
                : "adapter-return",
          message:
            plan.mode === "rehearsal"
              ? "演练完成，未操作游戏"
              : (result?.summary ?? "执行器已完成此步骤"),
          at: new Date().toISOString(),
        });
        currentId = "";
        signal.throwIfAborted();
        const active = this.active;
        if (active?.id === id && active.pause) {
          active.pause.status = "applied";
          active.phase = "terminal";
          active.stepId = undefined;
          this.status(
            id,
            "cancelled",
            "已在步骤边界暂停；当前步骤结果保留，剩余步骤未执行",
            active.pause,
          );
          return;
        }
        if (active?.id === id) active.stepId = undefined;
      }
      if (this.active?.id === id) this.active.phase = "terminal";
      this.status(
        id,
        "succeeded",
        plan.mode === "rehearsal"
          ? "流程演练完成，未执行任何游戏操作"
          : "执行流程已结束，请查看各步骤结果",
      );
    } catch (error) {
      if (this.active?.id === id) this.active.phase = "settling";
      const cancelledAtFailure = signal.aborted;
      let fault: FailureEvidence | undefined;
      if (!cancelledAtFailure && plan.mode === "live") {
        fault = {
          version: 1,
          source: "runner",
          runId: id,
          skillId: currentId || undefined,
          code:
            error instanceof TaskFaultError
              ? error.faultCode
              : "skill-exception",
          observedAt: new Date().toISOString(),
          capture: { status: "not-attempted" },
        };
        if (this.captureFailure) {
          const budget = new AbortController();
          const cancel = () => budget.abort();
          signal.addEventListener("abort", cancel, { once: true });
          const timer = setTimeout(cancel, 5000);
          const expired = new Promise<FailureCapture>((resolve) =>
            budget.signal.addEventListener(
              "abort",
              () => resolve({ status: "unavailable" }),
              { once: true },
            ),
          );
          try {
            fault.capture = await Promise.race([
              this.captureFailure(budget.signal),
              expired,
            ]);
          } catch {
            fault.capture = { status: "unavailable" };
          } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
          }
        }
      }
      if (currentId)
        this.emit({
          runId: id,
          gameId: plan.gameId,
          type: "step",
          skillId: currentId,
          stepStatus: cancelledAtFailure ? "cancelled" : "failed",
          fault,
          message: cancelledAtFailure
            ? "已停止，现场结果需核对"
            : error instanceof Error
              ? error.message
              : String(error),
          at: new Date().toISOString(),
        });
      if (this.active?.id === id) this.active.phase = "terminal";
      this.status(
        id,
        cancelledAtFailure ? "cancelled" : "failed",
        cancelledAtFailure
          ? "任务已停止，后续步骤未执行"
          : `${currentStep ? `${currentStep}失败：` : ""}${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  async stop(): Promise<void> {
    const active = this.active;
    if (!active) return;
    if (active.phase === "terminal") {
      await active.finished;
      return;
    }
    if (!active.abort.signal.aborted) {
      this.status(active.id, "stopping", "正在停止，等待执行器确认");
      active.abort.abort();
    }
    await active.finished;
  }
}
