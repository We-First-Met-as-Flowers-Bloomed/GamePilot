import { describe, expect, it } from "vitest";
import type { MuMuInstance } from "../packages/protocol";
import {
  laneDraftFromChannel,
  laneDraftsFromChannels,
} from "../apps/desktop/renderer/channel-lane";

function channel(
  overrides: Partial<MuMuInstance> & { instance: number },
): MuMuInstance {
  return {
    name: `MuMu ${overrides.instance}`,
    running: true,
    ready: true,
    address: `127.0.0.1:${16384 + 32 * overrides.instance}`,
    arknights: null,
    onmyoji: false,
    supportedGames: [],
    automationReady: false,
    ...overrides,
  };
}

const options = {
  managerPath: "D:/mumu12/nx_main/MuMuManager.exe",
  profileId: "official-account",
  boundInstances: [] as number[],
  now: 1_700_000_000_000,
};

describe("channel-lane · 单个渠道映射", () => {
  it("未就绪的渠道不进流水线", () => {
    const c = channel({
      instance: 0,
      arknights: "Bilibili",
      automationReady: false,
    });
    expect(laneDraftFromChannel(c, options)).toBeNull();
  });

  it("没有可自动化游戏的渠道不进流水线", () => {
    const c = channel({
      instance: 2,
      onmyoji: true,
      automationReady: true,
      supportedGames: [],
    });
    expect(laneDraftFromChannel(c, options)).toBeNull();
  });

  it("只装方舟的渠道：只启用方舟，并沿用 managerPath/档案", () => {
    const c = channel({
      instance: 0,
      arknights: "Bilibili",
      automationReady: true,
      supportedGames: ["arknights"],
    });
    const lane = laneDraftFromChannel(c, options);
    expect(lane).not.toBeNull();
    expect(lane).toMatchObject({
      instance: 0,
      managerPath: options.managerPath,
      enabled: true,
      arknights: { enabled: true, profileId: "official-account" },
      onmyoji: { enabled: false },
      closeEmulatorAfterSuccess: false,
    });
    expect(lane?.id).toContain("0");
  });

  it("渠道能力里含阴阳师时才会启用阴阳师", () => {
    const c = channel({
      instance: 2,
      onmyoji: true,
      automationReady: true,
      supportedGames: ["onmyoji"],
    });
    const lane = laneDraftFromChannel(c, options);
    expect(lane?.onmyoji.enabled).toBe(true);
    expect(lane?.arknights.enabled).toBe(false);
  });

  it("已绑定过的实例不重复生成", () => {
    const c = channel({
      instance: 1,
      arknights: "Official",
      automationReady: true,
      supportedGames: ["arknights"],
    });
    expect(
      laneDraftFromChannel(c, { ...options, boundInstances: [1] }),
    ).toBeNull();
  });

  it("安装两个游戏的设备必须先选择游戏，不生成混合渠道", () => {
    const c = channel({
      instance: 4,
      automationReady: true,
      supportedGames: ["arknights", "onmyoji"],
    });
    expect(laneDraftFromChannel(c, options)).toBeNull();
    const lane = laneDraftFromChannel(c, { ...options, gameId: "onmyoji" });
    expect(lane?.arknights.enabled).toBe(false);
    expect(lane?.onmyoji.enabled).toBe(true);
  });

  it("名称缺失时回退为「MuMu <实例号>」", () => {
    const c = channel({
      instance: 3,
      arknights: "Official",
      automationReady: true,
      supportedGames: ["arknights"],
    });
    const lane = laneDraftFromChannel({ ...c, name: "" }, options);
    expect(lane?.name).toBe("MuMu 3");
  });
});

describe("channel-lane · 批量映射", () => {
  it("同一次扫描的重复实例只生成一个渠道", () => {
    const c = channel({
      instance: 2,
      automationReady: true,
      supportedGames: ["onmyoji"],
    });
    expect(laneDraftsFromChannels([c, c], options)).toHaveLength(1);
  });
  it("只挑可自动化且未绑定的渠道，保持扫描顺序且 id 唯一", () => {
    const channels = [
      channel({
        instance: 0,
        arknights: "Bilibili",
        automationReady: true,
        supportedGames: ["arknights"],
      }),
      channel({
        instance: 1,
        arknights: "Official",
        automationReady: true,
        supportedGames: ["arknights"],
      }),
      channel({ instance: 2, running: false, automationReady: false }),
      channel({
        instance: 3,
        arknights: "Official",
        automationReady: true,
        supportedGames: ["arknights"],
      }),
    ];
    const lanes = laneDraftsFromChannels(channels, {
      ...options,
      boundInstances: [1],
    });
    expect(lanes.map((l) => l.instance)).toEqual([0, 3]);
    expect(new Set(lanes.map((l) => l.id)).size).toBe(2);
  });

  it("全部已绑定或不可自动化时返回空数组", () => {
    const channels = [
      channel({
        instance: 0,
        arknights: "Bilibili",
        automationReady: true,
        supportedGames: ["arknights"],
      }),
      channel({ instance: 1, automationReady: false }),
    ];
    expect(
      laneDraftsFromChannels(channels, { ...options, boundInstances: [0] }),
    ).toEqual([]);
  });
});
