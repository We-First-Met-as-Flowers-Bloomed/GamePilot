import type { GameDevice } from "../../packages/runtime/device";
import type { SkillResult } from "../../packages/protocol";
import { OnmyojiDaily } from "./daily";
import type { OnmyojiRuntimeConfig } from "../../packages/protocol/onmyoji-identity";
import {
  validateOnmyojiConfig,
  unconfiguredOnmyojiIdentityEvidence,
} from "../../packages/protocol/onmyoji-identity";
import { inspectOnmyojiIdentity, type OnmyojiIdentityPorts } from "./identity";

export interface OnmyojiExecutionIdentityContext {
  config: OnmyojiRuntimeConfig;
  connectedDevice: OnmyojiIdentityPorts["connectedDevice"];
  appProcessRunning?: OnmyojiIdentityPorts["appProcessRunning"];
  now?: OnmyojiIdentityPorts["now"];
  wait?: OnmyojiIdentityPorts["wait"];
}

type Handler = (
  daily: OnmyojiDaily,
  signal: AbortSignal,
) => Promise<void | SkillResult>;
export const onmyojiHandlers: Readonly<Record<string, Handler>> = Object.freeze(
  {
    login: (d, s) => d.login(s),
    "check-in": (d, s) => d.checkIn(s),
    mail: (d, s) => d.mail(s),
    "daily-gift": (d, s) => d.dailyGift(s),
    "guild-quest": (d, s) => d.guildQuest(s),
    foster: (d, s) => d.foster(s),
    "guild-kirin": (d, s) => d.guildKirin(s),
    "realm-raid": (d, s) => d.realmRaid(s),
    oboroguruma: (d, s) => d.oboroguruma(s),
    "hana-claim": (d, s) => d.hanaClaim(s),
  },
);

export async function executeOnmyojiSkill(
  id: string,
  device: GameDevice,
  signal: AbortSignal,
  log: (message: string, result?: SkillResult) => void,
  identityContext?: OnmyojiExecutionIdentityContext,
) {
  signal.throwIfAborted();
  const handler = Object.hasOwn(onmyojiHandlers, id)
    ? onmyojiHandlers[id]
    : undefined;
  if (!handler) throw Error("阴阳师技能未注册：" + id);
  const config = validateOnmyojiConfig(identityContext?.config ?? {});
  const evidence = config.identity
    ? await inspectOnmyojiIdentity({
        identity: config.identity,
        device,
        connectedDevice: identityContext!.connectedDevice,
        appProcessRunning:
          identityContext?.appProcessRunning ??
          (async () => {
            throw Error("observation-failed");
          }),
        now: identityContext?.now,
        wait: identityContext?.wait,
        signal,
      })
    : unconfiguredOnmyojiIdentityEvidence(identityContext?.now?.());
  log(
    config.identity
      ? "阴阳师角色身份实验性被动核对记录已保存"
      : "未配置阴阳师角色绑定，沿用旧流程；没有独立身份核验证明",
    { onmyojiIdentity: evidence },
  );
  // There is no certified production role-profile fixture. Candidate agreement
  // cannot authorize login, rewards, navigation or recovery.
  if (config.identity)
    throw Error(
      evidence.status === "mismatch"
        ? "阴阳师角色身份候选与冻结绑定冲突，已停止执行"
        : "阴阳师角色资料页锚点尚未实机认证，已阻止绑定账号业务执行",
    );
  const result = await handler(
    new OnmyojiDaily(device, (message, result) =>
      log(
        message,
        result ? { ...result, onmyojiIdentity: evidence } : undefined,
      ),
    ),
    signal,
  );
  return { ...(result ?? {}), onmyojiIdentity: evidence };
}
