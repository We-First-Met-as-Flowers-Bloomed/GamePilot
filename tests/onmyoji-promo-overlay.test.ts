import { describe, expect, it } from "vitest";
import { promoInvitationClosePoint } from "../games/onmyoji/policy";
import type { Frame, TextHit } from "../packages/runtime/device";
import fixture from "./fixtures/onmyoji/promo-invitation-20261015.json";

/**
 * 2026-10-15 实机：庭场上挂着已过期的活动浮层「诞生庆典·邀请函」（活动期 10.10–10.12），
 * 把庭院事务入口挡住，`check-in` 因此报「画面未进入预期状态」。
 * 夹具就是当时那张 1920x1080 真实帧的 OCR 结果（见同名 .sources.json 的溯源）。
 */
const overlay = fixture as unknown as Frame;
const withText = (text: string, box: [number, number, number, number]): Frame => ({
  ...overlay,
  texts: [
    ...(overlay.texts as TextHit[]),
    { text, box, score: 0.99 },
  ],
});

describe("过期活动邀请函浮层", () => {
  it("识别真实帧并给出实测的关闭点", () => {
    expect(promoInvitationClosePoint(overlay)).toEqual([1801, 176]);
  });

  it("画面上有确认/购买类文字时一律不动", () => {
    // 与花合战宣传页同一条安全约定：宁可停下等人核对，也不赌一个坐标。
    expect(
      promoInvitationClosePoint(withText("确认", [900, 600, 100, 60])),
    ).toBeNull();
    expect(
      promoInvitationClosePoint(withText("购买", [900, 700, 100, 60])),
    ).toBeNull();
    expect(
      promoInvitationClosePoint(withText("消耗", [900, 800, 100, 60])),
    ).toBeNull();
  });

  it("缺少标题、入口或活动期任一锚点时不动作", () => {
    const withoutEnter: Frame = {
      ...overlay,
      texts: (overlay.texts as TextHit[]).filter(
        (hit) => hit.text !== "前往庆典",
      ),
    };
    expect(promoInvitationClosePoint(withoutEnter)).toBeNull();
    const withoutPeriod: Frame = {
      ...overlay,
      texts: (overlay.texts as TextHit[]).filter(
        (hit) => !hit.text.includes("20:00"),
      ),
    };
    expect(promoInvitationClosePoint(withoutPeriod)).toBeNull();
  });

  it("锚点分数偏低时不动作（避免把别的弹窗当成邀请函）", () => {
    const lowScore: Frame = {
      ...overlay,
      texts: (overlay.texts as TextHit[]).map((hit) =>
        hit.text === "前往庆典" ? { ...hit, score: 0.82 } : hit,
      ),
    };
    expect(promoInvitationClosePoint(lowScore)).toBeNull();
  });

  it("普通庭院帧不会误判", () => {
    const plain: Frame = {
      width: 1920,
      height: 1080,
      texts: [
        { text: "加成", box: [552, 49, 34, 66], score: 0.999 },
        { text: "花合战", box: [1148, 990, 90, 28], score: 0.972 },
        { text: "阴阳寮", box: [804, 984, 102, 44], score: 0.924 },
      ],
    };
    expect(promoInvitationClosePoint(plain)).toBeNull();
  });
});
