/**
 * 渠道（MuMu 实例）→ 流水线 lane 草稿的纯函数映射。
 *
 * 2026-10-22 渠道化：用户不再手填 instance/端口，而是由"扫描到的渠道"一键生成 lane。
 * 这里刻意不依赖 React / Electron / DOM，便于单元测试。
 */
import type { DeviceLane, MuMuInstance } from "../../../packages/protocol";

export interface LaneDraftOptions {
  /** 一台设备只创建一个游戏账号；安装多个游戏时必须明确选择。 */
  gameId?: "arknights" | "onmyoji";
  /** 该渠道所属 MuMu 安装的 MuMuManager.exe 路径。 */
  managerPath: string;
  /** 方舟账号档案 id（生成 lane 时绑定）。 */
  profileId: string;
  /** 已绑定过渠道的实例号，用于去重。 */
  boundInstances: readonly number[];
  /** 生成唯一 id 用的时间戳（测试可注入固定值）。 */
  now: number;
}

/**
 * 把一个渠道映射成 lane 草稿。
 * 返回 null 表示"这个渠道当前不该进流水线"（未就绪 / 没有我们支持的游戏）。
 */
export function laneDraftFromChannel(
  channel: MuMuInstance,
  options: LaneDraftOptions,
): DeviceLane | null {
  if (!channel.automationReady) return null;
  const supported = channel.supportedGames ?? [];
  const games = [...new Set(supported)].filter(
    (id) => id === "arknights" || id === "onmyoji",
  );
  const gameId = options.gameId ?? (games.length === 1 ? games[0] : undefined);
  if (!gameId || !games.includes(gameId)) return null;
  if (options.boundInstances.includes(channel.instance)) return null;

  return {
    id: `lane-${options.now.toString(36)}-${channel.instance}`,
    name: channel.name || `MuMu ${channel.instance}`,
    managerPath: options.managerPath,
    instance: channel.instance,
    enabled: true,
    arknights: {
      enabled: gameId === "arknights",
      profileId: options.profileId,
    },
    onmyoji: { enabled: gameId === "onmyoji" },
    closeEmulatorAfterSuccess: false,
  };
}

/** 批量：为所有"可直接自动化且尚未绑定"的渠道生成 lane 草稿（保持扫描顺序）。 */
export function laneDraftsFromChannels(
  channels: readonly MuMuInstance[],
  options: LaneDraftOptions,
): DeviceLane[] {
  const drafts: DeviceLane[] = [];
  const bound = new Set(options.boundInstances);
  channels.forEach((channel, index) => {
    const draft = laneDraftFromChannel(channel, {
      ...options,
      boundInstances: [...bound],
      // 同一批里各 lane 的 id 也要唯一：用 index 参与时间戳
      now: options.now + index,
    });
    if (draft) {
      drafts.push(draft);
      bound.add(channel.instance);
    }
  });
  return drafts;
}
