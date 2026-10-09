import type { DeviceLane, Plan } from "../packages/protocol";
import type { GoalScope } from "../packages/protocol/agent-goal";
import { AgentToolError } from "../packages/protocol/agent";
import { gameMessageAuthority } from "../packages/agent/game-message-authority";
import type { ArknightsProfile, ArknightsProfiles } from "./arknights/config";
import {
  agentMessageSkillSelection,
  assertAgentExecutionAccounts,
  gamePreferencePrompt,
} from "./agent-message-scope";

/** A resume authorizes the original remainder, never a newly composed daily. */
export function assertAgentContinuationMessageScope(
  prompt: string,
  scopes: GoalScope[],
  snapshots: {
    lane: DeviceLane;
    profile?: ArknightsProfile;
    arknightsPlan?: Plan;
    onmyojiPlan?: Plan;
  }[],
  lanes: DeviceLane[],
  profiles: ArknightsProfiles,
) {
  if (!gameMessageAuthority(prompt).resume)
    throw new AgentToolError(
      "MESSAGE_NOT_AUTHORIZED",
      "当前消息没有明确要求继续原日常",
    );
  const reject = () => {
    throw new AgentToolError(
      "DAILY_CONTINUATION_SCOPE",
      "继续只能执行所选账号原日常的剩余范围；不能更换账号、游戏、任务或消费条件。",
    );
  };
  prompt = gamePreferencePrompt(prompt);
  if (
    /(?:改成|换成|更换|切换|修改|调整).{0,16}(?:账号|账户|游戏|任务|计划)|(?:账号|账户|任务|计划).{0,16}(?:改成|换成|修改|调整)/.test(
      prompt,
    )
  )
    reject();
  assertAgentExecutionAccounts(
    prompt,
    [...new Set(scopes.map((s) => s.laneId))],
    lanes,
    profiles,
  );
  // Normalize only restriction wording, after checking the real account names.
  // This can narrow the original remainder; it never grants a new action.
  const restrictions = prompt
    .replace(
      /不需要|不准|不许|不得|不允许|不必|无须|无需|不用|不可|不能|不应|禁止|暂不|先不|切勿|勿/g,
      "不要",
    )
    .replace(
      /不要(?:再|重新|再次|重复)(?=做|领|收|运行|执行|启动|完成|继续)/g,
      "不要",
    )
    .replace(/不要(?:继续|重试|续跑)/g, "不要执行")
    .replace(/不要(?=\s*(?:[，,。；;\n]|$))/g, "不要做");
  const required = new Set<string>(
      /双游戏|两个游戏/.test(prompt) ? ["arknights", "onmyoji"] : [],
    ),
    denied = new Set<string>();
  for (const match of restrictions.matchAll(/明日方舟|阴阳师/g)) {
    const id = match[0] === "明日方舟" ? "arknights" : "onmyoji";
    const prefix =
      restrictions
        .slice(0, match.index)
        .split(/[，,。；;\n]/)
        .at(-1) ?? "";
    const suffix = restrictions.slice(match.index! + match[0].length);
    if (
      /(?:不要|禁止|跳过|取消|先不|暂不|不运行|不执行|不启动|不切换|不跑|不做|别做).{0,6}$/.test(
        prefix,
      ) ||
      /^(?:日常)?(?:先|暂时)?(?:不要|不用|不|别)(?:运行|执行|跑|做|继续)/.test(
        suffix,
      )
    )
      denied.add(id);
    else required.add(id);
  }
  denied.forEach((id) => required.delete(id));
  const games = [...new Set(scopes.map((s) => s.gameId))];
  if (
    !scopes.length ||
    games.some((id) => denied.has(id)) ||
    (required.size &&
      (games.some((id) => !required.has(id)) ||
        [...required].some((id) => !games.includes(id))))
  )
    reject();
  for (const scope of scopes) {
    const snapshot = snapshots.find((s) => s.lane.id === scope.laneId),
      plan =
        scope.gameId === "arknights"
          ? snapshot?.arknightsPlan
          : snapshot?.onmyojiPlan;
    if (
      !plan ||
      plan.mode !== "live" ||
      JSON.stringify(plan.skillIds) !== JSON.stringify(scope.skillIds) ||
      Object.values(scope.resources).some((n) => n !== 0)
    )
      reject();
    const skills = agentMessageSkillSelection(restrictions, scope.gameId);
    if (
      skills.denied.some((id) => scope.skillIds.includes(id)) ||
      skills.requested.some((id) => !scope.skillIds.includes(id))
    )
      reject();
    const taskOnly =
      /(?:只|仅|单独)[^，。；;\n]{0,28}?(?:继续|重试|续跑|做|执行|领取)(?:(?!日常|每日任务|每日计划)[^，。；;\n]){0,12}(?:登录|核验|邮件|邮箱|基建|公招|信用|花合战|礼包|签到|麒麟|鬼王|作战|任务奖励)/.test(
        prompt,
      );
    if (
      skills.requested.length &&
      (!/日常|每日任务|每日计划/.test(prompt) || taskOnly) &&
      scope.skillIds.some(
        (id) => id !== "login" && !skills.requested.includes(id),
      )
    )
      reject();
    if (scope.gameId === "arknights") {
      const profile = snapshot?.profile;
      if (!profile) reject();
      if (
        gameMessageAuthority(restrictions).constraints.shopping === false &&
        scope.skillIds.includes("friends") &&
        profile!.creditShopping !== false
      )
        reject();
    }
  }
}
