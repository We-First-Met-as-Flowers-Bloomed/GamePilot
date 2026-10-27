import type { SkillResult } from "../../packages/protocol";
import {
  executeArknightsTask,
  type ArknightsExecutionOptions,
} from "./execution";

interface FightQueueOptions extends Omit<ArknightsExecutionOptions, "task"> {
  tasks: ArknightsExecutionOptions["task"][];
  now?: () => number;
}

/** v6.20.1 MedicineCounterTaskPlugin emits UseMedicine only after confirming consumption.
 * ProcessTask counters can restart in nested tasks. Count confirmations as well as
 * reported counters, and retire any budget whose consumption report is incomplete. */
class FightConsumption {
  medicine = 0;
  stone = 0;
  medicineConfirms = 0;
  medicineReports = 0;
  medicineStarts = 0;
  stoneStarts = 0;
  drops: Record<string, number> = {};
  private id?: number;
  private completed = false;
  accept(line: string) {
    const match = /^MAA (\d+): (.+)$/s.exec(line);
    if (!match) return;
    try {
      const code = Number(match[1]),
        value = JSON.parse(match[2]);
      if (
        value?.taskchain !== "Fight" ||
        !Number.isSafeInteger(value.taskid) ||
        value.taskid < 1
      )
        return;
      if (code === 10001) {
        this.id ??= value.taskid;
        return;
      }
      if (this.completed || value.taskid !== this.id) return;
      if (code === 10002) {
        this.completed = true;
        return;
      }
      const details = value.details;
      if (!details || typeof details !== "object") return;
      if (
        code === 20001 &&
        value.subtask === "ProcessTask" &&
        typeof details.task === "string" &&
        /(?:^|@)MedicineConfirm$/.test(details.task)
      )
        this.medicineStarts++;
      if (
        code === 20001 &&
        value.subtask === "ProcessTask" &&
        typeof details.task === "string" &&
        /(?:^|@)StoneConfirm$/.test(details.task)
      )
        this.stoneStarts++;
      if (
        code === 20002 &&
        value.subtask === "ProcessTask" &&
        Number.isSafeInteger(details.exec_times) &&
        details.exec_times > 0
      ) {
        if (
          typeof details.task === "string" &&
          /(?:^|@)StoneConfirm$/.test(details.task)
        )
          this.stone = Math.max(this.stone + 1, details.exec_times);
        if (
          typeof details.task === "string" &&
          /(?:^|@)MedicineConfirm$/.test(details.task)
        )
          this.medicineConfirms++;
      }
      if (
        code === 20003 &&
        value.what === "UseMedicine" &&
        Number.isSafeInteger(details.count) &&
        details.count > 0
      ) {
        this.medicine += details.count;
        this.medicineReports++;
      }
      if (
        code === 20003 &&
        value.what === "StageDrops" &&
        Array.isArray(details.stats)
      ) {
        for (const drop of details.stats)
          if (
            typeof drop?.itemId === "string" &&
            Number.isSafeInteger(drop.quantity) &&
            drop.quantity >= 0
          )
            this.drops[drop.itemId] = Math.max(
              this.drops[drop.itemId] ?? 0,
              drop.quantity,
            );
      }
    } catch {
      /* A malformed optional callback cannot increase the available budget. */
    }
  }
}

/** Each native Fight has its own counters. Carry the remaining App budget across tasks. */
export async function executeArknightsFightQueue(
  options: FightQueueOptions,
): Promise<SkillResult> {
  if (
    !options.tasks.length ||
    options.tasks.some((task) => task.type !== "Fight")
  )
    throw Error("作战关卡队列无效");
  const first = options.tasks[0].params;
  let medicine = Number(first.medicine ?? 0),
    stone = Number(first.stone ?? 0);
  const targets = { ...(first.drops as Record<string, number> | undefined) };
  const totals: Record<string, number> = {};
  const now = options.now ?? Date.now;
  const deadlineAt = now() + options.maxRunMinutes * 60_000;
  let result: SkillResult | undefined;
  let completed = 0,
    reachedTarget = false;
  for (const task of options.tasks) {
    options.signal.throwIfAborted();
    if (now() >= deadlineAt) throw Error("作战队列已达到共享运行时长上限");
    const consumption = new FightConsumption();
    const drops = Object.fromEntries(
      Object.entries(targets).map(([id, target]) => [
        id,
        Math.max(1, target - (totals[id] ?? 0)),
      ]),
    );
    options.log(
      `作战队列 ${completed + 1}/${options.tasks.length}：${task.params.stage}；剩余理智药 ${medicine}、源石 ${stone}`,
    );
    result = await executeArknightsTask({
      ...options,
      maxRunMinutes: Math.min(
        options.maxRunMinutes,
        (deadlineAt - now()) / 60_000,
      ),
      task: {
        type: "Fight",
        params: {
          ...task.params,
          medicine,
          stone,
          ...(Object.keys(targets).length ? { drops } : {}),
        },
      },
      log: (line) => {
        consumption.accept(line);
        options.log(line);
      },
    });
    completed++;
    if (result.arknights) options.publishEvidence?.(result.arknights);
    medicine =
      Math.max(consumption.medicineStarts, consumption.medicineConfirms) >
      consumption.medicineReports
        ? 0
        : Math.max(0, medicine - consumption.medicine);
    stone =
      consumption.stoneStarts > consumption.stone
        ? 0
        : Math.max(0, stone - consumption.stone);
    for (const [id, count] of Object.entries(consumption.drops))
      totals[id] = (totals[id] ?? 0) + count;
    reachedTarget = Object.entries(targets).some(
      ([id, target]) => (totals[id] ?? 0) >= target,
    );
    if (reachedTarget) break;
    if (Object.keys(targets).length && !Object.keys(consumption.drops).length) {
      throw Error(
        "本关未识别到累计掉落，无法安全延续新增掉落预算，已停止后续关卡。",
      );
    }
  }
  return {
    ...result!,
    summary: `作战队列已完成 ${completed}/${options.tasks.length} 个原生任务链${reachedTarget ? "，已达到任一新增掉落目标" : ""}。${result!.summary} 队列汇总不推断未识别的作战次数。`,
  };
}
