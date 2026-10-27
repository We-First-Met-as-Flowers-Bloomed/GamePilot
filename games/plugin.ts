import {
  validatePlan,
  type DeviceLane,
  type Game,
  type Plan,
  type SkillResult,
} from "../packages/protocol";
import type {
  CompiledGameDraft,
  GameDraftInput,
} from "../packages/protocol/agent";
import type {
  TaskRecord,
  TaskStepRecord,
} from "../packages/protocol/task-record";
import type {
  IncidentScreen,
  IncidentRecoveryAction,
} from "../packages/protocol/incident-agent";
import type { ArknightsProfile } from "./arknights/config";
import type { GoalSkillOutcome } from "./goal-outcome";
import type { builtinGameCapabilityDescriptors } from "./agent-skills";
import type { Routine } from "../packages/protocol/routine";
import type { Frame } from "../packages/runtime/device";

export interface GameLaneContract {
  planKey: string;
  actionKey: string;
  afterRunAction?: string;
  enabled(lane: DeviceLane): boolean;
  setEnabled(lane: DeviceLane, enabled: boolean): DeviceLane;
  savedRoutine(lane: DeviceLane): Routine | undefined;
  withRoutine(lane: DeviceLane, routine: Routine): DeviceLane;
  dailySlots: readonly ("primary" | "secondary")[];
  maintenancePlan?: Plan;
  compileDaily(
    lane: DeviceLane,
    profile: ArknightsProfile | undefined,
    now: Date,
  ): { plan: Plan; profile?: ArknightsProfile };
  freezeSelection(lane: DeviceLane, plan: Plan): DeviceLane;
  assertBinding(
    alias: DeviceLane,
    lane: DeviceLane,
    profile: ArknightsProfile | undefined,
    profileIndex: number,
  ): void;
}

export interface GameWorkerAdapter {
  validate(plan: Plan): void;
  run(
    skillId: string,
    signal: AbortSignal,
    log: (message: string, result?: SkillResult) => void,
    plan: Plan,
  ): Promise<void | SkillResult>;
  maxRunMinutes?: number;
}
export interface GameWorkerContext {
  adapters: Readonly<Record<string, GameWorkerAdapter>>;
}
/** Trusted source registrations only. Descriptions and skill bodies cannot create plugins. */
export interface GamePlugin {
  descriptor: Game;
  adapterId: string;
  order: number;
  dailySkills: readonly string[];
  lane?: GameLaneContract;
  capabilities(): ReturnType<typeof builtinGameCapabilityDescriptors>[number];
  compile(
    input: GameDraftInput,
    lane: DeviceLane,
    profile: ArknightsProfile | undefined,
    at: string,
  ): CompiledGameDraft;
  validate(plan: Plan, context: GameWorkerContext): void;
  run(
    skillId: string,
    context: GameWorkerContext,
    signal: AbortSignal,
    log: (message: string, result?: SkillResult) => void,
    plan: Plan,
  ): Promise<void | SkillResult>;
  gameDay(at: Date): string;
  outcome(
    step: TaskStepRecord,
    snapshot: Record<string, unknown>,
  ): GoalSkillOutcome;
  recovery: {
    classify(frame: Frame): IncidentScreen;
    replayBlockers(task: TaskRecord): string[];
    retainedStep(step: TaskStepRecord): boolean;
    allowRetry(
      task: TaskRecord,
      page: IncidentScreen,
      attempts: number,
    ): boolean;
    propose(
      task: TaskRecord,
      page: IncidentScreen,
      attempts: number,
    ): IncidentRecoveryAction | undefined;
  };
}

export function registeredWorkerAdapter(
  plugin: GamePlugin,
  context: GameWorkerContext,
): GameWorkerAdapter {
  const adapter = Object.hasOwn(context.adapters, plugin.adapterId)
    ? context.adapters[plugin.adapterId]
    : undefined;
  if (!adapter) throw Error("游戏执行适配器未注册");
  return adapter;
}
export function validatePluginPlan(
  this: GamePlugin,
  plan: Plan,
  context: GameWorkerContext,
) {
  validatePlan(plan, [this.descriptor]);
  registeredWorkerAdapter(this, context).validate(plan);
}
export function runPluginSkill(
  this: GamePlugin,
  skillId: string,
  context: GameWorkerContext,
  signal: AbortSignal,
  log: (message: string, result?: SkillResult) => void,
  plan: Plan,
) {
  if (!plan.skillIds.includes(skillId)) throw Error("技能不在冻结计划中");
  return registeredWorkerAdapter(this, context).run(skillId, signal, log, plan);
}

export function createTrustedGameRegistry(plugins: readonly GamePlugin[]) {
  const byId = new Map<string, GamePlugin>();
  const orders = new Set<number>();
  for (const plugin of plugins) {
    if (
      !Number.isSafeInteger(plugin.order) ||
      plugin.order < 0 ||
      plugin.order > 1000 ||
      orders.has(plugin.order)
    )
      throw Error("游戏插件顺序无效或重复");
    orders.add(plugin.order);
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(plugin.descriptor.id) ||
      byId.has(plugin.descriptor.id)
    )
      throw Error("游戏插件编号无效或重复");
    if (
      plugin.dailySkills.some(
        (id) => !plugin.descriptor.skills.some((skill) => skill.id === id),
      )
    )
      throw Error("游戏日常技能未注册");
    byId.set(plugin.descriptor.id, Object.freeze(plugin));
  }
  const get = (id: string): GamePlugin => {
    const plugin = byId.get(id);
    if (!plugin) throw Error("游戏插件未注册：" + id);
    return plugin;
  };
  return Object.freeze({
    get,
    list: () => [...byId.values()],
    descriptors: () =>
      [...byId.values()].map((plugin) => structuredClone(plugin.descriptor)),
    capabilities: () =>
      [...byId.values()].map((plugin) =>
        structuredClone(plugin.capabilities()),
      ),
    validate(plan: Plan, context: GameWorkerContext) {
      get(plan.gameId).validate(plan, context);
    },
    run(
      plan: Plan,
      skillId: string,
      context: GameWorkerContext,
      signal: AbortSignal,
      log: (message: string, result?: SkillResult) => void,
    ) {
      return get(plan.gameId).run(skillId, context, signal, log, plan);
    },
  });
}
export type TrustedGameRegistry = ReturnType<typeof createTrustedGameRegistry>;
