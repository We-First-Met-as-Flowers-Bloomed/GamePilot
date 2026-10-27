/**
 * 设备恢复（P1b，纯决策 + 可测）。
 *
 * 为什么需要它：`tests/lane-plan.test.ts` 里有两条硬性安全不变式——
 * 前一个游戏**失败**、或**退出未确认**时，绝不把设备交给另一个引擎。
 * 所以"方舟失败后阴阳师当天也跑不了"不是 bug，而是设备层的正确行为。
 *
 * 要在这个前提下让第二个游戏也能跑完，只有一条正路：**先把设备恢复干净**，再跑它。
 * 恢复动作按"代价从小到大"排序，每一步都要能验证结果：
 *
 *   1. `check`      — 设备还在不在（adb devices）
 *   2. `stop-game`  — 强制停掉上一款游戏（`am force-stop`），确保前台不再被它占着
 *   3. `restart`    — 设备不可达时用 MuMuManager 重启实例
 *   4. `verify`     — 再抓一帧确认能连上、且前台不是上一款游戏
 *
 * 决策本身是纯函数：给定"上一个游戏的结果"和"设备是否可达"，返回要执行的步骤序列。
 * 执行在 game-mode 侧（见 scripts/game-mode.mjs 的恢复调用），失败也不掩盖原失败原因。
 */

export type RecoveryStep =
  | { kind: "check" }
  | { kind: "stop-game"; packageName: string }
  | { kind: "restart"; instance: number }
  | { kind: "verify" };

export interface RecoveryInput {
  /** 刚刚失败的组合（同一个槽位上的上一款游戏）。 */
  previous?: {
    game: string;
    packageName: string;
    status: "succeeded" | "failed" | "skipped" | "blocked";
  };
  /** 接下来要跑的组合（同一槽位）。没有它就不需要恢复。 */
  next?: { game: string };
  /** 设备当前是否可达（adb devices）。 */
  reachable: boolean;
  /** 该槽位的 MuMu 实例号（不可达时用它重启）。 */
  instance: number;
  /** 重试次数（第一次恢复用 0）；超过上限就不再重启，避免反复折腾。 */
  attempt?: number;
}

/** 一次恢复最多重启实例的次数。 */
export const MAX_RESTART_ATTEMPTS = 1;

/**
 * 决定这次要不要恢复、按什么步骤恢复。
 *
 * - 没有"下一个组合"、或下一个组合不是同一台设备上的另一个游戏 → 不恢复；
 * - 上一个组合成功/跳过 → 设备本来就是干净的 → 不恢复；
 * - 上一个组合失败 → 先检查设备、再强制停掉那款游戏、再验证；
 * - 设备不可达 → 在停游戏之前先重启实例（重启后设备可达，才谈得上停游戏）。
 */
export function planRecovery(input: RecoveryInput): RecoveryStep[] {
  if (!input.next || !input.previous) return [];
  if (input.previous.status !== "failed") return [];
  if (input.previous.game === input.next.game) return [];
  const steps: RecoveryStep[] = [{ kind: "check" }];
  if (!input.reachable) {
    if ((input.attempt ?? 0) >= MAX_RESTART_ATTEMPTS) return [];
    steps.push({ kind: "restart", instance: input.instance });
  }
  steps.push({ kind: "stop-game", packageName: input.previous.packageName });
  steps.push({ kind: "verify" });
  return steps;
}

export function renderRecovery(steps: RecoveryStep[]): string {
  if (!steps.length) return "不需要设备恢复。";
  const label = (step: RecoveryStep) => {
    if (step.kind === "check") return "检查设备是否可达";
    if (step.kind === "restart") return `重启实例 ${step.instance}`;
    if (step.kind === "stop-game") return `强制停掉 ${step.packageName}`;
    return "抓帧验证设备已恢复干净";
  };
  return `设备恢复：${steps.map(label).join(" → ")}`;
}

/** `adb devices` lists every serial even when invoked with -s. */
export function deviceIsReachable(output: string, address: string): boolean {
  return output.split(/\r?\n/).some((line) => {
    const [serial, state] = line.trim().split(/\s+/);
    return serial === address && state === "device";
  });
}

export interface DeviceRecoveryPorts {
  reachable(): Promise<boolean>;
  restart(instance: number): Promise<void>;
  installedPackage(prefix: string): Promise<string | undefined>;
  stopGame(packageName: string): Promise<void>;
  running(packageName: string): Promise<boolean>;
  foreground(): Promise<string | undefined>;
}

/** A failed verification is a barrier, never a best-effort log message. */
export async function executeDeviceRecovery(
  steps: RecoveryStep[],
  ports: DeviceRecoveryPorts,
): Promise<void> {
  let stoppedPackage: string | undefined;
  for (const step of steps) {
    if (step.kind === "check") {
      if (
        !(await ports.reachable()) &&
        !steps.some((item) => item.kind === "restart")
      )
        throw Error("目标设备不可达，停止交接");
    } else if (step.kind === "restart") {
      await ports.restart(step.instance);
      if (!(await ports.reachable())) throw Error("重启后目标设备仍不可达");
    } else if (step.kind === "stop-game") {
      stoppedPackage = await ports.installedPackage(step.packageName);
      if (!stoppedPackage) throw Error("未找到唯一的前序游戏包，不能核对退出");
      await ports.stopGame(stoppedPackage);
      if (await ports.running(stoppedPackage))
        throw Error("前序游戏进程仍在运行，停止交接");
    } else {
      if (!stoppedPackage || !(await ports.reachable()))
        throw Error("未确认目标设备恢复，停止交接");
      if (await ports.running(stoppedPackage))
        throw Error("前序游戏进程仍在运行，停止交接");
      const foreground = await ports.foreground();
      if (!foreground || foreground === stoppedPackage)
        throw Error("前序游戏退出或前台归属未确认，停止交接");
    }
  }
}
