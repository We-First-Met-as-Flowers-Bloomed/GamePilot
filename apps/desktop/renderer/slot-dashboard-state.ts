import type {
  DeviceLane,
  RunEvent,
  RunStatus,
} from "../../../packages/protocol";
import type { ArknightsProfile } from "../../../games/arknights/config";
import type { ExecutionRecord } from "../../../packages/protocol/execution";
import type { TaskRecord } from "../../../packages/protocol/task-record";
import type { dailyLaneState } from "./daily-state";
import { gameSlotRecords } from "./game-slot-records";
import { isActiveStatus } from "../../../packages/protocol/run-state";
import { projectAccountChannels } from "./account-channels";
import {
  channelGame,
  canonicalChannelDeviceKey,
} from "../../../packages/protocol/account-channel";

export function slotDashboardState(input: {
  lanes: readonly DeviceLane[];
  profiles: readonly ArknightsProfile[];
  // Mixed lane summaries cannot prove a game slot's result.
  dailyStates?: Readonly<
    Record<string, ReturnType<typeof dailyLaneState> | undefined>
  >;
  laneStatuses?: Readonly<Record<string, RunStatus | null | undefined>>;
  tasks?: readonly TaskRecord[];
  requests?: readonly ExecutionRecord[];
  events?: readonly RunEvent[];
  now?: Date;
}) {
  const slots = projectAccountChannels(input).map((channel) => {
    const { lane, game, profile } = channel;
    const gameId = game.id;
    const facts = gameSlotRecords({
      lane,
      gameId,
      profile,
      requests: input.requests,
      tasks: input.tasks,
      events: input.events,
      now: input.now,
    });
    const owner = facts.latestRequest?.snapshot.gameSlot as
      { laneId?: string; gameId?: string } | undefined;
    const stopKind = facts.active
      ? owner?.laneId === lane.id && owner.gameId === gameId
        ? "game-slot"
        : channelGame(lane) === gameId &&
            facts.latestRequest?.laneId === lane.id
          ? "channel"
          : undefined
      : undefined;
    return {
      ...channel,
      games: [game],
      facts,
      status: facts.status,
      active: facts.active,
      label: facts.label,
      gameDay: facts.gameDay,
      boundRecords: facts.records,
      canStop: !!stopKind,
      stopKind,
    };
  });
  const deviceKey = (slot: (typeof slots)[number]) =>
    canonicalChannelDeviceKey(slot.lane.managerPath, slot.game.instance) === "*"
      ? `unconfigured:${slot.game.instance}`
      : canonicalChannelDeviceKey(slot.lane.managerPath, slot.game.instance);
  const projected = slots.map((slot) => {
    const shared = slots.filter(
      (other) => other.id !== slot.id && deviceKey(other) === deviceKey(slot),
    );
    const blocking = slots.find(
      (other) =>
        other.id !== slot.id &&
        other.active &&
        (other.lane.id === slot.lane.id ||
          deviceKey(other) === deviceKey(slot)),
    );
    return {
      ...slot,
      sharedWith: shared.map(
        (other) => `${other.game.name} · ${other.accountName}`,
      ),
      blockedBy: blocking
        ? `${blocking.game.name} · ${blocking.accountName}`
        : isActiveStatus(input.laneStatuses?.[slot.lane.id]) && !slot.active
          ? "账号渠道请求（游戏范围待核对）"
          : undefined,
      canRun:
        slot.lane.enabled &&
        !slot.active &&
        !blocking &&
        !isActiveStatus(input.laneStatuses?.[slot.lane.id]),
    };
  });
  return {
    slots: projected,
    deviceCount: new Set(slots.map(deviceKey)).size,
    counts: {
      configured: slots.length,
      enabled: slots.filter((s) => s.lane.enabled).length,
      active: slots.filter((s) => s.active).length,
    },
  };
}
