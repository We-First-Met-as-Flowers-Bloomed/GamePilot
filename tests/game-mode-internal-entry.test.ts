import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
it.each(["game-mode/run.mjs", "live/run.mjs", "live-ark/run.mjs"])(
  "%s cannot construct a native routine engine",
  (file) => {
    const source = readFileSync(
      new URL(`../scripts/${file}`, import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /new (MaaEngine|OnmyojiDaily|MaaCoreClient)|createArknightsWorkerAdapter\(/,
    );
  },
);
it("refuses external per-step overrides before contacting App or devices", async () => {
  const m = await import("../scripts/game-mode.mjs");
  expect(m.runGameMode).toBeTypeOf("function");
  const request = vi.fn();
  await expect(m.runGameMode(["--only", "mail"], { request })).rejects.toThrow(
    /参数|App/,
  );
  expect(request).not.toHaveBeenCalled();
});
it("waits for a same-device App receipt before submitting the next saved game while allowing other devices", async () => {
  const { runGameMode } = await import("../scripts/game-mode.mjs");
  const active = new Set<number>();
  let maximum = 0;
  const lanes = [
    {
      id: "ark-a",
      managerPath: "D:/MuMu/Manager.exe",
      instance: 0,
      arknights: { enabled: true },
    },
    {
      id: "yys-a",
      managerPath: "d:\\mumu\\Manager.exe",
      instance: 0,
      onmyoji: { enabled: true },
    },
    {
      id: "yys-b",
      managerPath: "D:/MuMu/Manager.exe",
      instance: 3,
      onmyoji: { enabled: true },
    },
  ];
  const code = await runGameMode([], {
    read: () => JSON.stringify({ lanes }),
    run: async (_data, laneId) => {
      const instance = lanes.find((lane) => lane.id === laneId)!.instance;
      if (active.has(instance)) throw Error("App device busy");
      active.add(instance);
      maximum = Math.max(maximum, active.size);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active.delete(instance);
      return { batchId: laneId, status: "succeeded" };
    },
    write: () => {},
    mkdir: () => {},
    log: () => {},
  });
  expect(code).toBe(0);
  expect(maximum).toBe(2);
});
