import contract from "./engine-contract.json";
import type { ArknightsConfig } from "./config";

export type AwardConfigKey =
  | "mail"
  | "freeRecruit"
  | "eventOrundum"
  | "eventMining"
  | "specialAccess"
  | "signInEvent";

interface AwardCapability {
  supported: boolean;
  label: string;
  configKey?: string;
  minVersion?: string;
}

export class ArknightsCapabilityError extends Error {}

/** Pinned distribution contract; native installation and game verification are separate checks. */
export function arknightsEngineCapabilities() {
  return structuredClone({
    version: contract.version,
    awardOptions: contract.awardOptions,
  });
}

export function arknightsAwardCapability(key: AwardConfigKey) {
  const capability = Object.values(contract.awardOptions).find(
    (option: AwardCapability) => option.configKey === key,
  ) as AwardCapability;
  return {
    ...capability,
    reason: capability.supported
      ? ""
      : `当前 MaaCore ${contract.version} 不支持${capability.label}（需 ${capability.minVersion}）；请在明日方舟设置中关闭此项后重试。升级内核前仍需重新验证兼容性。`,
  };
}

/** Only selected actions constrain execution; legacy settings remain readable. */
export function validateArknightsCapabilities(
  config: ArknightsConfig,
  skillIds: readonly string[],
): void {
  const advanced = config.extendedOptions;
  const unavailable: [string, boolean, string][] = [
    [
      "sss-copilot",
      !advanced?.sssCopilot?.filename,
      "保全派驻缺少本地作业 JSON，请先配置高级参数",
    ],
    [
      "paradox-copilot",
      !advanced?.paradoxCopilot?.filename &&
        !advanced?.paradoxCopilot?.list?.length,
      "悖论模拟缺少本地作业 JSON 或列表，请先配置高级参数",
    ],
    [
      "switch-theme",
      !advanced?.switchTheme?.themes?.length,
      "切换主题缺少候选主题，请先配置高级参数",
    ],
    [
      "video-recognition",
      !advanced?.videoRecognition?.filename,
      "录屏识别缺少本地视频文件，请先配置高级参数",
    ],
    [
      "activity-game",
      !advanced?.customActivity?.route,
      "活动小游戏缺少官方活动路线，请先同步并选择活动",
    ],
    [
      "operator-progress",
      advanced?.operProgress?.allowMaterialConsumption !== true ||
        !advanced?.operProgress?.plans?.length,
      "干员养成需要配置目标并明确允许消耗材料",
    ],
  ];
  for (const [id, missing, message] of unavailable)
    if (missing && skillIds.includes(id))
      throw new ArknightsCapabilityError(message);
  if (!skillIds.includes("award")) return;
  for (const option of Object.values(
    contract.awardOptions,
  ) as AwardCapability[]) {
    if (
      option.configKey &&
      !option.supported &&
      config[option.configKey as AwardConfigKey]
    )
      throw new ArknightsCapabilityError(
        arknightsAwardCapability(option.configKey as AwardConfigKey).reason,
      );
  }
}
