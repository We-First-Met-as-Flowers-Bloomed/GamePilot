import { describe, expect, it } from "vitest";
import {
  actorIdOf,
  planActors,
  renderActorDecision,
  type ActorInput,
} from "../scripts/actors/runtime";

/**
 * P2：账号级 actor 运行时。一个 actor = 一个（槽位 × 游戏）= 一个账号在一个游戏里的日常。
 * 两台模拟器 × 两个游戏 = 四个 actor；设备是共享资源，由错峰与"一次一个"保证不互相抢。
 */
const actor = (
  lane: string,
  game: "onmyoji" | "arknights",
  state: ActorInput["state"],
  extra: Partial<ActorInput> = {},
): ActorInput => ({
  lane,
  laneName: lane === "lane-a" ? "账号一" : "账号二",
  game,
  state,
  required: true,
  ...extra,
});

describe("account actor runtime", () => {
  it("runs one actor per device at a time and staggers the next one", () => {
    const now = 1_000_000;
    const decision = planActors(
      [
        actor("lane-a", "arknights", "pending"),
        actor("lane-a", "onmyoji", "pending"),
        actor("lane-b", "arknights", "pending"),
      ],
      { now, staggerMs: 60_000 },
    );
    // 两台设备各自第 0 个 actor 立刻可跑；同一设备第 1 个要等一个间隔。
    expect(decision.runnable.map((plan) => plan.actorId).sort()).toEqual([
      "lane-a:arknights",
      "lane-b:arknights",
    ]);
    const staggered = decision.queued.find(
      (plan) => plan.actorId === "lane-a:onmyoji",
    )!;
    expect(staggered.runAt).toBe(now + 60_000);
    expect(decision.queued).toHaveLength(3);
  });

  it("never auto-runs an actor whose required step is unresolved", () => {
    // 结果未确认 = 输入可能已经到达游戏：只能现场核对，绝不自动重跑（与 game:catchup 同规矩）。
    const decision = planActors(
      [actor("lane-a", "onmyoji", "unknown", { detail: "礼包领取未确认" })],
      { now: Date.now() },
    );
    expect(decision.queued).toEqual([]);
    expect(decision.blocked).toHaveLength(1);
    expect(decision.blocked[0]!.actorId).toBe("lane-a:onmyoji");
    expect(decision.blocked[0]!.reason).toContain("不自动重跑");
    expect(decision.blocked[0]!.reason).toContain("礼包领取未确认");
  });

  it("stops an actor that used up its attempts or keeps failing", () => {
    const now = Date.now();
    const used = planActors([actor("lane-a", "onmyoji", "pending")], {
      now,
      attempts: { "lane-a:onmyoji": 2 },
    });
    expect(used.queued).toEqual([]);
    expect(used.blocked[0]!.reason).toContain("达到上限");
    const sick = planActors([actor("lane-b", "arknights", "failed")], {
      now,
      consecutiveFailures: { "lane-b:arknights": 3 },
    });
    expect(sick.queued).toEqual([]);
    expect(sick.blocked[0]!.reason).toContain("不健康");
  });

  it("leaves optional, finished and deliberately skipped work alone", () => {
    const decision = planActors(
      [
        actor("lane-a", "onmyoji", "pending", { required: false }),
        actor("lane-a", "arknights", "succeeded"),
        actor("lane-b", "onmyoji", "skipped"),
      ],
      { now: Date.now() },
    );
    expect(decision.queued).toEqual([]);
    expect(decision.blocked).toEqual([]);
    expect(renderActorDecision(decision)).toBe("四个账号今天都没有待办。");
  });

  it("prefers the earlier retry and explains why each actor is queued", () => {
    const now = Date.now();
    const decision = planActors(
      [
        actor("lane-a", "arknights", "failed", { priority: 1, detail: "MAA StartUp 超时" }),
        actor("lane-a", "onmyoji", "pending", { priority: 5 }),
      ],
      { now, staggerMs: 0 },
    );
    expect(decision.queued.map((plan) => plan.actorId)).toEqual([
      "lane-a:arknights",
      "lane-a:onmyoji",
    ]);
    expect(decision.queued[0]!.reason).toContain("上次失败");
    expect(decision.queued[0]!.reason).toContain("MAA StartUp 超时");
    expect(decision.queued[1]!.reason).toContain("今天还没跑");
    expect(actorIdOf("lane-b", "onmyoji")).toBe("lane-b:onmyoji");
    const text = renderActorDecision(decision);
    expect(text).toContain("lane-a:arknights");
    expect(text).toContain("账号一 · 明日方舟");
  });
});
