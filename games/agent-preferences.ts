import type { DeviceLane } from "../packages/protocol";
import { AgentToolError } from "../packages/protocol/agent";
import { validateRoutine } from "../packages/protocol/routine";
import type { ArknightsProfile } from "./arknights/config";
import { gamePlugins } from "./registry";
import { defaultRoutine } from "./routines";
import { plannerDefaultSkills } from "./agent-configuration";
import { compileGameDraft } from "./agent";

export function currentPreferenceSkillIds(
  gameId: string,
  lane: DeviceLane,
  profile: ArknightsProfile | undefined,
): string[] {
  const plugin = gamePlugins.get(gameId);
  return validateRoutine(
    plugin.lane?.savedRoutine(lane) ??
      defaultRoutine(gameId, plannerDefaultSkills(gameId, profile)),
    plugin.descriptor,
  )
    .steps.filter((step) => step.enabled)
    .map((step) => step.skillId);
}

/** Selection updates flags only: existing order and calendar limits remain authoritative. */
export function preferenceLaneForSkills(
  gameId: string,
  skillIds: string[],
  lane: DeviceLane,
  profile: ArknightsProfile | undefined,
  now: Date,
  parameters: Record<string, boolean> = {},
): DeviceLane {
  const plugin = gamePlugins.get(gameId),
    binding = plugin.lane;
  if (
    !binding ||
    skillIds.some(
      (id) =>
        !plugin.dailySkills.includes(id) ||
        !plugin.descriptor.skills.some(
          (skill) => skill.id === id && skill.ready && !skill.maintenanceOnly,
        ),
    )
  )
    throw new AgentToolError(
      "UNSUPPORTED_PREFERENCE",
      "只能保存已支持的日常任务开关，不能新增维护或未适配动作",
    );
  const previous = validateRoutine(
    binding.savedRoutine(lane) ??
      defaultRoutine(gameId, plannerDefaultSkills(gameId, profile)),
    plugin.descriptor,
  );
  if (
    gameId === "onmyoji" &&
    skillIds.includes("guild-quest") &&
    !previous.steps.some(
      (step) => step.skillId === "guild-quest" && step.enabled,
    )
  )
    throw new AgentToolError(
      "RESOURCE_POLICY",
      "不能通过持久偏好新开会消耗式神的集体任务，请先在游戏设置中明确配置",
    );
  // Validate supported engine configuration and resource policy before any persistence.
  compileGameDraft(
    { gameId, skillIds, parameters },
    lane,
    profile,
    now.toISOString(),
  );
  const selected = new Set([
    ...skillIds,
    ...plugin.descriptor.skills
      .filter((skill) => skill.position === "first")
      .map((skill) => skill.id),
  ]);
  const steps = previous.steps.map((step) => ({
    ...step,
    enabled: selected.has(step.skillId),
  }));
  for (const id of plugin.dailySkills)
    if (selected.has(id) && !steps.some((step) => step.skillId === id)) {
      const last = steps.findIndex((step) =>
        plugin.descriptor.skills.some(
          (skill) => skill.id === step.skillId && skill.position === "last",
        ),
      );
      steps.splice(last < 0 ? steps.length : last, 0, {
        skillId: id,
        enabled: true,
      });
    }
  return binding.withRoutine(
    lane,
    validateRoutine({ version: 1, steps }, plugin.descriptor),
  );
}
