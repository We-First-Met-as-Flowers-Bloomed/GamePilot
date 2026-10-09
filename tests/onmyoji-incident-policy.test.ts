import { expect, it } from "vitest";
import { gamePlugins } from "../games/registry";
import type { Frame } from "../packages/runtime/device";
import promotion from "./fixtures/onmyoji/hana-promotion.json";
import reward from "./fixtures/onmyoji/chore-reward-over-sign-20261007.json";
import shop from "./fixtures/onmyoji/gift-house-shifted-tabs-20261007.json";

const classify = (frame: Frame) =>
  (gamePlugins.get("onmyoji").recovery as any).classify?.(frame);
const overlay = (text: string) => ({
  text,
  score: 0.99,
  box: [850, 500, 200, 50] as [number, number, number, number],
});

it.each([
  [reward, "onmyoji-chore-reward"],
  [shop, "onmyoji-gift-house"],
  [promotion, "onmyoji-hana-promotion"],
])(
  "classifies recorded Onmyoji UI through its trusted plugin (%s)",
  (frame, expected) => {
    expect(classify(frame as Frame)).toBe(expected);
  },
);

it.each([
  ["请输入密码", "identity-input"],
  ["手机验证码", "verification-code"],
  ["支付确认", "payment"],
  ["确定", "unknown-confirmation"],
  ["是否继续刚才的战斗", "unknown-confirmation"],
])(
  "blocks a foreground %s before recognizing its underlying promotion",
  (text, expected) => {
    expect(
      classify({
        ...promotion,
        texts: [...promotion.texts, overlay(text)],
      } as Frame),
    ).toBe(expected);
  },
);

it.each(["missing-anchor", "low-confidence", "invalid-box", "different-size"])(
  "keeps incomplete promotion evidence unknown (%s)",
  (invalid) => {
    const frame = structuredClone(promotion) as Frame;
    if (invalid === "missing-anchor")
      frame.texts = frame.texts.filter((hit) => !hit.text.includes("空白"));
    if (invalid === "low-confidence")
      frame.texts.forEach((hit) => {
        hit.score = 0.5;
      });
    if (invalid === "invalid-box") frame.texts[0].box[0] = NaN;
    if (invalid === "different-size") frame.width = 1280;
    expect(classify(frame)).toBe("unknown");
  },
);

it("never grants automatic Onmyoji replay from a familiar page", () => {
  const recovery = gamePlugins.get("onmyoji").recovery;
  const task = {
    gameId: "onmyoji",
    plan: { mode: "live" },
    status: "failed",
    steps: [{ skillId: "daily-gift", status: "failed" }],
  } as never;
  expect(recovery.allowRetry(task, "unknown", 0)).toBe(false);
  expect(recovery.propose(task, "unknown", 0)).toBeUndefined();
  expect((recovery as any).replayBlockers?.(task)).toEqual([
    expect.stringMatching(/未确认/),
  ]);
});
