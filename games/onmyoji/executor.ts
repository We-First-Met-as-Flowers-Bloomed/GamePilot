import type { GameDevice } from "../../packages/runtime/device";
import type { SkillResult } from "../../packages/protocol";
import { OnmyojiDaily } from "./daily";

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
    "hana-claim": (d, s) => d.hanaClaim(s),
  },
);

export async function executeOnmyojiSkill(
  id: string,
  device: GameDevice,
  signal: AbortSignal,
  log: (message: string, result?: SkillResult) => void,
) {
  signal.throwIfAborted();
  const handler = Object.hasOwn(onmyojiHandlers, id)
    ? onmyojiHandlers[id]
    : undefined;
  if (!handler) throw Error("阴阳师技能未注册：" + id);
  return handler(new OnmyojiDaily(device, log), signal);
}
