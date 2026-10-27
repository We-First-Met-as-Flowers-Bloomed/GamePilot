import type { DeviceLane } from "../../../packages/protocol";
import type { ArknightsProfile } from "../../../games/arknights/config";
import type { ChannelGame } from "../../../packages/protocol/account-channel";

/** The display model for one game account, also readable for pre-migration data. */
export function projectAccountChannels(input: {
  lanes: readonly DeviceLane[];
  profiles: readonly ArknightsProfile[];
}) {
  return input.lanes.flatMap((lane) => {
    const profile = input.profiles.find(
      (p) => p.id === lane.arknights.profileId,
    );
    return (["arknights", "onmyoji"] as ChannelGame[])
      .filter((id) => lane[id].enabled)
      .map((gameId) => {
        const identity = lane.onmyoji.identity;
        const game = {
          id: gameId,
          name: gameId === "arknights" ? "明日方舟" : "阴阳师",
          instance: lane.deviceInstances?.[gameId] ?? lane.instance,
          profileName:
            gameId === "arknights"
              ? (profile?.name ?? "账号档案缺失")
              : lane.name.replace(/\s*[·・]\s*双游戏\s*$/, ""),
          clientLabel:
            gameId === "arknights"
              ? profile
                ? profile.clientType === "Official"
                  ? "官服"
                  : "B服"
                : "服务器未配置"
              : (identity?.serverName ?? "区服未绑定"),
          identityLabel:
            gameId === "arknights"
              ? profile?.expectedUid
                ? "UID 已配置 · 运行时核对"
                : "UID 未绑定 · 身份未验证"
              : identity
                ? "角色已配置 · 身份验证未认证"
                : "角色未绑定 · 身份未验证",
        };
        return {
          id: `${lane.id}:${gameId}`,
          lane,
          game,
          profile,
          accountName: game.profileName,
          target: { laneId: lane.id, gameId },
        };
      });
  });
}
