import {
  agentMessageAccountSelection,
  gamePreferencePrompt,
} from "./agent-message-scope";
import { historyGameDay } from "./agent-history";
import type { Routine } from "../packages/protocol/routine";
import { compileDailyPlan } from "./routines";

interface QueryGame {
  enabled: boolean;
  clientType?: string;
  defaultSkillIds?: string[];
  routine?: Routine | null;
}
export interface DailyQueryEnvironment {
  source: string;
  historyAvailable: boolean;
  lanes: {
    id: string;
    enabled: boolean;
    games: { arknights: QueryGame; onmyoji: QueryGame };
    recordedRequests: {
      id: string;
      requestSource: string;
      startedAt?: string;
      progress: {
        tasks: {
          gameId: string;
          gameDay?: string;
          mode: string;
          steps: { skillId: string; status: string }[];
        }[];
      };
    }[];
  }[];
}
export interface DailyQueryScope {
  laneId: string;
  account: string;
  gameId: "arknights" | "onmyoji";
  gameDay: string;
  skillIds: string[];
  requestIds: string[];
}

/** Select read-only ledger evidence from this message; never a plan or execution grant. */
export function recordedDailyQueryScopes(
  prompt: string,
  environment: DailyQueryEnvironment,
  at: string,
): DailyQueryScope[] | undefined {
  const text = gamePreferencePrompt(prompt);
  if (
    environment.source !== "recorded" ||
    !/今天|今日/.test(text) ||
    !/日常|每日任务/.test(text) ||
    /goal-[a-z0-9-]+|昨天|昨日|前天|上次|上周/.test(text)
  )
    return undefined;
  const games = [
    ["arknights", "明日方舟"],
    ["onmyoji", "阴阳师"],
  ] as const;
  const named = games.filter(([, name]) => text.includes(name));
  const selectedGames = (named.length ? named : games).filter(([, name]) => {
    const denied = new RegExp(
      `(?:不用|不要|不必|不需要|无需|无须|先不|不|别)(?:再)?(?:查看|查询|查|看|核对|运行)${name}|${name}(?:也)?(?:先|暂时)?(?:不用|不要|不必|不需要|无需|无须|不|别)(?:再)?(?:查看|查询|查|看|核对|运行|跑)`,
    );
    return !denied.test(text.replace(/\s/g, ""));
  });
  // Reuse account identity parsing while keeping query-only exclusions local.
  const accountText = text
    .replace(
      /(?:不用|不要|不必|不需要|无需|无须|先不|不|别)(?:再)?(?:查看|查询|查|看|核对)\s*((?:账号|账户|槽位)\s*[零〇一二两三四五六七八九十\d]+|[零〇一二两三四五六七八九十\d]+号|lane-[a-h])/g,
      "不要$1",
    )
    .replace(
      /((?:账号|账户|槽位)\s*[零〇一二两三四五六七八九十\d]+|[零〇一二两三四五六七八九十\d]+号|lane-[a-h])\s*(?:也)?(?:先|暂时)?(?:不用|不要|不必|不需要|无需|无须|不|别)(?:再)?(?:查看|查询|查|看|核对)/g,
      "不要$1",
    );
  const selection = agentMessageAccountSelection(
    accountText,
    environment.lanes.map((lane) => ({ id: lane.id, name: lane.id })),
  );
  const scopes: DailyQueryScope[] = [];
  for (const [index, lane] of environment.lanes.entries()) {
    if (
      !lane.enabled ||
      selection.denied.has(index) ||
      (selection.hasAccountWords && !selection.explicit.includes(index)) ||
      (selection.client && lane.games.arknights.clientType !== selection.client)
    )
      continue;
    for (const [gameId] of selectedGames) {
      const gameDay = historyGameDay(gameId, at);
      if (!gameDay) continue;
      const config = lane.games[gameId];
      const skillIds =
        config.routine || config.defaultSkillIds?.length
          ? compileDailyPlan(
              gameId,
              config.routine ?? undefined,
              config.defaultSkillIds,
              new Date(at),
            ).skillIds
          : [];
      const records = lane.recordedRequests;
      const current = records.filter((record) =>
        record.progress.tasks.some(
          (task) =>
            task.gameId === gameId &&
            task.mode === "live" &&
            task.gameDay === gameDay,
        ),
      );
      const business = current.find((record) =>
        record.progress.tasks.some(
          (task) =>
            task.gameId === gameId &&
            task.steps.some((step) => step.skillId !== "login"),
        ),
      );
      const selected = business ?? current[0];
      // Only fall back to a missing task when no record for this game exists;
      // a newer request may intentionally cover only the other game.
      const missing = records.find(
        (record) =>
          record.requestSource === "daily" &&
          !!record.startedAt &&
          historyGameDay(gameId, record.startedAt) === gameDay &&
          !record.progress.tasks.some((task) => task.gameId === gameId),
      );
      const candidate = selected ?? missing;
      scopes.push({
        laneId: lane.id,
        account: `账号${"一二三四五六七八"[index] ?? index + 1}`,
        gameId,
        gameDay,
        skillIds,
        requestIds: candidate ? [candidate.id] : [],
      });
    }
  }
  return scopes;
}
