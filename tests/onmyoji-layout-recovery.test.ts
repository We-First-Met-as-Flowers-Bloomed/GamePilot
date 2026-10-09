import { describe, expect, it, vi } from "vitest";
import { OnmyojiDaily } from "../games/onmyoji/daily";
import type { Frame, GameDevice } from "../packages/runtime/device";
import choreRewardOverSign from "./fixtures/onmyoji/chore-reward-over-sign-20261007.json";
import giftHouseShiftedTabs from "./fixtures/onmyoji/gift-house-shifted-tabs-20261007.json";
import {
  choreClaimClosePoint,
  dailyGiftTabPoint,
  dailySignClosePoint,
  isGiftHouse,
} from "../games/onmyoji/policy";

const frame = (
  ...texts: [string, number, number, number?, number?][]
): Frame => ({
  width: 1920,
  height: 1080,
  texts: texts.map(([text, x, y, w = 100, h = 40]) => ({
    text,
    box: [x, y, w, h],
    score: 0.99,
  })),
});
const courtyard = frame(["加成", 546, 49], ["探", 840, 208]);
const tasks = frame(
  ["庭院事务", 400, 61],
  ["每日一签", 590, 428],
  ["一键", 1690, 875],
  ["完成", 1676, 950],
);
const completed = frame(
  ...tasks.texts.map(
    (h) => [h.text, ...h.box] as [string, number, number, number, number],
  ),
  ["已完成", 1478, 406],
);

function device(
  initial: Frame,
  input: (x: number, y: number, current: Frame) => Frame,
) {
  let current = initial;
  const d: GameDevice = {
    observe: vi.fn(async () => current),
    click: vi.fn(async (x, y) => {
      current = input(x, y, current);
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
    adapter: new OnmyojiDaily(
      d,
      () => {},
      async () => {},
    ),
    current: () => current,
  };
}

describe("observed 2026-10-07 Onmyoji layout recovery", () => {
  // Filtered real OCR from the failed 12:23:53.609 observation. Provenance,
  // source log SHA and omitted-hit counts are recorded in the sources fixture.
  const rewardOverSign = choreRewardOverSign as Frame;

  it("dismisses the foreground reward list outside its panel instead of the sign behind it", async () => {
    const { d, adapter, current } = device(courtyard, (x, y, page) => {
      if (page === courtyard && x === 1250 && y === 540) return tasks;
      if (page === tasks && x === 1740 && y === 940) return rewardOverSign;
      // The panel extends through x=1760 and y=1015. Its items and the sign
      // under it do not dismiss the foreground list.
      if (
        page === rewardOverSign &&
        x > 1770 &&
        x < 1910 &&
        y > 120 &&
        y < 1000
      )
        return completed;
      return page;
    });
    const result = await adapter.checkIn(new AbortController().signal);
    expect(result).toMatchObject({ status: "succeeded", goalSatisfied: true });
    expect(current()).toBe(completed);
    expect(d.click).not.toHaveBeenCalledWith(1310, 160, expect.anything());
    expect(d.click).toHaveBeenCalledTimes(3);
  });

  it("executes remaining enabled one-key chores even when daily sign was already complete", async () => {
    const { d, adapter } = device(courtyard, (x, y, page) => {
      if (page === courtyard && x === 1250 && y === 540) return completed;
      if (page === completed && x === 1740 && y === 940) return rewardOverSign;
      if (
        page === rewardOverSign &&
        x > 1770 &&
        x < 1910 &&
        y > 120 &&
        y < 1000
      )
        return completed;
      return page;
    });
    expect(await adapter.checkIn(new AbortController().signal)).toMatchObject({
      status: "succeeded",
      goalSatisfied: true,
    });
    expect(d.click).toHaveBeenCalledTimes(3);
    expect(d.click).toHaveBeenCalledWith(1740, 940, expect.anything());
  });

  it("bounds foreground-list dismissal without replaying claimed one-key chores", async () => {
    const { d, adapter } = device(courtyard, (x, y, page) => {
      if (page === courtyard && x === 1250 && y === 540) return tasks;
      if (page === tasks && x === 1740 && y === 940) return rewardOverSign;
      return page;
    });
    await expect(adapter.checkIn(new AbortController().signal)).rejects.toThrow(
      "未能关闭签到奖励画面",
    );
    const inputs = vi.mocked(d.click).mock.calls;
    expect(inputs.filter(([x, y]) => x === 1740 && y === 940)).toHaveLength(1);
    expect(inputs.filter(([x, y]) => x > 1770 && y < 1000)).toHaveLength(4);
    expect(d.click).not.toHaveBeenCalledWith(1310, 160, expect.anything());
  });

  it("gives foreground reward proof priority over the background sign anchors", () => {
    expect(choreClaimClosePoint(rewardOverSign)).toEqual([1860, 900]);
    expect(dailySignClosePoint(rewardOverSign)).toBeNull();
  });

  it.each([
    "title",
    "hint",
    "low-confidence",
    "different-size",
    "confirmation",
  ])(
    "does not derive an outside-panel input from incomplete reward evidence (%s)",
    (invalid) => {
      const f = structuredClone(rewardOverSign);
      if (invalid === "title")
        f.texts = f.texts.filter((h) => h.text !== "领取成功");
      if (invalid === "hint")
        f.texts = f.texts.filter((h) => h.text !== "点击空白处关闭");
      if (invalid === "low-confidence")
        f.texts.find((h) => h.text === "点击空白处关闭")!.score = 0.8;
      if (invalid === "different-size") f.width = 1280;
      if (invalid === "confirmation")
        f.texts.push(...frame(["取消", 750, 610], ["确认", 1080, 610]).texts);
      expect(choreClaimClosePoint(f)).toBeNull();
    },
  );

  // Filtered real OCR from the failed 12:24:17.435 observation. 热卖 pushes
  // 日常 and 特权 up; never infer a daily tab from the old y=595 coordinate.
  const newHouse = giftHouseShiftedTabs as Frame;
  const shop = frame(["热门推荐", 234, 27], ["礼包屋", 1699, 1026, 96, 34]);
  const list = frame(
    ["每日礼包", 300, 206],
    ["领取", 326, 448],
    ["推荐", 226, 123],
    ["礼包屋", 1699, 1026, 96, 34],
  );
  const claimedList = frame(
    ["每日礼包", 300, 206],
    ["已领取", 326, 448],
    ["推荐", 226, 123],
    ["礼包屋", 1699, 1026, 96, 34],
  );
  const giftReward = frame(["每日礼包", 378, 168], ["获得奖励", 716, 279]);

  it("opens the shifted daily tab and claims only its free first card", async () => {
    const { d, adapter, current } = device(courtyard, (x, y, page) => {
      if (page === courtyard && x === 1025 && y === 955) return shop;
      // The text at y=1043 was a no-op in the real failure. Only its icon
      // directly above it is the observed navigation target.
      if (page === shop && x === 1747 && y === 983) return newHouse;
      if (page === newHouse && x === 1813 && y === 476) return list;
      if (page === list && x === 376 && y === 468) return giftReward;
      if (page === giftReward && x === 1700 && y === 900) return claimedList;
      if (page === claimedList && x === 75 && y === 60) return courtyard;
      return page;
    });
    expect(await adapter.dailyGift(new AbortController().signal)).toMatchObject(
      { status: "succeeded", goalSatisfied: true },
    );
    expect(current()).toBe(courtyard);
    expect(d.click).toHaveBeenCalledWith(1813, 476, expect.anything());
    expect(d.click).not.toHaveBeenCalledWith(1810, 595, expect.anything());
    expect(d.click).not.toHaveBeenCalledWith(1747, 1043, expect.anything());
    expect(d.click).toHaveBeenCalledTimes(6);
  });

  it.each(["日", "印"])(
    "locates the old two-character vertical daily tab (%s)",
    (top) => {
      const oldHouse: Frame = {
        width: 1920,
        height: 1080,
        texts: [
          { text: "礼包屋", box: [1698, 1026, 96, 36], score: 0.999382 },
          { text: "限时", box: [1780, 136, 64, 112], score: 0.99264 },
          { text: "特权", box: [1788, 696, 52, 108], score: 0.978247 },
          { text: top, box: [1798, 555, 30, 46], score: 0.791086 },
          { text: "常", box: [1790, 591, 48, 62], score: 0.999803 },
        ],
      };
      expect(isGiftHouse(oldHouse)).toBe(true);
      expect(dailyGiftTabPoint(oldHouse)).toEqual([1814, 604]);
    },
  );

  it("does not treat shared bottom navigation and two surrounding labels as a confirmed gift page", () => {
    const shared = frame(
      ["魂玉屋", 1490, 1024],
      ["礼包屋", 1698, 1026],
      ["限时", 1784, 140],
      ["特权", 1788, 696],
    );
    expect(isGiftHouse(shared)).toBe(false);
    expect(dailyGiftTabPoint(shared)).toBeNull();
  });

  it.each(["missing", "low-confidence", "below-privilege", "confirmation"])(
    "does not guess a daily navigation input when its current tab is not verified (%s)",
    (invalid) => {
      const f = structuredClone(newHouse);
      if (invalid === "missing")
        f.texts = f.texts.filter((h) => h.text !== "日常");
      if (invalid === "low-confidence")
        f.texts.find((h) => h.text === "日常")!.score = 0.75;
      if (invalid === "below-privilege")
        f.texts.find((h) => h.text === "日常")!.box[1] = 650;
      if (invalid === "confirmation")
        f.texts.push(...frame(["取消", 750, 610], ["确认", 1080, 610]).texts);
      expect(dailyGiftTabPoint(f)).toBeNull();
    },
  );

  it("never reaches a paid-card input when the opened shop cannot prove the free daily list", async () => {
    const { d, adapter } = device(courtyard, (x, y, page) => {
      if (page === courtyard && x === 1025 && y === 955) return shop;
      if (page === shop && x === 1747 && y === 983) return newHouse;
      // A wrong district or unchanged tab never produces the first 每日礼包.
      return page;
    });
    await expect(
      adapter.dailyGift(new AbortController().signal),
    ).rejects.toThrow("画面未进入预期状态");
    expect(vi.mocked(d.click).mock.calls.map(([x, y]) => [x, y])).toEqual([
      [1025, 955],
      [1747, 983],
      [1813, 476],
    ]);
  });
});
