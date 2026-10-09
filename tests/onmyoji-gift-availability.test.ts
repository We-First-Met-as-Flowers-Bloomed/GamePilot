import { expect, it, vi } from "vitest";
import { OnmyojiDaily } from "../games/onmyoji/daily";
import { dailyGiftAction } from "../games/onmyoji/policy";
import type { Frame, GameDevice } from "../packages/runtime/device";
import priced from "./fixtures/onmyoji/daily-gift-priced-20261009.json";

// Allowlisted UI OCR copied without changing text, boxes or scores from
// artifacts/live-20261009/yys-a-daily-list.png.json. The currency icon becomes
// part of OCR "93"; this evidence must never be reported as a precise price.
const observed = priced as Frame;
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
const shop = frame(["热门推荐", 234, 27], ["礼包屋", 1698, 1024]);
const house = frame(
  ["礼包屋", 1698, 1026],
  ["限时", 1784, 140],
  ["特权", 1788, 696],
  ["日常", 1760, 575],
);
function firstCard(text?: string, score = 0.99): Frame {
  const copy = structuredClone(observed);
  copy.texts = copy.texts.filter((hit) => hit.text !== "93");
  if (text) copy.texts.push({ text, score, box: [328, 446, 72, 46] });
  return copy;
}
async function inspect(first: Frame, second = first) {
  const frames = [courtyard, shop, house, first, second, courtyard];
  let index = 0;
  const device: GameDevice = {
    observe: vi.fn(async () => frames[Math.min(index++, frames.length - 1)]),
    click: vi.fn(async () => {}),
    swipe: vi.fn(async () => {}),
    longPress: vi.fn(async () => {}),
    colorSlots: vi.fn(async () => []),
    startApp: vi.fn(async () => {}),
    isAppRunning: vi.fn(async () => true),
    packages: vi.fn(async () => []),
    matchTemplate: vi.fn(async () => null),
  };
  const result = await new OnmyojiDaily(
    device,
    () => {},
    async () => {},
  ).dailyGift(new AbortController().signal);
  expect(
    vi
      .mocked(device.click)
      .mock.calls.some(
        ([x, y]) => x >= 180 && x <= 1600 && y >= 390 && y <= 900,
      ),
  ).toBe(false);
  return result;
}
it("explains a stable numeric entry without interpreting the OCR price or claiming completion", async () => {
  const result = await inspect(observed);
  expect(result).toMatchObject({
    status: "skipped",
    skipReason: "unavailable",
    goalSatisfied: null,
    onmyoji: { phase: "not-submitted", effects: [] },
  });
  expect(result.summary).toContain("疑似付费入口");
  expect(result.summary).toContain("未显示免费领取");
  expect(result.summary).not.toMatch(/已领取|月卡|过期|93|3魂玉/);
});
it.each(["absent", "weak", "changed", "contradictory"])(
  "keeps %s price evidence uncertain",
  async (kind) => {
    const missing = firstCard();
    const conflict = structuredClone(observed);
    conflict.texts.push({ text: "领取", box: [400, 446, 60, 46], score: 0.99 });
    const first =
      kind === "weak"
        ? firstCard("93", 0.75)
        : kind === "absent"
          ? missing
          : kind === "contradictory"
            ? conflict
            : observed;
    const result = await inspect(first, kind === "changed" ? missing : first);
    expect(result).toMatchObject({
      status: "skipped",
      skipReason: "unavailable",
      goalSatisfied: null,
      onmyoji: { phase: "not-submitted", effects: [] },
    });
    expect(result.summary).not.toContain("疑似付费入口");
  },
);
it("preserves a verified claimed marker independently of prices on adjacent cards", async () => {
  expect(await inspect(firstCard("已领取"))).toMatchObject({
    status: "skipped",
    skipReason: "already-completed",
    goalSatisfied: true,
  });
});
it("keeps the existing free-claim gate and ignores adjacent card prices", () => {
  expect(dailyGiftAction(observed)).toBeUndefined();
  expect(dailyGiftAction(firstCard("领取"))?.text).toBe("领取");
  expect(dailyGiftAction(firstCard())).toBeUndefined();
  expect(dailyGiftAction(firstCard("已领取"))).toBeUndefined();
});
