import { expect, it } from "vitest";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import type { DeviceLane } from "../packages/protocol";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { TaskRecord } from "../packages/protocol/task-record";
import { dailyLaneScope } from "../apps/desktop/main/daily-policy";
import { mumuResource } from "../apps/desktop/main/execution-coordinator";
import { releaseMaintenancePauses } from "../apps/desktop/main/maintenance-resume";
import {
  IntervalScheduler,
  type IntervalLedger,
} from "../apps/desktop/main/scheduler";

const at = "2026-09-28T03:09:55.000Z";
const lanes = () => createFixtureSnapshot().lanes!.lanes;

function receipt(lane: DeviceLane): ExecutionRecord {
  return {
    version: 1,
    id: `maintenance:${lane.id}`,
    fingerprint: "fixture",
    source: "maintenance",
    resources: [mumuResource(lane.managerPath, lane.instance)],
    laneId: lane.id,
    snapshot: {},
    status: "unknown",
    startedAt: at,
    finishedAt: at,
    message: "执行中断，结果未知",
  };
}

function fosterTask(lane: DeviceLane): TaskRecord {
  return {
    version: 1,
    executionId: receipt(lane).id,
    runId: `foster:${lane.id}`,
    laneId: lane.id,
    gameId: "onmyoji",
    plan: { gameId: "onmyoji", mode: "live", skillIds: ["foster"] },
    startedAt: at,
    updatedAt: at,
    finishedAt: at,
    status: "unknown",
    message: "执行中断，结果未知",
    steps: [
      {
        skillId: "foster",
        status: "unknown",
        startedAt: at,
        finishedAt: at,
        message: "",
        diagnostics: [],
      },
    ],
  };
}

function harness(currentLanes = lanes()) {
  const stored = new Map<string, IntervalLedger>(
    currentLanes.map((lane) => [
      lane.id,
      {
        scope: dailyLaneScope(lane),
        blockedAt: at,
        lastStatus: "unknown",
        lastAttemptAt: at,
      },
    ]),
  );
  let executions = 0;
  const schedulers = new Map(
    currentLanes.map((lane) => [
      lane.id,
      new IntervalScheduler(
        {
          read: async () => structuredClone(stored.get(lane.id)!),
          save: async (value) => {
            stored.set(lane.id, structuredClone(value));
          },
        },
        6 * 60 * 60_000,
        30 * 60_000,
        async () => {
          executions++;
          return "succeeded";
        },
      ),
    ]),
  );
  return {
    stored,
    get executions() {
      return executions;
    },
    getScheduler: async (lane: DeviceLane) => schedulers.get(lane.id)!,
  };
}

it("keeps unresolved foster paused and directs the operator to the existing task", async () => {
  const [lane] = lanes();
  const requests = [receipt(lane)];
  const tasks = [fosterTask(lane)];
  const before = JSON.stringify({ requests, tasks });
  const h = harness([lane]);
  const ledgerBefore = structuredClone(h.stored.get(lane.id));

  const result = await releaseMaintenancePauses({
    lanes: [lane],
    requests,
    tasks,
    getScheduler: h.getScheduler,
  });

  expect(result.released).toEqual([]);
  expect(result.blocked).toEqual([
    {
      laneName: lane.name,
      message: expect.stringMatching(/寄养.*未确认.*任务详情/),
    },
  ]);
  expect(JSON.stringify({ requests, tasks })).toBe(before);
  expect(h.stored.get(lane.id)).toEqual(ledgerBefore);
  await (
    await h.getScheduler(lane)
  ).tick(new Date("2026-10-06T00:00:00Z"), true, false, dailyLaneScope(lane));
  expect(h.executions).toBe(0);
});

it("keeps a receipt-only unknown maintenance paused when task details are missing", async () => {
  const [lane] = lanes();
  const request = receipt(lane);
  const before = JSON.stringify(request);
  const h = harness([lane]);
  const ledgerBefore = structuredClone(h.stored.get(lane.id));
  const result = await releaseMaintenancePauses({
    lanes: [lane],
    requests: [request],
    tasks: [],
    getScheduler: h.getScheduler,
  });
  expect(result.released).toEqual([]);
  expect(result.blocked).toEqual([
    {
      laneName: lane.name,
      message: expect.stringMatching(/寄养.*未确认.*任务详情/),
    },
  ]);
  expect(h.stored.get(lane.id)).toEqual(ledgerBefore);
  expect(JSON.stringify(request)).toBe(before);
});

it("releases after explicit abandonment without rewriting the unknown result", async () => {
  const [lane] = lanes();
  const request = receipt(lane);
  request.resolution = {
    action: "abandoned",
    at,
    note: "已核对现场，放弃原请求",
  };
  const tasks = [fosterTask(lane)];
  const before = JSON.stringify({ request, tasks });
  const h = harness([lane]);

  const result = await releaseMaintenancePauses({
    lanes: [lane],
    requests: [request],
    tasks,
    getScheduler: h.getScheduler,
  });

  expect(result).toEqual({ released: [lane.name], blocked: [] });
  expect(h.stored.get(lane.id)?.lastStatus).toBe("cancelled");
  expect(h.stored.get(lane.id)?.blockedAt).toBeUndefined();
  expect(JSON.stringify({ request, tasks })).toBe(before);
  await (
    await h.getScheduler(lane)
  ).tick(new Date("2026-10-06T00:00:00Z"), true, false, dailyLaneScope(lane));
  expect(h.executions).toBe(1);
});

it.each(["unknown", "failed", "running"])(
  "releases an explicitly disposed legacy %s pause without a timer backfill",
  async (status) => {
    const [lane] = lanes();
    const request = receipt(lane);
    request.resolution = {
      action: "abandoned",
      at,
      note: "已核对现场，放弃原请求",
    };
    const h = harness([lane]);
    h.stored.set(lane.id, {
      scope: dailyLaneScope(lane),
      lastStatus: status,
      lastAttemptAt: at,
    });

    await expect(
      releaseMaintenancePauses({
        lanes: [lane],
        requests: [request],
        tasks: [fosterTask(lane)],
        getScheduler: h.getScheduler,
      }),
    ).resolves.toEqual({ released: [lane.name], blocked: [] });

    expect(h.stored.get(lane.id)?.lastStatus).toBe("cancelled");
    expect(h.stored.get(lane.id)?.lastAttemptAt).toBe(at);
    await (
      await h.getScheduler(lane)
    ).tick(new Date("2026-10-06T00:00:00Z"), true, false, dailyLaneScope(lane));
    expect(h.executions).toBe(1);
  },
);

it.each(["same-device", "wildcard", "unfixed-target"])(
  "refuses running physical resources before clearing (%s)",
  async (kind) => {
    const [lane] = lanes();
    const request = receipt(lane);
    request.status = "running";
    request.laneId = "renamed-lane";
    if (kind === "wildcard") request.resources = ["*"];
    if (kind === "unfixed-target") lane.managerPath = "";
    const h = harness([lane]);
    const before = structuredClone(h.stored.get(lane.id));

    const result = await releaseMaintenancePauses({
      lanes: [lane],
      requests: [request],
      tasks: [],
      getScheduler: h.getScheduler,
    });

    expect(result.released).toEqual([]);
    expect(result.blocked[0]).toMatchObject({
      laneName: lane.name,
      message: expect.stringMatching(/执行.*等待/),
    });
    expect(h.stored.get(lane.id)).toEqual(before);
  },
);

it("refuses an active orphan game task even without an admission receipt", async () => {
  const [lane] = lanes();
  const task = fosterTask(lane);
  delete task.executionId;
  task.status = "running";
  task.plan.skillIds = ["fight"];
  task.steps = [
    { skillId: "fight", status: "running", message: "", diagnostics: [] },
  ];
  const h = harness([lane]);

  const result = await releaseMaintenancePauses({
    lanes: [lane],
    requests: [],
    tasks: [task],
    getScheduler: h.getScheduler,
  });

  expect(result.released).toEqual([]);
  expect(result.blocked[0].message).toMatch(/执行.*等待/);
  expect(h.stored.get(lane.id)?.lastStatus).toBe("unknown");
});

it("isolates another physical device and reports partial release", async () => {
  const [lane, other] = lanes();
  const request = receipt(other);
  const task = fosterTask(other);
  request.laneId = task.laneId = lane.id;
  const h = harness([lane, other]);

  const result = await releaseMaintenancePauses({
    lanes: [lane, other],
    requests: [request],
    tasks: [task],
    getScheduler: h.getScheduler,
  });

  expect(result.released).toEqual([lane.name]);
  expect(result.blocked).toEqual([
    { laneName: other.name, message: expect.stringMatching(/寄养.*未确认/) },
  ]);
  expect(h.stored.get(lane.id)?.lastStatus).toBe("cancelled");
  expect(h.stored.get(other.id)?.lastStatus).toBe("unknown");
});

it("does not let a running request on another device block an idle lane", async () => {
  const [lane, other] = lanes();
  const request = receipt(other);
  request.status = "running";
  request.laneId = lane.id;
  const task = fosterTask(other);
  task.status = "running";
  task.laneId = lane.id;
  const h = harness([lane]);

  await expect(
    releaseMaintenancePauses({
      lanes: [lane],
      requests: [request],
      tasks: [task],
      getScheduler: h.getScheduler,
    }),
  ).resolves.toEqual({ released: [lane.name], blocked: [] });
});

it.each(["create", "read", "clear"])(
  "reports a scheduler %s failure and continues with another lane",
  async (stage) => {
    const [lane, other] = lanes();
    const h = harness([lane, other]);
    const getScheduler = async (current: DeviceLane) => {
      if (current.id !== lane.id) return h.getScheduler(current);
      if (stage === "create") throw Error("fixture unavailable");
      return {
        gateState: async () => {
          if (stage === "read") throw Error("fixture unavailable");
          return { blocked: true };
        },
        clearBlocked: async () => {
          throw Error("fixture unavailable");
        },
      };
    };

    const result = await releaseMaintenancePauses({
      lanes: [lane, other],
      requests: [],
      tasks: [],
      getScheduler,
    });

    expect(result.released).toEqual([other.name]);
    expect(result.blocked).toEqual([
      {
        laneName: lane.name,
        message: expect.stringMatching(/暂停.*fixture unavailable/),
      },
    ]);
    expect(h.stored.get(lane.id)?.lastStatus).toBe("unknown");
  },
);

it("does not report release when a scheduler clear leaves its gate blocked", async () => {
  const [lane] = lanes();
  const result = await releaseMaintenancePauses({
    lanes: [lane],
    requests: [],
    tasks: [],
    getScheduler: async () => ({
      gateState: async () => ({ blocked: true }),
      clearBlocked: async () => {},
    }),
  });

  expect(result.released).toEqual([]);
  expect(result.blocked[0]).toMatchObject({
    laneName: lane.name,
    message: expect.stringMatching(/仍.*暂停/),
  });
});

it("skips disabled maintenance and already open gates without claiming release", async () => {
  const [lane, other] = lanes();
  lane.enabled = false;
  const h = harness([lane, other]);
  h.stored.set(other.id, {
    scope: dailyLaneScope(other),
    lastStatus: "succeeded",
  });
  const requested: string[] = [];

  const result = await releaseMaintenancePauses({
    lanes: [lane, other],
    requests: [],
    tasks: [],
    getScheduler: async (current) => {
      requested.push(current.id);
      return h.getScheduler(current);
    },
  });

  expect(result).toEqual({ released: [], blocked: [] });
  expect(requested).toEqual([other.id]);
  expect(h.stored.get(lane.id)?.lastStatus).toBe("unknown");
});
