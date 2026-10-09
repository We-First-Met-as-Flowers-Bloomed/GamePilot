import { describe, expect, it, vi } from "vitest";
import type { Frame, GameDevice } from "../packages/runtime/device";
import type { SkillResult } from "../packages/protocol";
import { OnmyojiDaily } from "../games/onmyoji/daily";
import { classifyOnmyojiFrame } from "../games/onmyoji/inspection";
import { decideOnmyojiNavigation } from "../games/onmyoji/navigation-recovery";
import {
  choreClaimClosePoint,
  dailySignClosePoint,
} from "../games/onmyoji/policy";
import laneA from "./fixtures/onmyoji/daily-sign-foreground-lane-a-20261008.json";
import laneB from "./fixtures/onmyoji/daily-sign-foreground-lane-b-20261008.json";

const frame = (...texts: [string, number, number][]): Frame => ({
  width: 1920,
  height: 1080,
  texts: texts.map(([text, x, y]) => ({
    text,
    box: [x, y, 100, 40],
    score: 0.99,
  })),
});
const courtyard = frame(["加成", 546, 49], ["探", 840, 208]);
const tasks = frame(
  ["庭院事务", 400, 61],
  ["一键", 1690, 875],
  ["完成", 1676, 950],
);
const claim = frame(
  ["领取成功", 456, 45],
  ["完成啦！", 106, 538],
  ["点击空白处关闭", 866, 1024],
);
const completed = frame(
  ["庭院事务", 400, 61],
  ["每日一签", 590, 428],
  ["已完成", 1478, 406],
);

function harness(overlay: Frame, afterClose = true) {
  let current = courtyard;
  const results: SkillResult[] = [];
  const d: GameDevice = {
    observe: vi.fn(async () => current),
    click: vi.fn(async (x, y) => {
      if (current === courtyard && x === 1250 && y === 540) current = tasks;
      else if (current === tasks && x === 1740 && y === 940) current = overlay;
      else if (current === overlay && x === 1310 && y === 160 && afterClose)
        current = claim;
      else if (current === claim && x === 1860 && y === 900)
        current = completed;
    }),
    swipe: vi.fn(async () => {}),
    longPress: vi.fn(async () => {}),
    colorSlots: vi.fn(async () => []),
    startApp: vi.fn(async () => {}),
    packages: vi.fn(async () => ["com.netease.onmyoji.test"]),
    isAppRunning: vi.fn(async () => true),
    matchTemplate: vi.fn(async (name) =>
      name === "courtyard-tasks.png"
        ? {
            box: [1200, 500, 100, 80] as [number, number, number, number],
            score: 0.99,
          }
        : null,
    ),
  };
  return {
    d,
    results,
    adapter: new OnmyojiDaily(
      d,
      (_message, result) => {
        if (result) results.push(result);
      },
      async () => {},
    ),
  };
}

describe("2026-10-08 foreground daily sign over one-key reward", () => {
  it("does not spend the claim-close budget on delayed sign animation", async () => {
    const { adapter, d } = harness(laneB as Frame);
    const original = vi.mocked(d.observe).getMockImplementation()!;
    const observations = [laneB, laneB, laneB, laneB, claim, completed];
    vi.mocked(d.observe).mockImplementation(async (signal) =>
      vi.mocked(d.click).mock.calls.length < 2
        ? original(signal)
        : ((observations.shift() ?? completed) as Frame),
    );
    await expect(
      adapter.checkIn(new AbortController().signal),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(vi.mocked(d.click).mock.calls.map(([x, y]) => [x, y])).toEqual([
      [1250, 540],
      [1740, 940],
      [1310, 160],
      [1860, 900],
    ]);
  });
  it("waits for a delayed foreground transition before closing the next reward layer", async () => {
    const { adapter, d } = harness(laneB as Frame);
    const observations = [laneB, laneB, laneB, laneB, claim, tasks, tasks];
    vi.mocked(d.observe).mockImplementation(
      async () => (observations.shift() ?? tasks) as Frame,
    );
    await expect(
      adapter.login(new AbortController().signal),
    ).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(vi.mocked(d.click).mock.calls.map(([x, y]) => [x, y])).toEqual([
      [1310, 160],
      [1860, 900],
    ]);
  });

  it("stops a stuck login overlay after bounded navigation without claiming it closed", async () => {
    const { adapter, d } = harness(laneB as Frame, false);
    vi.mocked(d.observe).mockResolvedValue(laneB as Frame);
    await expect(adapter.login(new AbortController().signal)).rejects.toThrow(
      "登录弹层未能关闭",
    );
    expect(d.click).toHaveBeenCalledTimes(3);
    expect(d.startApp).not.toHaveBeenCalled();
  });
  it.each([
    ["lane-a corrupt background title", laneA],
    ["lane-b readable background title", laneB],
  ])(
    "recognizes the foreground sign using its full visible layout: %s",
    (_name, value) => {
      const observation = value as Frame;
      expect(dailySignClosePoint(observation)).toEqual([1310, 160]);
      expect(choreClaimClosePoint(observation)).toBeNull();
      expect(classifyOnmyojiFrame(observation)).toBe("onmyoji-sign-reward");
    },
  );

  it.each([
    ["lane-a", laneA],
    ["lane-b", laneB],
  ])(
    "closes sign, then background reward, then verifies the completed row: %s",
    async (_name, value) => {
      const { adapter, d } = harness(value as Frame);
      const result = await adapter.checkIn(new AbortController().signal);
      expect(result).toMatchObject({
        status: "succeeded",
        goalSatisfied: true,
        onmyoji: { phase: "confirmed" },
      });
      expect(vi.mocked(d.click).mock.calls.map(([x, y]) => [x, y])).toEqual([
        [1250, 540],
        [1740, 940],
        [1310, 160],
        [1860, 900],
      ]);
    },
  );

  it("retains submitted-unknown evidence and never reclaims if the known close does not work", async () => {
    const { adapter, d, results } = harness(laneB as Frame, false);
    await expect(adapter.checkIn(new AbortController().signal)).rejects.toThrow(
      "未能关闭签到奖励",
    );
    expect(
      vi.mocked(d.click).mock.calls.filter(([x, y]) => x === 1740 && y === 940),
    ).toHaveLength(1);
    expect(
      vi.mocked(d.click).mock.calls.filter(([x, y]) => x === 1310 && y === 160),
    ).toHaveLength(4);
    expect(results.at(-1)?.onmyoji).toMatchObject({
      phase: "submitted",
      effects: [],
    });
  });

  it("cannot use the visible sign to dismiss an unknown central confirmation", async () => {
    const overlay = structuredClone(laneB) as Frame;
    overlay.texts.push(...frame(["取消", 750, 610], ["确认", 1080, 610]).texts);
    expect(dailySignClosePoint(overlay)).toBeNull();
    expect(choreClaimClosePoint(overlay)).toBeNull();
    expect(classifyOnmyojiFrame(overlay)).toBe("unknown-confirmation");
    const { adapter, d, results } = harness(overlay);
    await expect(adapter.checkIn(new AbortController().signal)).rejects.toThrow(
      "未识别的确认",
    );
    expect(d.click).toHaveBeenCalledTimes(2);
    expect(results.at(-1)?.onmyoji).toMatchObject({
      phase: "submitted",
      effects: [],
    });
  });

  it.each(["第389签", "奖励", "累计奖励", "解签"])(
    "does not promote an incomplete scroll in front of the reward list when %s is missing",
    (missing) => {
      const partial = structuredClone(laneB) as Frame;
      partial.texts = partial.texts.filter((hit) => hit.text !== missing);
      expect(dailySignClosePoint(partial)).toBeNull();
      expect(choreClaimClosePoint(partial)).toEqual([1860, 900]);
    },
  );

  it("exposes the recorded sign close to bounded navigation without claiming account identity or daily completion", () => {
    const address = "127.0.0.1:16416";
    const packageName = "com.netease.onmyoji.test";
    const frames = ["2026-10-08T00:25:18.000Z", "2026-10-08T00:25:19.000Z"].map(
      (observedAt) => ({
        address,
        foregroundPackage: packageName,
        observedAt,
        frame: structuredClone(laneB) as Frame,
      }),
    );
    expect(
      decideOnmyojiNavigation({
        address,
        packageName,
        startedAt: "2026-10-08T00:25:17.000Z",
        now: "2026-10-08T00:25:20.000Z",
        frames: [frames[0], frames[1]],
      }),
    ).toMatchObject({
      ok: true,
      page: "onmyoji-sign-reward",
      pageVerified: true,
      accountVerified: false,
      action: { kind: "tap", purpose: "close-sign", point: [1310, 160] },
    });
  });
});
