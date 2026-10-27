import type { DeviceLane } from "../../../packages/protocol";

/** Resolve a configured lane once, before admission, preparation and logging. */
export function freezeLaneDevice(
  input: DeviceLane,
  gameIds: string[],
): DeviceLane {
  const instances = new Set(
    gameIds.map((gameId) => {
      const override =
        gameId === "arknights" || gameId === "onmyoji"
          ? input.deviceInstances?.[gameId]
          : undefined;
      return override ?? input.instance;
    }),
  );
  if (instances.size > 1)
    throw new Error("计划中的游戏指向不同 MuMu 实例，请分别按游戏执行");
  const lane = structuredClone(input);
  lane.instance = instances.values().next().value ?? input.instance;
  // An execution snapshot records a physical target, not a future routing rule.
  delete lane.deviceInstances;
  return lane;
}
