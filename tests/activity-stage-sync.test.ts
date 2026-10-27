import { describe, expect, it } from "vitest";
import {
  isMainlineStage,
  looksLikeActivityStage,
  resolveMaaCliPath,
  resolveRunStage,
  type StageResolverPort,
} from "../apps/desktop/main/activity-stage-sync";

const resolved = (stage: string, name = "关卡"): StageResolverPort => ({
  resolve: async () => ({ stage, name }),
});

describe("resolveMaaCliPath", () => {
  it("环境变量优先", () => {
    const path = resolveMaaCliPath({
      env: { GAMEPILOT_MAA_CLI: "X:\\custom\\maa.exe", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
      exists: () => true,
    });
    expect(path).toBe("X:\\custom\\maa.exe");
  });

  it("回退到用户级安装位置", () => {
    const path = resolveMaaCliPath({
      env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
      exists: (candidate) => candidate.includes("Programs"),
    });
    expect(path).toContain("maa-cli");
  });

  it("都找不到返回 null（上层回退档案关卡）", () => {
    expect(resolveMaaCliPath({ env: {}, exists: () => false })).toBeNull();
  });
});

describe("resolveRunStage", () => {
  it("开关关闭 → 用档案关卡", async () => {
    const result = await resolveRunStage({
      enabled: false,
      clientType: "Bilibili",
      configuredStage: "YW-7",
      resolver: resolved("YW-8"),
    });
    expect(result).toMatchObject({ stage: "YW-7", followed: false });
  });

  it("开关开启且解析成功 → 跟随活动关卡", async () => {
    const result = await resolveRunStage({
      enabled: true,
      clientType: "Official",
      configuredStage: "YW-7",
      resolver: resolved("YW-8", "液化高能气体"),
    });
    expect(result).toMatchObject({ stage: "YW-8", followed: true });
    expect(result.note).toContain("YW-8");
  });

  it("找不到 maa-cli → 回退档案关卡", async () => {
    const result = await resolveRunStage({
      enabled: true,
      clientType: "Bilibili",
      configuredStage: "1-7",
      resolver: null,
    });
    expect(result).toMatchObject({ stage: "1-7", followed: false });
    expect(result.note).toContain("maa-cli");
  });

  it("解析不到活动关卡 → 回退档案关卡（不猜）", async () => {
    const result = await resolveRunStage({
      enabled: true,
      clientType: "Bilibili",
      configuredStage: "1-7",
      resolver: { resolve: async () => null },
    });
    expect(result).toMatchObject({ stage: "1-7", followed: false });
  });

  it("解析器抛错 → 回退档案关卡", async () => {
    const result = await resolveRunStage({
      enabled: true,
      clientType: "Bilibili",
      configuredStage: "1-7",
      resolver: {
        resolve: async () => {
          throw new Error("boom");
        },
      },
    });
    expect(result).toMatchObject({ stage: "1-7", followed: false });
  });
});

describe("activity stage expiry fallback（2026-10-23 昨日海结束实测）", () => {
  it("活动结束且档案里是已失效活动关 → 回退经验本 LS-5", async () => {
    const result = await resolveRunStage({
      enabled: true,
      clientType: "Bilibili",
      configuredStage: "YW-8",
      resolver: { resolve: async () => null },
      fallbackStage: "LS-5",
    });
    expect(result).toMatchObject({ stage: "LS-5", followed: false });
    expect(result.note).toContain("LS-5");
    expect(result.note).toContain("YW-8");
  });

  it("玩家自选的常驻关卡（CE-5/LS-5/1-7）不会被回退覆盖", async () => {
    for (const configured of ["CE-5", "LS-5", "1-7", "PR-B"]) {
      const result = await resolveRunStage({
        enabled: true,
        clientType: "Bilibili",
        configuredStage: configured,
        resolver: { resolve: async () => null },
        fallbackStage: "LS-5",
      });
      expect(result.stage).toBe(configured);
    }
  });

  it("没有配置 fallbackStage 时仍保留档案关卡（保守，不猜）", async () => {
    const result = await resolveRunStage({
      enabled: true,
      clientType: "Bilibili",
      configuredStage: "YW-8",
      resolver: { resolve: async () => null },
    });
    expect(result).toMatchObject({ stage: "YW-8", followed: false });
  });
});

describe("stage 形态判定", () => {
  it("isMainlineStage 覆盖数字章节与常驻资源关", () => {
    for (const stage of ["1-7", "12-3", "CE-5", "LS-5", "CA-5", "AP-5", "SK-5", "PR-B"])
      expect(isMainlineStage(stage)).toBe(true);
    for (const stage of ["YW-8", "OF-1", ""]) expect(isMainlineStage(stage)).toBe(false);
  });

  it("looksLikeActivityStage 只认活动形态，不吞常驻关", () => {
    expect(looksLikeActivityStage("YW-8")).toBe(true);
    for (const stage of ["CE-5", "LS-5", "1-7", "PR-B", ""])
      expect(looksLikeActivityStage(stage)).toBe(false);
  });
});
