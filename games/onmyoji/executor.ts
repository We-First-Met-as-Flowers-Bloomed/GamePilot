import type { GameDevice } from "../../packages/runtime/device";
import type { SkillResult } from "../../packages/protocol";
import { OnmyojiDaily } from "./daily";
import type { OnmyojiRuntimeConfig } from "../../packages/protocol/onmyoji-identity";
import {
  validateOnmyojiConfig,
  unconfiguredOnmyojiIdentityEvidence,
  validOnmyojiIdentityEvidence,
} from "../../packages/protocol/onmyoji-identity";
import { verifyOnmyojiProfile, type OnmyojiIdentityPorts } from "./identity";

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
  let evidence = unconfiguredOnmyojiIdentityEvidence(identityContext?.now?.());
  const daily = new OnmyojiDaily(
    device,
    (message, result) =>
      log(
        message,
        result ? { ...result, onmyojiIdentity: evidence } : undefined,
      ),
    identityContext?.wait,
    identityContext?.now ? () => new Date(identityContext.now!()) : undefined,
  );
  if (config.identity) {
    const verify = () =>
      verifyOnmyojiProfile({
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
      });
    // Inspect first, so an observed foreign profile can never be discarded by login/navigation.
    evidence = await verify();
    if (
      evidence.status === "unknown" &&
      (evidence.reason === "courtyard-anchor-missing" ||
        (id === "login" && evidence.reason === "package-not-running"))
    ) {
      log("尚未处于可核验的庭院；先准备登录或返回庭院，尚未允许业务执行", {
        onmyojiIdentity: evidence,
      });
      if (id === "login") await daily.login(signal);
      await daily.prepareIdentityCourtyard(signal);
      evidence = await verify();
    }
  }
  log(
    config.identity
      ? "阴阳师头像页 UID 核验及返回庭院记录已保存"
      : "未配置阴阳师角色绑定，沿用旧流程；没有独立身份核验证明",
    { onmyojiIdentity: evidence },
  );
  if (
    config.identity &&
    (evidence.status !== "matched" || !validOnmyojiIdentityEvidence(evidence))
  )
    throw Error(
      evidence.status === "mismatch"
        ? "阴阳师 UID 与绑定账号不符，已停止执行"
        : `阴阳师 UID 核验未通过（${evidence.reason}），已停止后续任务`,
    );
  if (config.identity && id === "login")
    return {
      status: "succeeded" as const,
      goalSatisfied: true,
      summary: "已核对头像设置页完整 UID，双帧一致且已返回庭院",
      evidenceTimestamp: evidence.observedAt,
      evidenceReference: "onmyoji:identity:profile-uid-v1",
      onmyojiIdentity: evidence,
    };
  const result = await handler(daily, signal);
  return { ...(result ?? {}), onmyojiIdentity: evidence };
}
