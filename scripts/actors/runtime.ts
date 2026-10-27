/**
 * 账号级 Actor 运行时（P2，纯决策核心）。
 *
 * 一个 **actor = 一个（槽位 × 游戏）**，也就是"一个账号在一个游戏里的日常"。
 * 四个组合 = 四个 actor。每个 actor 有自己的：队列、状态、健康度；设备是共享资源，
 * 由**设备锁**保证同一台设备同一时刻只有一个 actor 开工（一台设备一次只能前台一个游戏，
 * 而且上一个引擎必须干净释放——见 lane-plan.ts 顶部注释）。
 *
 * 这一层只做**决策与记账**：谁现在可以跑、谁要等、谁该被跳过。真正的执行仍由
 * `scripts/game-mode/run.mjs`（受监督的实机执行器）或 App 的日常调度完成。
 *
 * 设计要点：
 *  - **排队而不是并行**：同一设备上多个 actor 就绪时，按优先级 + 等待时长排序，一次一个；
 *  - **错峰**：同一设备上连续两个 actor 之间留出间隔（默认 60 秒），避免两个游戏同时冷启动
 *    互相抢资源（2026-10-15 的登录竞态就是这么来的）；
 *  - **有界**：单个 actor 一天最多尝试 N 次；连续失败达到阈值就标记为不健康并停下等人核对；
 *  - **不越过安全边界**：`unknown`（结果未确认）永远不自动重跑；这条规则由调用方在计算
 *    `state` 时确定，这里只负责把它当成"必须人工核对"处理。
 */

export type ActorGame = "onmyoji" | "arknights";

export interface ActorInput {
  /** 槽位编号（设备），例如 lane-a。 */
  lane: string;
  laneName: string;
  game: ActorGame;
  /** 今天这一步的完成状态。 */
  state: "pending" | "failed" | "unknown" | "succeeded" | "skipped";
  /** 是否必做（可选步骤永远不排队）。 */
  required: boolean;
  /** 优先级：数值越小越先跑（默认 100）。 */
  priority?: number;
  /** 失败原因（有的话会进决策理由）。 */
  detail?: string;
}

export interface ActorPlan {
  actorId: string;
  lane: string;
  laneName: string;
  game: ActorGame;
  /** 排队顺序（从 0 开始）。 */
  order: number;
  /** 什么时候可以开工（毫秒时间戳）；用于同一设备错峰。 */
  runAt: number;
  reason: string;
}

export interface ActorDecision {
  /** 现在就能开工的 actor（同一设备最多一个）。 */
  runnable: ActorPlan[];
  /** 需要排队的 actor（按顺序）。 */
  queued: ActorPlan[];
  /** 不会自动跑、需要人工核对的 actor。 */
  blocked: { actorId: string; reason: string }[];
}

export interface ActorRuntimeOptions {
  now: number;
  /** 同一设备上两个 actor 之间至少留多少毫秒。 */
  staggerMs?: number;
  /** 单个 actor 一天最多自动尝试几次。 */
  maxAttemptsPerDay?: number;
  /** 已尝试次数（actorId → 次数）。 */
  attempts?: Record<string, number>;
  /** 连续失败次数（actorId → 次数）；达到阈值就判为不健康。 */
  consecutiveFailures?: Record<string, number>;
  /** 连续失败到几次就停下等人核对。 */
  unhealthyAfter?: number;
}

export const DEFAULT_STAGGER_MS = 60_000;
export const DEFAULT_MAX_ATTEMPTS = 2;
export const DEFAULT_UNHEALTHY_AFTER = 3;

export interface ActorAttempt {
  id: string;
  lane: string;
  game: ActorGame;
  startedAt: string;
  finishedAt?: string;
  result:
    "running" | "succeeded" | "skipped" | "failed" | "unknown" | "cancelled";
}

export function deriveActorStats(
  lane: string,
  game: ActorGame,
  requests: {
    requestId: string;
    laneId?: string;
    startedAt?: string;
    games?: Record<string, { result?: string } | undefined>;
  }[],
  cliAttempts: ActorAttempt[],
): { attempts: number; consecutiveFailures: number; unresolved: boolean } {
  const entries = new Map<string, { startedAt: string; result: string }>();
  for (const request of requests) {
    const result = request.games?.[game]?.result;
    if (request.laneId === lane && result)
      entries.set(`app:${request.requestId}`, {
        startedAt: request.startedAt ?? "",
        result,
      });
  }
  for (const attempt of cliAttempts)
    if (attempt.lane === lane && attempt.game === game)
      entries.set(`cli:${attempt.id}`, attempt);
  let consecutiveFailures = 0;
  let unresolved = false;
  for (const entry of [...entries.values()].sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt),
  )) {
    if (["running", "unknown"].includes(entry.result)) unresolved = true;
    if (["succeeded", "skipped"].includes(entry.result))
      consecutiveFailures = 0;
    else consecutiveFailures++;
  }
  return { attempts: entries.size, consecutiveFailures, unresolved };
}

export function actorIdOf(lane: string, game: ActorGame): string {
  return `${lane}:${game}`;
}

/**
 * 排出"今天接下来该怎么跑"。
 *
 * 规则（按顺序判断）：
 *  1. 非必做、或已完成/刻意跳过 → 不进队列；
 *  2. `unknown` → **永不自动重跑**（结果未确认 = 可能已经动过游戏），列为待核对；
 *  3. 尝试次数用尽、或连续失败达到阈值 → 列为待核对（不健康）；
 *  4. 其余（pending/failed）进入队列；同一设备按「优先级 → 等待时长 → 游戏名」排序；
 *  5. 同一设备上第 k 个 actor 的 `runAt` 依次加 `staggerMs`，实现错峰。
 */
export function planActors(
  actors: ActorInput[],
  options: ActorRuntimeOptions,
): ActorDecision {
  const stagger = options.staggerMs ?? DEFAULT_STAGGER_MS;
  const maxAttempts = options.maxAttemptsPerDay ?? DEFAULT_MAX_ATTEMPTS;
  const unhealthyAfter = options.unhealthyAfter ?? DEFAULT_UNHEALTHY_AFTER;
  const attempts = options.attempts ?? {};
  const failures = options.consecutiveFailures ?? {};
  const blocked: ActorDecision["blocked"] = [];
  const candidates: ActorInput[] = [];
  for (const actor of actors) {
    const id = actorIdOf(actor.lane, actor.game);
    if (
      !actor.required ||
      actor.state === "succeeded" ||
      actor.state === "skipped"
    )
      continue;
    if (actor.state === "unknown") {
      blocked.push({
        actorId: id,
        reason: `结果未确认（${actor.detail ?? "unknown"}）；只能现场核对，不自动重跑`,
      });
      continue;
    }
    if ((attempts[id] ?? 0) >= maxAttempts) {
      blocked.push({
        actorId: id,
        reason: `今天已自动尝试 ${attempts[id]} 次，达到上限`,
      });
      continue;
    }
    if ((failures[id] ?? 0) >= unhealthyAfter) {
      blocked.push({
        actorId: id,
        reason: `连续失败 ${failures[id]} 次，已判为不健康，等人工核对`,
      });
      continue;
    }
    candidates.push(actor);
  }
  candidates.sort(
    (a, b) =>
      (a.priority ?? 100) - (b.priority ?? 100) ||
      a.game.localeCompare(b.game) ||
      a.lane.localeCompare(b.lane),
  );
  const queued: ActorPlan[] = [];
  const perLane = new Map<string, number>();
  for (const actor of candidates) {
    const index = perLane.get(actor.lane) ?? 0;
    perLane.set(actor.lane, index + 1);
    const actorId = actorIdOf(actor.lane, actor.game);
    queued.push({
      actorId,
      lane: actor.lane,
      laneName: actor.laneName,
      game: actor.game,
      order: queued.length,
      // 同一设备上第 0 个立刻跑，第 1 个等一个间隔，第 2 个等两个……
      runAt: options.now + index * stagger,
      reason:
        actor.state === "failed"
          ? `上次失败：${actor.detail ?? "原因未记录"}；按设备顺序重试`
          : "今天还没跑，按设备顺序开工",
    });
  }
  const runnable = queued.filter((plan) => plan.runAt <= options.now);
  return { runnable, queued, blocked };
}

export function renderActorDecision(decision: ActorDecision): string {
  const lines: string[] = [];
  const gameName = (game: ActorGame) =>
    game === "onmyoji" ? "阴阳师" : "明日方舟";
  if (!decision.queued.length && !decision.blocked.length)
    return "四个账号今天都没有待办。";
  if (decision.queued.length) {
    lines.push(
      `待跑 ${decision.queued.length} 个账号（同一设备错峰，一次一个）：`,
      "",
    );
    for (const plan of decision.queued) {
      const at = new Date(plan.runAt);
      const when =
        plan.runAt <= Date.now()
          ? "现在"
          : `${at.toLocaleTimeString("zh-CN", { hour12: false })}`;
      lines.push(
        `- ${plan.actorId}（${plan.laneName} · ${gameName(plan.game)}）：${when} —— ${plan.reason}`,
      );
    }
    lines.push("");
  }
  if (decision.blocked.length) {
    lines.push(`待核对 ${decision.blocked.length} 项（不自动跑）：`, "");
    for (const item of decision.blocked)
      lines.push(`- ${item.actorId}：${item.reason}`);
  }
  return lines.join("\n");
}
