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

/** This is the verified bundled version, not a prediction about future engines. */
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
