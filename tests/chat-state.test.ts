import { describe, expect, it } from "vitest";
import {
  chatExecutionTarget,
  chatTurnLabel,
  chatCommand,
} from "../apps/desktop/renderer/chat-state";
import type { PlannerViewState } from "../packages/protocol/agent-planner";

const completed = {
  revision: 3,
  status: "completed",
  requestId: "request-a",
  source: "recorded",
  result: { status: "draft", draft: { planHash: "hash-a" } },
} as PlannerViewState;
describe("chat execution binding", () => {
  it("only offers confirmation for the exact live checked draft", () => {
    expect(chatExecutionTarget(completed, completed)).toEqual({
      requestId: "request-a",
      planHash: "hash-a",
    });
    expect(
      chatExecutionTarget(completed, { ...completed, requestId: "request-b" }),
    ).toBeUndefined();
    expect(
      chatExecutionTarget(completed, { revision: 0, status: "idle" }),
    ).toBeUndefined();
    expect(
      chatExecutionTarget(completed, { ...completed, status: "failed" }),
    ).toBeUndefined();
  });
  it("cannot execute rehearsal, non-draft, or changed hashes", () => {
    expect(
      chatExecutionTarget({ ...completed, source: "fixture" }, completed),
    ).toBeUndefined();
    expect(
      chatExecutionTarget(completed, {
        ...completed,
        result: { ...completed.result!, status: "answer" },
      }),
    ).toBeUndefined();
    expect(
      chatExecutionTarget(completed, {
        ...completed,
        result: {
          ...completed.result!,
          draft: { ...completed.result!.draft!, planHash: "hash-b" },
        },
      }),
    ).toBeUndefined();
  });
  it("describes planning completion without asserting game completion", () => {
    expect(chatTurnLabel(completed)).toBe("计划已生成");
    expect(chatTurnLabel({ ...completed, status: "failed" })).toBe(
      "请求未完成",
    );
    expect(chatTurnLabel({ ...completed, status: "cancelled" })).toBe(
      "已取消规划",
    );
    expect(
      chatTurnLabel({
        ...completed,
        result: { ...completed.result!, status: "question" },
      }),
    ).toBe("需要补充信息");
  });
  it.each([
    "没有可核对的授权续跑，或本次恢复额度已耗尽。",
    "原目标授权已过期，未提交新的执行请求。",
    "停止请求已发出，等待执行器确认。",
  ])(
    "labels a referenced old goal without asserting a new admission: %s",
    (modelText) => {
      const turn = {
        ...completed,
        result: {
          ...completed.result!,
          status: "answer" as const,
          execution: "managed-by-goal" as const,
          goalIds: ["goal-existing"],
          modelText,
          draft: undefined,
        },
      };
      expect(chatTurnLabel(turn)).toBe("目标已关联");
      expect(chatExecutionTarget(turn, turn)).toBeUndefined();
    },
  );
});
describe("saved daily intents in the chat workspace", () => {
  it("only checks the latest real turn matching the current live planner", async () => {
    const { chatIntentTarget } =
      await import("../apps/desktop/renderer/chat-state");
    const turn = {
      id: "turn-a",
      source: "recorded",
      planner: {
        ...completed,
        result: { ...completed.result, status: "saved-both-games" },
      },
    } as any;
    expect(chatIntentTarget(turn, turn, turn.planner)).toEqual({
      turnId: "turn-a",
      requestId: "request-a",
    });
    expect(
      chatIntentTarget(turn, { ...turn, id: "later-turn" }, turn.planner),
    ).toBeUndefined();
    expect(
      chatIntentTarget(turn, turn, { ...turn.planner, requestId: "other" }),
    ).toBeUndefined();
    expect(
      chatIntentTarget({ ...turn, source: "fixture" }, turn, turn.planner),
    ).toBeUndefined();
    expect(
      chatIntentTarget(turn, turn, { ...turn.planner, status: "running" }),
    ).toBeUndefined();
    expect(
      chatIntentTarget(turn, turn, { ...turn.planner, source: "fixture" }),
    ).toBeUndefined();
    expect(
      chatIntentTarget(turn, turn, {
        ...turn.planner,
        result: { status: "answer" },
      }),
    ).toBeUndefined();
    expect(
      chatIntentTarget(turn, turn, {
        ...turn.planner,
        result: { ...turn.planner.result, source: "fixture" },
      }),
    ).toBeUndefined();
  });
  it("describes a saved intent as awaiting a host check, without claiming execution", () => {
    expect(
      chatTurnLabel({
        ...completed,
        result: { ...completed.result!, status: "saved-daily" },
      } as any),
    ).toBe("等待日常检查");
    expect(
      chatTurnLabel({
        ...completed,
        result: { ...completed.result!, status: "saved-both-games" },
      } as any),
    ).toBe("等待双游戏检查");
  });
});
describe("explicit local chat commands", () => {
  it("routes exact controls without passing cancellation to a model", () => {
    expect(chatCommand("停止全部任务")).toBe("stop");
    expect(chatCommand(" /stop ")).toBe("stop");
    expect(chatCommand("/daily")).toBe("daily");
    expect(chatCommand("我想知道停止全部任务是否会影响进度")).toBeUndefined();
    expect(chatCommand("停止账号二")).toBeUndefined();
  });
  it("routes only explicit saved daily, continuation and pause phrases to host review", () => {
    expect(chatCommand("运行保存的日常")).toBe("saved-daily");
    expect(chatCommand("运行每日任务")).toBe("saved-daily");
    expect(chatCommand("/run-daily")).toBe("saved-daily");
    expect(chatCommand("继续原失败")).toBe("continue");
    expect(chatCommand("当前步骤结束后暂停")).toBe("pause");
    expect(chatCommand("能不能运行每日任务，但不要收邮件")).toBeUndefined();
    expect(chatCommand("失败后该怎么继续")).toBeUndefined();
  });
});
