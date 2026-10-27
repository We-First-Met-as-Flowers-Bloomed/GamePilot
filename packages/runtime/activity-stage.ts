/**
 * 活动关卡解析（2026-10-22 · P1-2 基础）
 *
 * 背景：方舟活动一换，写死的关卡（如 YW-8）就失效 → 理智作战失败或"跑完但跑错"。
 * 本模块只做**纯解析 + 带缓存的一次解析**，不决定是否覆盖用户配置：
 * 覆盖策略需要产品开关（跟随活动 / 固定关卡），由上层决定，避免擅自改用户意图。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export type ArknightsClientType = "Official" | "Bilibili";

export interface ActivityStage {
  readonly stage: string;
  readonly name: string;
}

/**
 * 从 `maa activity <client>` 的输出里取第一个活动关卡。
 * 实测输出形如：
 *   Opening side story stages:
 *   - SideStory「昨日海」
 *     - YW-8: 液化高能气体
 *     - YW-7: 转质盐组
 */
export function parseActivityStage(output: string): ActivityStage | null {
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const match = /^\s*-\s*([A-Za-z][A-Za-z0-9]{0,5}-\d{1,2})\s*:\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const stage = match[1];
    const name = match[2];
    if (!stage || !name) continue;
    return { stage, name };
  }
  return null;
}

export interface ActivityStagePorts {
  /** maa-cli 可执行文件路径。 */
  readonly maaCliPath: string;
  /** 执行命令并返回 stdout（便于测试注入）。 */
  readonly run?: (file: string, args: string[]) => Promise<string>;
  /** 时钟（测试注入）。 */
  readonly now?: () => number;
  /** 缓存有效期，默认 10 分钟。 */
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
}

export class ActivityStageResolver {
  private cache = new Map<ArknightsClientType, { at: number; value: ActivityStage | null }>();
  private readonly run: (file: string, args: string[]) => Promise<string>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly ports: ActivityStagePorts) {
    this.run =
      ports.run ??
      (async (file, args) => {
        const { stdout } = await execute(file, args, {
          encoding: "utf8",
          windowsHide: true,
          timeout: ports.timeoutMs ?? 20_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        return stdout;
      });
    this.now = ports.now ?? (() => Date.now());
    this.ttlMs = ports.ttlMs ?? 10 * 60_000;
    this.timeoutMs = ports.timeoutMs ?? 20_000;
  }

  /** 解析当前活动关卡；解析不到返回 null（调用方应回退到用户配置，而不是猜一个关卡）。 */
  async resolve(clientType: ArknightsClientType): Promise<ActivityStage | null> {
    void this.timeoutMs;
    const cached = this.cache.get(clientType);
    if (cached && this.now() - cached.at < this.ttlMs) return cached.value;
    let value: ActivityStage | null = null;
    try {
      const output = await this.run(this.ports.maaCliPath, ["activity", clientType]);
      value = parseActivityStage(output);
    } catch {
      value = null;
    }
    this.cache.set(clientType, { at: this.now(), value });
    return value;
  }

  invalidate(): void {
    this.cache.clear();
  }
}
