import { describe, expect, it } from "vitest";
import {
  decideOnmyojiNavigation,
  onmyojiNavigationRetryEvidence,
  type OnmyojiNavigationInput,
  type OnmyojiNavigationObservation,
} from "../games/onmyoji/navigation-recovery";
import type { Frame } from "../packages/runtime/device";
import type { TaskRecord } from "../packages/protocol/task-record";
import reward from "./fixtures/onmyoji/chore-reward-over-sign-20261007.json";
import shop from "./fixtures/onmyoji/gift-house-shifted-tabs-20261007.json";
import promotion from "./fixtures/onmyoji/hana-promotion.json";
import illustration from "./fixtures/onmyoji/mail-illustration-first.json";

const baseTime = Date.parse("2026-10-07T04:00:00.000Z");
const at = (seconds: number) =>
  new Date(baseTime + seconds * 1000).toISOString();
const frame = (...rows: [string, number, number][]): Frame => ({
  width: 1920,
  height: 1080,
  texts: rows.map(([text, x, y]) => ({
    text,
    score: 0.99,
    box: [x, y, 100, 40],
  })),
});
const courtyard = frame(["加成", 546, 49], ["探索", 1800, 180]);
const signLeft = frame(["第830签", 706, 168], ["解签", 1300, 671]);
const signRight = frame(["第830签", 1000, 100], ["解签", 1500, 300]);
const mailbox = frame(["邮箱", 850, 50], ["删除已读", 300, 900]);
const mailReward = frame(["邮箱", 850, 50], ["获得奖励", 700, 250]);
const giftList = frame(
  ["每日礼包", 300, 200],
  ["礼包屋", 1690, 1000],
  ["推荐", 200, 100],
  ["领取", 320, 450],
);
const giftReward = frame(["每日礼包", 350, 150], ["获得奖励", 700, 250]);
const courtyardReward = frame(
  ["加成", 546, 49],
  ["探索", 1800, 180],
  ["获得奖励", 700, 250],
);

function observation(
  value: Frame,
  seconds: number,
): OnmyojiNavigationObservation {
  return {
    address: "127.0.0.1:16384",
    foregroundPackage: "com.netease.onmyoji.bili",
    observedAt: at(seconds),
    frame: structuredClone(value),
  };
}

function input(first: Frame = reward as Frame, second: Frame = first) {
  return {
    address: "127.0.0.1:16384",
    packageName: "com.netease.onmyoji.bili",
    startedAt: at(0),
    now: at(10),
    frames: [observation(first, 8), observation(second, 9)],
    attempts: 0,
  } satisfies OnmyojiNavigationInput;
}

function blocked(value: OnmyojiNavigationInput) {
  expect(decideOnmyojiNavigation(value)).toMatchObject({
    ok: false,
    pageVerified: false,
    accountVerified: false,
  });
  expect(decideOnmyojiNavigation(value)).not.toHaveProperty("action");
}

describe("bounded Onmyoji navigation facts", () => {
  it.each([
    [reward, "onmyoji-chore-reward", [1860, 900], "dismiss-reward"],
    [promotion, "onmyoji-hana-promotion", [1700, 900], "dismiss-promotion"],
    [
      illustration,
      "onmyoji-illustration-reward",
      [960, 1050],
      "dismiss-reward",
    ],
    [signLeft, "onmyoji-sign-reward", [1310, 160], "close-sign"],
    [signRight, "onmyoji-sign-reward", [1605, 105], "close-sign"],
    [mailbox, "onmyoji-mailbox", [1765, 185], "close-mailbox"],
    [mailReward, "onmyoji-mail-reward", [960, 1020], "dismiss-reward"],
    [giftList, "onmyoji-daily-gift-list", [75, 60], "return-from-shop"],
    [giftReward, "onmyoji-gift-reward", [1700, 900], "dismiss-reward"],
    [
      courtyardReward,
      "onmyoji-courtyard-reward",
      [960, 1030],
      "dismiss-reward",
    ],
  ])(
    "derives the known %s exit, without account or effect claims",
    (value, page, point, purpose) => {
      expect(decideOnmyojiNavigation(input(value as Frame))).toEqual({
        ok: true,
        page,
        observedAt: at(9),
        pageVerified: true,
        accountVerified: false,
        action: { kind: "tap", purpose, point },
      });
    },
  );

  it("uses the recorded shifted shop only as a navigation scene; never taps daily or claim", () => {
    expect(decideOnmyojiNavigation(input(shop as Frame))).toMatchObject({
      ok: true,
      page: "onmyoji-gift-house",
      action: { kind: "tap", purpose: "return-from-shop", point: [75, 60] },
      accountVerified: false,
    });
  });

  it("accepts an observed courtyard without input, even after the return budget", () => {
    expect(
      decideOnmyojiNavigation({ ...input(courtyard), attempts: 3 }),
    ).toMatchObject({
      ok: true,
      page: "onmyoji-courtyard",
      accountVerified: false,
      action: { kind: "at-courtyard" },
    });
  });

  it("applies exits to the actual overlay state and freshly verifies each changed layer", () => {
    let current = reward as Frame;
    const clicks: [number, number][] = [];
    for (let attempts = 0; attempts < 3; attempts++) {
      const decision = decideOnmyojiNavigation({ ...input(current), attempts });
      expect(decision.ok).toBe(true);
      if (!decision.ok || decision.action.kind === "at-courtyard") break;
      const point = decision.action.point;
      clicks.push(point);
      // Actual recorded foreground overlay and the underlying sign have different exits.
      if (current === reward && point[0] === 1860 && point[1] === 900)
        current = signLeft;
      else if (current === signLeft && point[0] === 1310 && point[1] === 160)
        current = courtyard;
    }
    expect(clicks).toEqual([
      [1860, 900],
      [1310, 160],
    ]);
    expect(current).toBe(courtyard);
  });

  it("cannot spend a fourth input when an observed blank click did not close the layer", () => {
    const clicks: [number, number][] = [];
    for (let attempts = 0; attempts <= 3; attempts++) {
      const decision = decideOnmyojiNavigation({
        ...input(reward as Frame),
        attempts,
      });
      if (decision.ok && decision.action.kind === "tap")
        clicks.push(decision.action.point);
      else
        expect(decision).toMatchObject({
          ok: false,
          reason: "navigation-limit",
        });
    }
    expect(clicks).toHaveLength(3);
  });

  it.each([
    [reward as Frame, courtyard],
    [signLeft, signRight],
    [shop as Frame, giftList],
  ])(
    "requires the same foreground page and exit layout in both captures",
    (first, second) => {
      expect(decideOnmyojiNavigation(input(first, second))).toMatchObject({
        ok: false,
        reason: "unstable-page",
      });
    },
  );

  it.each([
    "请输入密码",
    "手机验证码",
    "安全验证",
    "支付确认",
    "是否消耗魂玉",
    "确定",
    "取消",
    "是否继续刚才的战斗",
    "退出战斗",
    "网络连接失败",
    "连接服务器超时",
    "重新连接",
    "切换账号",
    "退出登录",
    "人脸识别",
    "重试",
  ])(
    "refuses a foreground %s over otherwise familiar reward anchors",
    (text) => {
      const dangerous = structuredClone(reward) as Frame;
      dangerous.texts.push({ text, score: 0.95, box: [850, 500, 200, 50] });
      expect(decideOnmyojiNavigation(input(dangerous))).toMatchObject({
        ok: false,
        reason: "unsafe-page",
      });
    },
  );

  it("refuses even when only the earlier capture had a dangerous overlay", () => {
    const dangerous = structuredClone(promotion) as Frame;
    dangerous.texts.push({
      text: "确认购买",
      score: 0.95,
      box: [850, 500, 200, 50],
    });
    blocked(input(dangerous, promotion as Frame));
  });

  it.each([
    "unknown",
    "low-confidence",
    "malformed-box",
    "bad-score",
    "wrong-resolution",
    "missing-texts",
  ])("does not navigate an incomplete observation (%s)", (variant) => {
    const value = input();
    const first = value.frames[0].frame;
    if (variant === "unknown") first.texts = [];
    if (variant === "low-confidence")
      first.texts.forEach((hit) => {
        hit.score = 0.65;
      });
    if (variant === "malformed-box") first.texts[0].box = undefined as never;
    if (variant === "bad-score") first.texts[0].score = 2;
    if (variant === "wrong-resolution") first.width = 1280;
    if (variant === "missing-texts") first.texts = undefined as never;
    blocked(value);
  });

  it.each([
    "other-device",
    "other-original-package",
    "other-foreground-package",
    "background-running-only",
    "old-first",
    "before-inspection",
    "future-second",
    "same-capture-time",
    "reversed-capture-time",
    "missing-capture",
    "invalid-time",
    "over-budget",
    "negative-budget",
    "fractional-budget",
    "expired-navigation-window",
    "missing-frame",
    "empty-original-address",
  ])(
    "rejects invalid original-device/freshness/budget facts (%s)",
    (variant) => {
      const value = input();
      if (variant === "other-device")
        value.frames[1].address = "127.0.0.1:16416";
      if (variant === "other-original-package")
        value.packageName = "com.hypergryph.arknights";
      if (variant === "other-foreground-package")
        value.frames[1].foregroundPackage = "com.netease.onmyoji";
      if (variant === "background-running-only")
        value.frames[1].foregroundPackage = undefined;
      if (variant === "old-first") {
        value.startedAt = at(-30);
        value.frames[0].observedAt = at(-10);
      }
      if (variant === "before-inspection") value.frames[0].observedAt = at(-1);
      if (variant === "future-second") value.frames[1].observedAt = at(11);
      if (variant === "same-capture-time") value.frames[1].observedAt = at(8);
      if (variant === "reversed-capture-time")
        value.frames[1].observedAt = at(7);
      if (variant === "missing-capture") value.frames.pop();
      if (variant === "invalid-time") value.now = "now";
      if (variant === "over-budget") value.attempts = 4;
      if (variant === "negative-budget") value.attempts = -1;
      if (variant === "fractional-budget") value.attempts = 0.5;
      if (variant === "expired-navigation-window") value.startedAt = at(-60);
      if (variant === "missing-frame")
        value.frames[1].frame = undefined as never;
      if (variant === "empty-original-address") value.address = "";
      blocked(value as OnmyojiNavigationInput);
    },
  );
});

function failedGift(): TaskRecord {
  return {
    version: 1,
    runId: "navigation-fixture-run",
    laneId: "lane-a",
    gameId: "onmyoji",
    plan: {
      gameId: "onmyoji",
      mode: "live",
      skillIds: ["login", "daily-gift", "hana-claim"],
    },
    status: "failed",
    startedAt: at(0),
    updatedAt: at(7),
    finishedAt: at(7),
    message: "礼包入口没有确认",
    fault: {
      version: 1,
      code: "skill-exception",
      source: "runner",
      runId: "navigation-fixture-run",
      skillId: "daily-gift",
      observedAt: at(5),
      capture: { status: "not-attempted" },
    },
    steps: [
      {
        skillId: "login",
        status: "succeeded",
        startedAt: at(0),
        finishedAt: at(2),
        message: "游戏状态已确认，角色身份未核验",
        diagnostics: [],
      },
      {
        skillId: "daily-gift",
        status: "failed",
        startedAt: at(2),
        finishedAt: at(6),
        message: "礼包入口没有确认",
        diagnostics: [],
        result: {
          onmyoji: {
            version: 1,
            skillId: "daily-gift",
            phase: "not-submitted",
            observedAt: at(3),
            effects: [],
          },
        },
      },
      {
        skillId: "hana-claim",
        status: "not-run",
        message: "本轮未执行",
        diagnostics: [],
      },
    ],
  };
}

describe("typed no-submission evidence is a fact, never a replay grant", () => {
  it("returns the exact current typed checkpoint and fault association without account verification", () => {
    const task = failedGift();
    expect(onmyojiNavigationRetryEvidence(task)).toEqual({
      runId: task.runId,
      skillId: "daily-gift",
      phase: "not-submitted",
      observedAt: at(3),
      accountVerified: false,
    });
    expect(onmyojiNavigationRetryEvidence(task)).not.toHaveProperty(
      "authorized",
    );
  });

  it.each([
    "legacy-no-result",
    "submitted",
    "confirmed-return-failure",
    "unknown-task",
    "unknown-step",
    "missing-fault",
    "mismatched-run",
    "mismatched-skill",
    "mismatched-checkpoint",
    "checkpoint-outside-step",
    "checkpoint-after-fault",
    "future-step",
    "earlier-unknown",
    "later-started",
    "later-result",
    "rehearsal",
    "other-game",
    "legacy-summary-claim",
    "earlier-contradictory-checkpoint",
    "later-finished",
    "second-failed-step",
    "no-end-time",
  ])("keeps %s blocked despite a familiar navigation page", (variant) => {
    const task = failedGift();
    const step = task.steps[1];
    if (variant === "legacy-no-result") delete step.result;
    if (variant === "submitted") step.result!.onmyoji!.phase = "submitted";
    if (variant === "confirmed-return-failure") {
      step.result!.onmyoji!.phase = "confirmed";
      step.result!.onmyoji!.effects = [
        {
          kind: "free-daily-gift",
          observedAt: at(3),
          evidenceReference: "onmyoji:daily-gift:effect:1",
          summary: "领取已确认",
        },
      ];
    }
    if (variant === "unknown-task") task.status = "unknown";
    if (variant === "unknown-step") step.status = "unknown";
    if (variant === "missing-fault") delete task.fault;
    if (variant === "mismatched-run") task.fault!.runId = "other-run";
    if (variant === "mismatched-skill") task.fault!.skillId = "hana-claim";
    if (variant === "mismatched-checkpoint")
      step.result!.onmyoji!.skillId = "mail";
    if (variant === "checkpoint-outside-step")
      step.result!.onmyoji!.observedAt = at(1);
    if (variant === "checkpoint-after-fault")
      step.result!.onmyoji!.observedAt = at(6);
    if (variant === "future-step") task.steps[0].finishedAt = at(9);
    if (variant === "earlier-unknown") task.steps[0].status = "unknown";
    if (variant === "later-started") task.steps[2].startedAt = at(6);
    if (variant === "later-result")
      task.steps[2].result = { summary: "已经执行" };
    if (variant === "rehearsal") task.plan.mode = "rehearsal";
    if (variant === "other-game") {
      task.gameId = "arknights";
      task.plan.gameId = "arknights";
    }
    if (variant === "legacy-summary-claim") {
      step.result = {
        summary: "没有点击领取，可以重试",
        outcome: "not-submitted",
      };
      task.message = "not-submitted";
    }
    if (variant === "earlier-contradictory-checkpoint") {
      task.steps[0].result = {
        onmyoji: {
          version: 1,
          skillId: "daily-gift",
          phase: "submitted",
          observedAt: at(1),
          effects: [],
        },
      };
    }
    if (variant === "later-finished") task.steps[2].finishedAt = at(6);
    if (variant === "second-failed-step") task.steps[2].status = "failed";
    if (variant === "no-end-time") delete task.finishedAt;
    expect(onmyojiNavigationRetryEvidence(task)).toBeUndefined();
  });
});
