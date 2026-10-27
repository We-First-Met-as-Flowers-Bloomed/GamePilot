import { describe, expect, it } from "vitest";
import {
  collectiveClaimAction,
  collectiveProgress,
  collectiveSubmitAction,
  isCollectiveTaskPage,
} from "../games/onmyoji/policy";
import type { Frame } from "../packages/runtime/device";
import claimable from "./fixtures/onmyoji/collective-claimable-20261015.json";
import claimed from "./fixtures/onmyoji/collective-claimed-20261015.json";

/**
 * 2026-10-15 实机：新版阴阳寮集体任务改成三张卡（选/指/指），按钮是「提交」（消耗 N 阶式神）
 * 或「领取奖励」（已完成、零成本）。旧实现只认提交流程，在新版下走不通（技能当时是禁用状态）。
 * 夹具是两张真实帧的 OCR 结果，见 collective-tasks-20261015.sources.json 的溯源。
 */
const claimableFrame = claimable as unknown as Frame;
const claimedFrame = claimed as unknown as Frame;

describe("新版集体任务判据", () => {
  it("两张真实帧都认作集体任务页，并读到 10/30 进度", () => {
    expect(isCollectiveTaskPage(claimableFrame)).toBe(true);
    expect(isCollectiveTaskPage(claimedFrame)).toBe(true);
    expect(collectiveProgress(claimableFrame)).toEqual({ completed: 10, total: 30 });
    expect(collectiveProgress(claimedFrame)).toEqual({ completed: 10, total: 30 });
  });

  it("有可领奖励时给出领取动作，领完之后不再给", () => {
    const claim = collectiveClaimAction(claimableFrame);
    expect(claim?.text).toBe("领取奖励");
    expect(claim?.box[0]).toBeGreaterThan(800);
    expect(collectiveClaimAction(claimedFrame)).toBeUndefined();
  });

  it("提交卡只识别、不在技能里点击（会消耗式神）", () => {
    // 两张帧上「提交」都在：技能据此在摘要里如实说明"未自动提交"。
    expect(collectiveSubmitAction(claimableFrame)?.text).toBe("提交");
    expect(collectiveSubmitAction(claimedFrame)?.text).toBe("提交");
  });

  it("不在集体任务页时两个动作都不返回，避免误点", () => {
    const courtyard: Frame = {
      width: 1920,
      height: 1080,
      texts: [
        { text: "加成", box: [552, 49, 34, 66], score: 0.999 },
        { text: "领取奖励", box: [878, 720, 164, 42], score: 0.998 },
        { text: "提交", box: [410, 718, 86, 44], score: 1 },
      ],
    };
    expect(collectiveClaimAction(courtyard)).toBeUndefined();
    expect(collectiveSubmitAction(courtyard)).toBeUndefined();
  });
});
