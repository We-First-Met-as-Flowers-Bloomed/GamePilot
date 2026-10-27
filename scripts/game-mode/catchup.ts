/**
 * 「补齐今天所有欠账」的计划（纯函数）。
 *
 * 监督回合最常做的一件事就是：看今日状态 → 对有欠账的组合定点补跑。
 * 以前要人肉把缺的技能拼成 `--only a,b,c`，容易漏、也容易把可选步骤一起跑掉。
 * 这里只回答一个问题：**哪些（槽位 × 游戏）还欠哪些必做步骤**。
 *
 * 判定口径与 `game-status` 一致：
 *  - 只看 required（可选步骤永远不算欠账）；
 *  - `skipped` 是刻意的结果（例如胧车今天没开放、集体任务暂无可领取），**不算欠账**；
 *  - 未知结果只能核对，不得自动补跑；pending/failed 才列为补跑候选。
 */
import type { LaneGameStatus } from "./status";
import type { GameId } from "./plans";

export interface CatchupCombo {
  lane: string;
  laneName: string;
  game: GameId;
  skills: string[];
  labels: string[];
}

export interface CatchupExecution extends CatchupCombo {
  code: number;
  blocked?: boolean;
  message?: string;
}

/** Preserve each device's predecessor even when another device runs in between. */
export async function executeCatchupQueue(
  combos: CatchupCombo[],
  ports: {
    resourceKey?(combo: CatchupCombo): string;
    run(combo: CatchupCombo): Promise<number>;
    recover(previous: CatchupExecution, next: CatchupCombo): Promise<void>;
  },
): Promise<CatchupExecution[]> {
  const previous = new Map<string, CatchupExecution>();
  const blockedResources = new Map<string, string>();
  const results: CatchupExecution[] = [];
  for (const combo of combos) {
    const resource = ports.resourceKey?.(combo) ?? combo.lane;
    const prior = previous.get(resource);
    let result: CatchupExecution;
    try {
      if (blockedResources.has(resource))
        throw Error(blockedResources.get(resource));
      if (prior?.code && prior.game !== combo.game)
        await ports.recover(prior, combo);
      result = { ...combo, code: await ports.run(combo) };
    } catch (error) {
      result = {
        ...combo,
        code: 1,
        blocked: true,
        message: error instanceof Error ? error.message : String(error),
      };
      blockedResources.set(resource, result.message!);
    }
    // A failed handover must not be replaced by a never-started game's result.
    if (!result.blocked) previous.set(resource, result);
    results.push(result);
  }
  return results;
}

export function planCatchup(statuses: LaneGameStatus[]): CatchupCombo[] {
  const combos: CatchupCombo[] = [];
  for (const status of statuses) {
    if (status.catchupBlocked) continue;
    const owed = status.items.filter(
      (item) =>
        item.required && (item.state === "pending" || item.state === "failed"),
    );
    if (!owed.length) continue;
    combos.push({
      lane: status.lane,
      laneName: status.laneName,
      game: status.game,
      skills: owed.map((item) => item.skill),
      labels: owed.map((item) => item.label),
    });
  }
  return combos;
}

/** 一条组合一条补跑命令；空计划说明今天没有欠账。 */
export function renderCatchup(
  combos: CatchupCombo[],
  statuses: LaneGameStatus[] = [],
): string {
  const unknown = statuses.flatMap((status) =>
    status.items
      .filter((item) => item.required && item.state === "unknown")
      .map((item) => `${status.laneName}/${item.label}`),
  );
  const blocked = statuses.some((status) => status.catchupBlocked);
  if (!combos.length)
    return unknown.length
      ? `待核对 ${unknown.length} 项，不自动补跑：${unknown.join("、")}。结果未确认，不能认定全部完成。`
      : blocked
        ? "相关设备存在未知/活动请求或证据读取问题，仅核对，不自动补跑。"
        : "今天没有欠账：必做步骤要么已完成、要么是刻意的跳过。";
  const lines = [`今天还欠 ${combos.length} 个组合，补跑顺序如下：`, ""];
  for (const combo of combos) {
    const gameName = combo.game === "onmyoji" ? "阴阳师" : "明日方舟";
    lines.push(
      `- ${combo.laneName}（${combo.lane}）· ${gameName}：${combo.labels.join("、")}`,
    );
    if (combo.game === "arknights")
      lines.push(
        "  node scripts/arknights-app.mjs --due",
        "  由 App 按保存的时间、星期和账本选择到期计划；此处不提交临时步骤子集。",
      );
    else
      lines.push(
        "  node scripts/onmyoji-app.mjs --due",
        "  由App选择到期计划；剩余步骤请在任务详情核对后续跑。",
      );
  }
  if (unknown.length)
    lines.push(
      "",
      `另有待核对 ${unknown.length} 项，不自动补跑：${unknown.join("、")}`,
    );
  if (blocked)
    lines.push("", "存在未知/活动请求或读取问题的设备已排除，不自动补跑。");
  return lines.join("\n");
}
