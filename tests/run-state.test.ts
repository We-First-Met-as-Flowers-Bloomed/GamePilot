import { expect, it } from "vitest";
import {
  aggregateStatus,
  boundRunHistory,
} from "../packages/protocol/run-state";
import type { RunEvent } from "../packages/protocol";
it("pins daily results separately from later single requests", () => {
  const daily: RunEvent = {
    runId: "daily",
    batchId: "daily",
    laneId: "a",
    executionSource: "daily",
    type: "status",
    status: "succeeded",
    message: "daily",
    at: "2026-09-27T00:00:00Z",
  };
  const single: RunEvent = {
    ...daily,
    runId: "login",
    batchId: "login",
    executionSource: "single",
  };
  const logs: RunEvent[] = Array.from({ length: 15 }, (_, i) => ({
    ...single,
    type: "log",
    status: undefined,
    message: String(i),
  }));
  expect(boundRunHistory([daily, single, ...logs], 10)).toContainEqual(daily);
});
it("pins daily and maintenance results independently for each lane through repeated eviction", () => {
  const result = (
    laneId: string,
    maintenance: boolean,
    status: RunEvent["status"],
  ): RunEvent => ({
    laneId,
    runId: maintenance ? "maintenance" : "daily",
    batchId: maintenance ? "maintenance" : "daily",
    maintenance,
    type: "status",
    status,
    at: "2026-09-24T08:00:00+08:00",
    message: "result",
  });
  const dailyA = result("a", false, "succeeded");
  const dailyB = result("b", false, "failed");
  const maintenanceA = result("a", true, "succeeded");
  const activeB = result("b", true, "running");
  let history = [dailyA, dailyB, maintenanceA, activeB];
  for (let i = 0; i < 505; i++) {
    history = boundRunHistory([
      ...history,
      { ...activeB, status: undefined, type: "log", message: String(i) },
    ]);
    expect(history.length).toBeLessThanOrEqual(500);
  }
  expect(history.filter((event) => event.status)).toEqual([
    dailyA,
    dailyB,
    maintenanceA,
    activeB,
  ]);
  expect(aggregateStatus(history)).toBe("running");
});
it("preserves every lane status at every eviction, including pins displaced while making room for other pins", () => {
  let history: RunEvent[] = [
    {
      runId: "batch",
      batchId: "batch",
      laneId: "a",
      type: "status",
      status: "failed",
      message: "A failed",
      at: "",
    },
    {
      runId: "batch",
      batchId: "batch",
      laneId: "b",
      type: "status",
      status: "running",
      message: "B running",
      at: "",
    },
    {
      runId: "child-b",
      batchId: "batch",
      laneId: "b",
      type: "status",
      status: "running",
      message: "native running",
      at: "",
    },
  ];
  for (let i = 0; i < 60; i++) {
    history = boundRunHistory(
      [
        ...history,
        {
          runId: "child-b",
          batchId: "batch",
          laneId: "b",
          type: "log",
          message: String(i),
          at: "",
        },
      ],
      10,
    );
    expect(history.length).toBeLessThanOrEqual(10);
    expect(history.filter((e) => e.status)).toHaveLength(3);
    expect(aggregateStatus(history)).toBe("running");
  }
});
