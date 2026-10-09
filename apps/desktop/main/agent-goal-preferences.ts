import type { DeviceLanes } from "../../../packages/protocol";
import { validateDeviceLanes } from "../../../packages/protocol";
import type { ArknightsProfiles } from "../../../games/arknights/config";
import { validateArknightsProfiles } from "../../../games/arknights/config";
import type { ConfiguredSnapshot } from "../../../packages/agent/configured";
import { createAgentTools } from "../../../packages/agent/tools";
import {
  agentObject,
  agentString,
  AgentToolError,
} from "../../../packages/protocol/agent";
import { canonical } from "../../../packages/acceptance/files";
import {
  preferenceLaneForSkills,
  currentPreferenceSkillIds,
} from "../../../games/agent-preferences";
import type { AgentRuntimePrincipal } from "../../../packages/protocol/agent-runtime";
import {
  assertAgentGameMessageScope,
  assertAgentPreferenceAccounts,
  assertAgentPreferenceMessageAuthority,
  gamePreferencePrompt,
  isShoppingOnlyPreference,
  type MessageScopeSnapshot,
} from "../../../games/agent-message-scope";
import { plannerAwardLabels } from "../../../games/arknights/award-flags";
import { gamePlugins } from "../../../games/registry";
import { gameMessageAuthority } from "../../../packages/agent/game-message-authority";

export interface AgentGoalPreferenceInput {
  environmentRevision: string;
  laneIds: string[];
  gameId: string;
  skillIds: string[];
  shopping?: boolean;
  parameters?: Record<string, boolean>;
}
export interface AgentGoalPreferenceResult {
  environmentRevision: string;
  changedLaneIds: string[];
  summary: string;
}
export interface AgentGoalPreferencePorts {
  readConfigured(): Promise<ConfiguredSnapshot>;
  readLanes(): Promise<DeviceLanes>;
  saveLanes(lanes: DeviceLanes): Promise<unknown>;
  readProfiles(): Promise<ArknightsProfiles>;
  saveProfiles(profiles: ArknightsProfiles): Promise<unknown>;
  now?: () => Date;
  assertCurrent?(principal: AgentRuntimePrincipal): void | Promise<void>;
}
function inputValue(input: unknown): AgentGoalPreferenceInput {
  const value = agentObject(input, [
    "environmentRevision",
    "laneIds",
    "gameId",
    "skillIds",
    "shopping",
    "parameters",
  ]);
  const ids = (raw: unknown, title: string): string[] => {
    if (
      !Array.isArray(raw) ||
      raw.length < 1 ||
      raw.length > 32 ||
      raw.some(
        (id) => typeof id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(id),
      ) ||
      new Set(raw).size !== raw.length
    )
      throw new AgentToolError(
        "INVALID_INPUT",
        `${title}必须是非空且不重复的有效编号列表`,
      );
    return [...raw];
  };
  if (value.shopping !== undefined && typeof value.shopping !== "boolean")
    throw new AgentToolError("INVALID_INPUT", "购物偏好必须为布尔值");
  const parameters =
    value.parameters === undefined
      ? undefined
      : agentObject(value.parameters, [
          "mail",
          "taskAward",
          ...Object.keys(plannerAwardLabels),
        ]);
  if (
    parameters &&
    Object.values(parameters).some((flag) => typeof flag !== "boolean")
  )
    throw new AgentToolError("INVALID_INPUT", "奖励偏好只能包含受限布尔开关");
  return {
    environmentRevision: agentString(value.environmentRevision, "环境版本"),
    laneIds: ids(value.laneIds, "账号"),
    gameId: agentString(value.gameId, "游戏"),
    skillIds: ids(value.skillIds, "任务"),
    ...(value.shopping === undefined
      ? {}
      : { shopping: value.shopping as boolean }),
    ...(parameters === undefined
      ? {}
      : { parameters: parameters as Record<string, boolean> }),
  };
}

/** This host service writes the existing configuration source; chat text is not a second store. */
export class AgentGoalPreferencesService {
  private saving = false;
  constructor(private ports: AgentGoalPreferencePorts) {}
  async save(
    raw: unknown,
    principal?: AgentRuntimePrincipal,
  ): Promise<AgentGoalPreferenceResult> {
    const input = inputValue(raw);
    const preferencePrompt =
      principal && gamePreferencePrompt(principal.prompt);
    const shoppingOnly =
      !!preferencePrompt && isShoppingOnlyPreference(preferencePrompt);
    if (principal) {
      assertAgentPreferenceMessageAuthority(principal.prompt);
      await this.ports.assertCurrent?.(principal);
    }
    if (this.saving)
      throw new AgentToolError(
        "PREFERENCE_BUSY",
        "偏好正在保存，请读取最新配置后重试",
      );
    this.saving = true;
    let wrote = false;
    try {
      const [configured, rawLanes, rawProfiles] = await Promise.all([
        this.ports.readConfigured(),
        this.ports.readLanes(),
        this.ports.readProfiles(),
      ]);
      const snapshot = configured.snapshot;
      const environment = createAgentTools(snapshot).call("get_environment");
      if (
        !["configured", "recorded"].includes(snapshot.source) ||
        !environment.complete ||
        environment.revision !== input.environmentRevision ||
        !snapshot.lanes ||
        !snapshot.profiles
      )
        throw new AgentToolError(
          "ENVIRONMENT_CHANGED",
          "偏好必须绑定当前本地环境版本，请重新读取账号配置",
        );
      const lanes = validateDeviceLanes(rawLanes),
        profiles = validateArknightsProfiles(rawProfiles);
      if (
        snapshot.lanes.lanes.length !== lanes.lanes.length ||
        snapshot.profiles.profiles.length !== profiles.profiles.length
      )
        throw new AgentToolError("ENVIRONMENT_CHANGED", "账号或设备映射已变化");
      const selectedIndices = input.laneIds.map((id) =>
        snapshot.lanes!.lanes.findIndex((lane) => lane.id === id),
      );
      if (selectedIndices.some((index) => index < 0))
        throw new AgentToolError("INVALID_INPUT", "账号别名不在当前环境中");
      if (principal) {
        assertAgentPreferenceAccounts(
          principal.prompt,
          selectedIndices,
          lanes.lanes,
          profiles,
          input.gameId,
        );
        if (
          input.shopping !== undefined &&
          (!/购物|购买|信用|商店/.test(preferencePrompt!) ||
            (gameMessageAuthority(preferencePrompt!).constraints.shopping ===
              false &&
              input.shopping !== false))
        )
          throw new AgentToolError(
            "GOAL_SCOPE_EXCEEDED",
            "购物设置与当前消息明确授权的偏好不一致",
          );
      }
      if (input.parameters && input.gameId !== "arknights")
        throw new AgentToolError(
          "UNSUPPORTED_PREFERENCE",
          "奖励参数只适用于已注册方舟奖励开关",
        );
      const nextLanes = structuredClone(lanes),
        nextProfiles = structuredClone(profiles);
      for (const index of selectedIndices) {
        const alias = snapshot.lanes.lanes[index],
          lane = lanes.lanes[index];
        const profileIndex = snapshot.profiles.profiles.findIndex(
          (profile) => profile.id === alias.arknights.profileId,
        );
        const profile = profiles.profiles[profileIndex];
        if (
          alias.id !== `lane-${String.fromCharCode(97 + index)}` ||
          alias.instance !== lane.instance ||
          !profile ||
          alias.arknights.profileId !== `profile-${profileIndex + 1}` ||
          lane.arknights.profileId !== profile.id
        )
          throw new AgentToolError(
            "ENVIRONMENT_CHANGED",
            "当前账号别名、实例或档案绑定不一致",
          );
        if (
          shoppingOnly &&
          (input.shopping === undefined ||
            Object.keys(input.parameters ?? {}).length ||
            canonical(
              [
                ...currentPreferenceSkillIds(
                  input.gameId,
                  lane,
                  profile,
                ).filter((id) => id !== "login"),
              ].sort(),
            ) !==
              canonical(input.skillIds.filter((id) => id !== "login").sort()))
        )
          throw new AgentToolError(
            "GOAL_SCOPE_EXCEEDED",
            "只修改购物时必须保留原日常任务开关，不能附带修改其他奖励或任务",
          );
        nextLanes.lanes[index] = shoppingOnly
          ? lane
          : preferenceLaneForSkills(
              input.gameId,
              input.skillIds,
              lane,
              profile,
              (this.ports.now ?? (() => new Date()))(),
              input.parameters,
            );
        if (
          input.shopping !== undefined ||
          Object.keys(input.parameters ?? {}).length
        ) {
          if (input.gameId !== "arknights")
            throw new AgentToolError(
              "UNSUPPORTED_PREFERENCE",
              "档案动作开关仅适用于已注册的方舟动作",
            );
          if (
            lanes.lanes.some(
              (other, otherIndex) =>
                other.arknights.profileId === profile.id &&
                !selectedIndices.includes(otherIndex),
            )
          )
            throw new AgentToolError(
              "SHARED_PROFILE",
              "此动作档案由未选账号共享；必须包含所有受影响账号后才能保存",
            );
          Object.assign(
            nextProfiles.profiles[profileIndex],
            input.parameters ?? {},
            input.shopping === undefined
              ? {}
              : { creditShopping: input.shopping },
          );
        }
      }
      if (principal) {
        const plugin = gamePlugins.get(input.gameId);
        const snapshots: MessageScopeSnapshot[] = selectedIndices.map(
          (index) => {
            const lane = nextLanes.lanes[index];
            const skillIds = currentPreferenceSkillIds(
              input.gameId,
              lane,
              nextProfiles.profiles.find(
                (profile) => profile.id === lane.arknights.profileId,
              ),
            );
            const plan = {
              gameId: input.gameId,
              skillIds,
              mode: "live" as const,
            };
            return {
              lane,
              profile: nextProfiles.profiles.find(
                (profile) => profile.id === lane.arknights.profileId,
              ),
              [plugin.lane!.planKey]: plan,
            };
          },
        );
        assertAgentGameMessageScope(
          principal.prompt,
          snapshots.map((snapshot) => ({
            laneId: snapshot.lane.id,
            gameId: input.gameId,
            skillIds: (
              (snapshot as unknown as Record<string, unknown>)[
                plugin.lane!.planKey
              ] as { skillIds: string[] }
            ).skillIds,
            resources: {},
          })),
          snapshots,
          { mode: "preference", savedDaily: true },
        );
      }
      const [latest, latestLanes, latestProfiles] = await Promise.all([
        this.ports.readConfigured(),
        this.ports.readLanes(),
        this.ports.readProfiles(),
      ]);
      if (
        latest.fingerprint !== configured.fingerprint ||
        canonical(latestLanes) !== canonical(rawLanes) ||
        canonical(latestProfiles) !== canonical(rawProfiles)
      )
        throw new AgentToolError(
          "ENVIRONMENT_CHANGED",
          "保存前配置指纹已变化，未保存偏好；请重新读取",
        );
      if (principal) await this.ports.assertCurrent?.(principal);
      const profilesChanged = canonical(nextProfiles) !== canonical(profiles),
        lanesChanged = canonical(nextLanes) !== canonical(lanes);
      if (profilesChanged) {
        wrote = true;
        await this.ports.saveProfiles(nextProfiles);
      }
      if (lanesChanged) {
        wrote = true;
        await this.ports.saveLanes(nextLanes);
      }
      const [afterLanes, afterProfiles, after] = await Promise.all([
        this.ports.readLanes(),
        this.ports.readProfiles(),
        this.ports.readConfigured(),
      ]);
      if (
        canonical(afterLanes) !== canonical(nextLanes) ||
        canonical(afterProfiles) !== canonical(nextProfiles)
      )
        throw new AgentToolError(
          "PREFERENCE_SAVE_UNKNOWN",
          "保存后配置与授权范围不一致，请重新读取核对实际偏好",
        );
      return {
        environmentRevision: createAgentTools(after.snapshot).call(
          "get_environment",
        ).revision,
        changedLaneIds:
          profilesChanged || lanesChanged ? [...input.laneIds] : [],
        summary:
          profilesChanged || lanesChanged
            ? "已保存所选账号的日常任务开关与明确指定的购物偏好；未启动游戏"
            : "当前偏好已与所选设置一致；未启动游戏",
      };
    } catch (error) {
      if (
        wrote &&
        !(
          error instanceof AgentToolError &&
          error.code === "PREFERENCE_SAVE_UNKNOWN"
        )
      )
        throw new AgentToolError(
          "PREFERENCE_SAVE_UNKNOWN",
          "偏好保存中断，可能已保存部分配置；请重新读取核对，未启动游戏",
        );
      throw error;
    } finally {
      this.saving = false;
    }
  }
}
