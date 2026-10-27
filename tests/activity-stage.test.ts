import { describe, expect, it } from "vitest";
import {
  ActivityStageResolver,
  parseActivityStage,
} from "../packages/runtime/activity-stage";

/** 实测 `maa activity Bilibili` 输出片段。 */
const SAMPLE = `Opening side story stages:
- SideStory「昨日海」
  - YW-8: 液化高能气体
  - YW-7: 转质盐组
  - YW-6: 全新装置
- SideStory「其他活动」
  - XX-3: 某个关卡
Opening mini games:
- 黑流树海刷钱
`;

describe("activity stage parsing", () => {
  it("取活动列表里的第一个关卡", () => {
    expect(parseActivityStage(SAMPLE)).toEqual({ stage: "YW-8", name: "液化高能气体" });
  });

  it("没有活动关卡时返回 null（调用方回退用户配置，不猜）", () => {
    expect(parseActivityStage("Opening side story stages:\nOpening mini games:\n- 黑流树海刷钱\n")).toBeNull();
    expect(parseActivityStage("")).toBeNull();
  });

  it("不把迷你游戏当成关卡", () => {
    const onlyMini = "Opening mini games:\n- 黑流树海刷钱\n";
    expect(parseActivityStage(onlyMini)).toBeNull();
  });
});

describe("activity stage resolver", () => {
  it("解析成功并缓存（TTL 内不重复调用）", async () => {
    let calls = 0;
    const resolver = new ActivityStageResolver({
      maaCliPath: "maa.exe",
      run: async () => {
        calls += 1;
        return SAMPLE;
      },
      now: () => 1_000,
      ttlMs: 60_000,
    });
    expect((await resolver.resolve("Bilibili"))?.stage).toBe("YW-8");
    expect((await resolver.resolve("Bilibili"))?.stage).toBe("YW-8");
    expect(calls).toBe(1);
  });

  it("TTL 过期后重新解析", async () => {
    let clock = 0;
    let calls = 0;
    const resolver = new ActivityStageResolver({
      maaCliPath: "maa.exe",
      run: async () => {
        calls += 1;
        return SAMPLE;
      },
      now: () => clock,
      ttlMs: 1_000,
    });
    await resolver.resolve("Official");
    clock = 5_000;
    await resolver.resolve("Official");
    expect(calls).toBe(2);
  });

  it("命令失败时返回 null 并缓存失败结果（不阻塞日常）", async () => {
    let calls = 0;
    const resolver = new ActivityStageResolver({
      maaCliPath: "maa.exe",
      run: async () => {
        calls += 1;
        throw new Error("maa-cli 不可用");
      },
      now: () => 0,
      ttlMs: 60_000,
    });
    expect(await resolver.resolve("Bilibili")).toBeNull();
    expect(await resolver.resolve("Bilibili")).toBeNull();
    expect(calls).toBe(1);
  });

  it("invalidate 后重新解析", async () => {
    let calls = 0;
    const resolver = new ActivityStageResolver({
      maaCliPath: "maa.exe",
      run: async () => {
        calls += 1;
        return SAMPLE;
      },
      now: () => 0,
      ttlMs: 60_000,
    });
    await resolver.resolve("Bilibili");
    resolver.invalidate();
    await resolver.resolve("Bilibili");
    expect(calls).toBe(2);
  });
});
