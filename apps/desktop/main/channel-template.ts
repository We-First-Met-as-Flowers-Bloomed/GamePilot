import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import {
  MAX_DEVICE_LANES,
  validateDeviceLanes,
  type DeviceLanes,
} from "../../../packages/protocol";
import {
  validateArknightsProfiles,
  type ArknightsProfiles,
} from "../../../games/arknights/config";
import type { ChannelCopyResult } from "../../../packages/protocol/channel";

/** Copies saved configuration only. Identity, devices and execution facts never inherit. */
export function prepareChannelCopies(
  lanes: DeviceLanes,
  profiles: ArknightsProfiles,
  input: unknown,
  nextId: () => string = randomUUID,
): ChannelCopyResult {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("渠道复制配置无效");
  const v = input as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) => !["sourceLaneId", "gameId", "targets"].includes(k),
    ) ||
    typeof v.sourceLaneId !== "string" ||
    !["arknights", "onmyoji"].includes(String(v.gameId)) ||
    !Array.isArray(v.targets) ||
    !v.targets.length ||
    lanes.lanes.length + v.targets.length > MAX_DEVICE_LANES
  )
    throw Error("请选择源渠道、游戏与目标设备，渠道数量超出限制");
  const source = lanes.lanes.find((l) => l.id === v.sourceLaneId);
  if (!source) throw Error("源渠道不存在");
  const game = v.gameId as "arknights" | "onmyoji";
  if (lanes.version === 2 && !source[game].enabled)
    throw Error("源渠道游戏与复制请求的来源游戏不一致");
  const sourceProfile = profiles.profiles.find(
    (p) => p.id === source.arknights.profileId,
  );
  if (game === "arknights" && !sourceProfile)
    throw Error("源渠道账号档案不存在");
  const result = structuredClone({ lanes, profiles });
  const canonical = (path: string) => win32.normalize(path).toLowerCase();
  const occupied = new Set(
    lanes.lanes
      .filter((l) => canonical(l.managerPath) === canonical(source.managerPath))
      .flatMap((l) => [l.instance, ...Object.values(l.deviceInstances ?? {})]),
  );
  const requested = new Set<number>();
  for (const raw of v.targets) {
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).some((k) => !["instance", "name"].includes(k))
    )
      throw Error("目标设备配置无效");
    const target = raw as { instance: number; name: string };
    if (
      !Number.isInteger(target.instance) ||
      target.instance < 0 ||
      target.instance > 999 ||
      typeof target.name !== "string" ||
      !target.name.trim() ||
      target.name.trim().length > 40
    )
      throw Error("目标设备编号或名称无效");
    if (requested.has(target.instance)) throw Error("目标实例不能重复");
    if (occupied.has(target.instance))
      throw Error("目标实例已被渠道绑定或占用");
    requested.add(target.instance);
    const copy = structuredClone(source);
    copy.id = `channel-${nextId()}`;
    copy.name = target.name.trim();
    copy.instance = target.instance;
    copy.enabled = false;
    copy.identityRequired = true;
    copy.closeEmulatorAfterSuccess = false;
    delete copy.deviceInstances;
    delete copy.legacyBinding;
    delete copy.onmyoji.identity;
    copy.arknights.enabled = game === "arknights";
    copy.onmyoji.enabled = game === "onmyoji";
    if (game === "arknights") {
      const profile = structuredClone(sourceProfile!);
      profile.id = `profile-${nextId()}`;
      profile.name = `${copy.name.slice(0, 29)} · ${profile.id.slice(-8)}`;
      profile.expectedUid = "";
      profile.accountName = "";
      profile.copilotFile = "";
      result.profiles.profiles.push(profile);
      copy.arknights.profileId = profile.id;
    }
    result.lanes.lanes.push(copy);
  }
  return {
    lanes: validateDeviceLanes(result.lanes),
    profiles: validateArknightsProfiles(result.profiles),
  };
}

interface CopyStores {
  deviceLanes: {
    read(): Promise<DeviceLanes>;
    save(value: DeviceLanes): Promise<DeviceLanes>;
  };
  arknights: {
    read(): Promise<ArknightsProfiles>;
    save(value: ArknightsProfiles): Promise<ArknightsProfiles>;
  };
}

/** Caller holds the App configuration gate throughout both writes and rollback. */
export async function persistChannelCopies(
  stores: CopyStores,
  input: unknown,
): Promise<ChannelCopyResult> {
  const [lanes, profiles] = await Promise.all([
    stores.deviceLanes.read(),
    stores.arknights.read(),
  ]);
  const result = prepareChannelCopies(lanes, profiles, input);
  await stores.arknights.save(result.profiles);
  try {
    await stores.deviceLanes.save(result.lanes);
  } catch (error) {
    try {
      await stores.arknights.save(profiles);
    } catch (rollback) {
      throw new AggregateError(
        [error, rollback],
        "渠道未创建，档案回滚失败；请先核对本机配置",
      );
    }
    throw error;
  }
  return result;
}
