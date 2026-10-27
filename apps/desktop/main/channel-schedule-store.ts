import { join } from "node:path";
import type { DeviceLane } from "../../../packages/protocol";
import { channelGame } from "../../../packages/protocol/account-channel";
import { dailyLaneScope } from "./daily-policy";
import {
  ScheduleStore,
  IntervalScheduleStore,
  type ScheduleLedger,
  type IntervalLedger,
} from "./scheduler";

/** A predecessor's completion proves an attempt, never both successors' success. */
export function inheritDailyAttempts(
  current: ScheduleLedger,
  previous: ScheduleLedger,
  oldScope: string,
  newScope: string,
  secondary: boolean,
): ScheduleLedger {
  const inherited = new Map<string, number>();
  const mapKey = (key: string) => {
    const match = /^(\d{4}-\d{2}-\d{2})\|(.*)$/.exec(key);
    if (!match) return;
    if (match[2] === oldScope) return `${match[1]}|${newScope}`;
    if (secondary && match[2] === `${oldScope}|secondary`)
      return `${match[1]}|${newScope}|secondary`;
  };
  for (const key of previous.attempts ?? []) {
    const mapped = mapKey(key);
    if (mapped) inherited.set(mapped, (inherited.get(mapped) ?? 0) + 1);
  }
  for (const key of [
    previous.attemptDay,
    previous.completedDay,
    ...(previous.completions ?? []),
  ]) {
    const mapped = key && mapKey(key);
    if (mapped) inherited.set(mapped, Math.max(1, inherited.get(mapped) ?? 0));
  }
  if (!inherited.size) return current;
  const counts = new Map<string, number>();
  for (const key of current.attempts ?? [])
    counts.set(key, (counts.get(key) ?? 0) + 1);
  if (current.attemptDay)
    counts.set(
      current.attemptDay,
      Math.max(1, counts.get(current.attemptDay) ?? 0),
    );
  for (const [key, count] of inherited)
    counts.set(key, Math.max(count, counts.get(key) ?? 0));
  const ordered = [...counts].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return {
    ...current,
    attempts: ordered
      .flatMap(([key, count]) => Array<string>(count).fill(key))
      .slice(-100),
    lastStatus: current.lastStatus ?? "unknown",
  };
}

export function inheritFosterTiming(
  current: IntervalLedger,
  previous: IntervalLedger,
  oldScope: string,
  newScope: string,
): IntervalLedger {
  if (Object.keys(current).length || previous.scope !== oldScope)
    return current;
  return { ...previous, scope: newScope };
}

/** New ledgers are separate; predecessor files are only ever read. */
export function createChannelDailyScheduleStore(
  dataDir: string,
  lane: DeviceLane,
) {
  const current = new ScheduleStore(
    join(dataDir, "channels", lane.id, "daily-scheduler.json"),
  );
  const binding = lane.legacyBinding;
  const previous =
    binding &&
    new ScheduleStore(
      join(dataDir, "lanes", binding.laneId, "daily-scheduler.json"),
    );
  return {
    async read() {
      const value = await current.read();
      return previous && binding
        ? inheritDailyAttempts(
            value,
            await previous.read(),
            binding.scope,
            dailyLaneScope(lane),
            channelGame(lane) === "arknights",
          )
        : value;
    },
    save: (value: ScheduleLedger) => current.save(value),
  };
}

export function createChannelFosterScheduleStore(
  dataDir: string,
  lane: DeviceLane,
) {
  const current = new IntervalScheduleStore(
    join(dataDir, "channels", lane.id, "foster-scheduler.json"),
  );
  const binding =
    channelGame(lane) === "onmyoji" ? lane.legacyBinding : undefined;
  const previous =
    binding &&
    new IntervalScheduleStore(
      join(dataDir, "lanes", binding.laneId, "foster-scheduler.json"),
    );
  return {
    async read() {
      const value = await current.read();
      return previous && binding
        ? inheritFosterTiming(
            value,
            await previous.read(),
            binding.scope,
            dailyLaneScope(lane),
          )
        : value;
    },
    save: (value: IntervalLedger) => current.save(value),
  };
}
