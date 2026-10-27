import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { parse } from "@babel/parser";
import type { Node } from "@babel/types";
import { transformSync } from "esbuild";
import { afterEach, expect, it, vi } from "vitest";
import {
  defaultDeviceLanes,
  deviceLanePlanKey,
  type DeviceLane,
} from "../packages/protocol";
import { agentObject } from "../packages/protocol/agent";
import { validateRequestId } from "../packages/protocol/execution";
import { defaultArknightsProfiles } from "../games/arknights/config";
import {
  ExecutionCoordinator,
  mumuResource,
} from "../apps/desktop/main/execution-coordinator";
import { LaneRuntimeManager } from "../apps/desktop/main/lane-runtime";
import { dailyLaneScope } from "../apps/desktop/main/daily-policy";
import {
  DailyScheduler,
  type ScheduleLedger,
} from "../apps/desktop/main/scheduler";
import { runBudget, runFailure } from "../packages/runtime/run-budget";
import { DevicePreparationService } from "../apps/desktop/main/device-preparation";
import type { LanePlanActions } from "../apps/desktop/main/lane-plan";
import {
  freezeLaneExecution,
  freezeLaneExecutionForGame,
  type LaneExecutionSnapshot,
} from "../apps/desktop/main/lane-snapshot";

const source = readFileSync(
  new URL("../apps/desktop/main/index.ts", import.meta.url),
  "utf8",
);
const seams = new Map<string, string>();
let ipcHandle = "";
let realLaneExecution = "";
function visit(node: Node) {
  if (
    node.type === "VariableDeclarator" &&
    node.id.type === "Identifier" &&
    node.id.name === "executeDeviceLane"
  )
    realLaneExecution = `const executeDeviceLane = ${source.slice(node.init!.start!, node.init!.end!)};`;
  if (
    node.type === "VariableDeclarator" &&
    node.id.type === "Identifier" &&
    node.id.name === "handle"
  )
    ipcHandle = `const handle = ${source.slice(node.init!.start!, node.init!.end!)};`;
  if (
    node.type === "VariableDeclarator" &&
    node.id.type === "Identifier" &&
    node.id.name === "launchLane"
  )
    seams.set(
      "launchLane",
      `const launchLane = ${source.slice(node.init!.start!, node.init!.end!)};`,
    );
  if (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "handle" &&
    node.arguments[0]?.type === "StringLiteral"
  ) {
    const name = node.arguments[0].value;
    if (
      ["gp:game-slot-start", "gp:game-slot-stop", "gp:lane-start"].includes(
        name,
      )
    )
      seams.set(name, source.slice(node.start!, node.end!));
  }
  for (const value of Object.values(node))
    for (const child of Array.isArray(value) ? value : [value])
      if (child && typeof child === "object" && typeof child.type === "string")
        visit(child as Node);
}
visit(parse(source, { sourceType: "module", plugins: ["typescript"] }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0)) await action();
});
async function host(
  options: {
    maxConcurrent?: number;
    ignoreAbort?: boolean;
    realExecution?: boolean;
    realPreparation?: boolean;
    waitForStartup?: Promise<void>;
  } = {},
) {
  expect(
    seams.has("gp:game-slot-start"),
    "production scoped start handler",
  ).toBe(true);
  expect(seams.has("gp:game-slot-stop"), "production scoped stop handler").toBe(
    true,
  );
  const directory = await mkdtemp(join(tmpdir(), "gamepilot-game-slot-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const executions = new ExecutionCoordinator(directory);
  await executions.load();
  const configured = defaultDeviceLanes({
    managerPath: "D:/MuMu/MuMuManager.exe",
    instance: 0,
    closeEmulatorAfterSuccess: false,
  });
  configured.lanes.push({
    ...structuredClone(configured.lanes[0]),
    id: "lane-b",
    name: "Account B",
    instance: 1,
  });
  for (const lane of configured.lanes)
    lane.enabled = lane.arknights.enabled = lane.onmyoji.enabled = true;
  const workerRequests: string[] = [];
  const laneRuntime = new LaneRuntimeManager(
    "test-worker",
    directory,
    () =>
      Object.assign(new EventEmitter(), {
        async request<T>(method: string) {
          workerRequests.push(method);
          return (method === "connect" ? { connected: true } : undefined) as T;
        },
        close() {},
      }),
    undefined,
    { maxConcurrent: options.maxConcurrent ?? 2 },
  );
  const stop = vi.spyOn(laneRuntime, "stop");
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const launches: LaneExecutionSnapshot[] = [];
  const laneJobs = new Map<string, Promise<unknown>>();
  const lanePreparations = new Map<string, AbortController>();
  const gameSlotRuns = new Map();
  let scheduleLedger: ScheduleLedger = {};
  const scheduler = new DailyScheduler(
    {
      read: async () => scheduleLedger,
      save: async (value) => {
        scheduleLedger = value;
      },
    },
    (value) => value.toISOString().slice(0, 10),
    async () => "fixture",
  );
  const executeLanePlan = vi.fn(async (lane: DeviceLane, actions: LanePlanActions) => {
    if (options.realPreparation) await actions.prepare(lane);
    return [];
  });
  const resolveMuMu = vi.fn(async () => ({
    managerPath: "D:/MuMu/MuMuManager.exe",
    adbPath: "adb",
  }));
  const ensureMuMu = vi.fn(async (managerPath: string, instance: number) => {
    await options.waitForStartup;
    return {
      managerPath,
      instance,
      adbPath: "adb",
      address: `127.0.0.1:${16384 + instance * 32}`,
      startedByUs: true,
      pid: 42,
    };
  });
  const closeOwnedMuMu = vi.fn(async () => true);
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const assertLaneCanStart = vi.fn(async (lane: DeviceLane) => {
    if (!lane.enabled) throw Error("账号渠道未启用");
    if (laneRuntime.isRunning(lane.id)) throw Error("账号渠道正在运行");
  });
  const context = createContext({
    handle: (name: string, fn: (input: unknown) => Promise<unknown>) =>
      handlers.set(name, fn),
    automaticReserved: false,
    randomUUID: () => "generated-batch",
    validateRequestId,
    agentObject,
    deviceLanes: { read: async () => configured },
    arknights: { read: async () => defaultArknightsProfiles },
    executions,
    laneRuntime,
    laneJobs,
    lanePreparations,
    gameSlotRuns,
    dailyLaneScope,
    freezeLaneExecution,
    freezeLaneExecutionForGame,
    mumuResource,
    AbortController,
    DOMException,
    Error,
    Date,
    appVersion: "test",
    cancelledLaneCycles: new Set(),
    assertLaneCanStart,
    deviceLanePlanKey,
    runBudget,
    runFailure,
    lanePreview: undefined,
    presence: undefined,
    observations: { save: vi.fn() },
    publish: vi.fn(),
    executeLanePlan,
    devicePreparation: new DevicePreparationService({
      resolve: resolveMuMu,
      start: ensureMuMu,
    }),
    closeOwnedMuMu,
    automation: {
      read: async () => ({
        notifyResults: false,
        scheduleEnabled: true,
        scheduleTime: "08:00",
        runOnLaunch: false,
        managerPath: "D:/MuMu/MuMuManager.exe",
      }),
    },
    freezeLaneDevice: (lane: DeviceLane) => JSON.parse(JSON.stringify(lane)),
    resolveMuMu,
    ensureMuMu,
    AbortSignal,
    console: { warn: () => {}, log: () => {}, error: () => {} },
    laneDailySchedulers: new Map(
      configured.lanes.map((lane) => [lane.id, scheduler]),
    ),
    assertDailyHistoryClear: vi.fn(),
    assertMaintenanceClear: vi.fn(),
    readStartupFacts: () => [],
    runLedger: {
      flush: async () => {},
      assertHealthy() {},
      snapshot: () => [],
    },
    executeDeviceLane: async (
      frozen: LaneExecutionSnapshot,
      _worker: unknown,
      batchId: string,
      signal: AbortSignal,
      lease: { finish(status: string, message: string): Promise<void> },
    ) => {
      launches.push(frozen);
      const gate = deferred();
      gates.set(batchId, gate);
      const cancel = () => gate.resolve();
      if (!options.ignoreAbort)
        signal.addEventListener("abort", cancel, { once: true });
      await gate.promise;
      signal.removeEventListener("abort", cancel);
      await lease.finish(
        signal.aborted ? "cancelled" : "succeeded",
        "test engine result",
      );
    },
  });
  runInContext(
    transformSync(
      [options.realExecution ? realLaneExecution : "", ...seams.values()].join(
        "\n",
      ),
      {
        loader: "ts",
        target: "node22",
      },
    ).code,
    context,
  );
  const start = (input: unknown) => handlers.get("gp:game-slot-start")!(input);
  const cancel = (input: unknown) => handlers.get("gp:game-slot-stop")!(input);
  const legacyStart = (input: unknown) => handlers.get("gp:lane-start")!(input);
  const drain = async () => {
    for (const gate of gates.values()) gate.resolve();
    await Promise.allSettled([...laneJobs.values()]);
  };
  cleanup.unshift(drain);
  return {
    start,
    cancel,
    configured,
    executions,
    launches,
    stop,
    gates,
    laneJobs,
    lanePreparations,
    gameSlotRuns,
    context,
    assertLaneCanStart,
    legacyStart,
    scheduleLedger: () => scheduleLedger,
    executeLanePlan,
    workerRequests,
    ensureMuMu,
    closeOwnedMuMu,
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function started(h: Awaited<ReturnType<typeof host>>, batch: string) {
  for (let i = 0; i < 30 && !h.gates.has(batch); i++) await tick();
  expect(h.gates.has(batch)).toBe(true);
}

it("freezes only the chosen game, original account, budget and physical override", async () => {
  const h = await host(),
    lane = h.configured.lanes[0];
  lane.deviceInstances = { onmyoji: 2 };
  const before = structuredClone(h.configured);
  expect(
    await h.start({ laneId: lane.id, gameId: "onmyoji", requestId: "yys" }),
  ).toEqual({ batchId: "yys" });
  await started(h, "yys");
  const record = h.executions.get(`yys:${lane.id}`);
  expect(record.laneId).toBe(lane.id);
  expect(record.snapshot.gameSlot).toEqual({
    laneId: lane.id,
    gameId: "onmyoji",
  });
  expect(record.snapshot.arknightsPlan).toBeUndefined();
  expect(record.snapshot.onmyojiPlan).toBeDefined();
  expect(record.resources).toEqual([mumuResource(lane.managerPath, 2)]);
  expect(h.launches[0].lane.instance).toBe(2);
  expect(h.launches[0].lane.onmyoji).toEqual(lane.onmyoji);
  expect(h.configured).toEqual(before);
});

it("retains the selected Arknights profile and spending limits without launching Onmyoji", async () => {
  const h = await host(),
    lane = h.configured.lanes[0];
  await h.start({ laneId: lane.id, gameId: "arknights", requestId: "ark" });
  await started(h, "ark");
  const frozen = h.launches[0];
  expect(frozen.profile).toEqual(
    defaultArknightsProfiles.profiles.find(
      (p) => p.id === lane.arknights.profileId,
    ),
  );
  expect(frozen.onmyojiPlan).toBeUndefined();
  expect(frozen.arknightsPlan?.gameId).toBe("arknights");
  expect(frozen.lane.arknights).toEqual(lane.arknights);
});

it("refuses a disabled game and invalid scopes before accepting any request", async () => {
  const h = await host(),
    lane = h.configured.lanes[0];
  lane.onmyoji.enabled = false;
  await expect(h.start({ laneId: lane.id, gameId: "onmyoji" })).rejects.toThrow(
    /范围|启用/,
  );
  for (const input of [
    null,
    lane.id,
    { laneId: lane.id },
    { laneId: lane.id, gameId: "unknown" },
    { laneId: "missing", gameId: "arknights" },
    { laneId: lane.id, gameId: "arknights", scope: "all" },
  ])
    await expect(h.start(input)).rejects.toThrow();
  expect(h.executions.snapshot()).toEqual([]);
  expect(h.context.ensureMuMu).not.toHaveBeenCalled();
});

it("prepares once after admission and preserves launch ownership for successful cleanup", async () => {
  const h = await host({ realExecution: true, realPreparation: true });
  const lane = h.configured.lanes[0];
  lane.closeEmulatorAfterSuccess = true;
  h.ensureMuMu.mockImplementationOnce(async (managerPath, instance) => {
    expect(h.executions.get(`owned:${lane.id}`).status).toBe("running");
    expect(h.gameSlotRuns.has(lane.id)).toBe(true);
    expect(h.lanePreparations.has(lane.id)).toBe(true);
    return { managerPath, instance, adbPath: "adb", address: "127.0.0.1:16384", startedByUs: true, pid: 42 };
  });
  await h.start({ laneId: lane.id, gameId: "arknights", requestId: "owned" });
  await Promise.all([...h.laneJobs.values()]);
  expect(h.ensureMuMu).toHaveBeenCalledTimes(1);
  expect(h.workerRequests).toEqual(["connect"]);
  expect(h.closeOwnedMuMu).toHaveBeenCalledExactlyOnceWith(await h.ensureMuMu.mock.results[0].value);
  expect(h.lanePreparations.size).toBe(0);
  expect(h.executions.get(`owned:${lane.id}`).status).toBe("succeeded");
});

it("cancels actual device preparation before connection and releases its preparation ownership", async () => {
  const startup = deferred();
  const h = await host({ realExecution: true, realPreparation: true, waitForStartup: startup.promise });
  const lane = h.configured.lanes[0];
  await h.start({ laneId: lane.id, gameId: "arknights", requestId: "preparing" });
  for (let i = 0; i < 30 && !h.ensureMuMu.mock.calls.length; i++) await tick();
  expect(h.ensureMuMu).toHaveBeenCalledTimes(1);
  expect(h.lanePreparations.has(lane.id)).toBe(true);
  const stopped = h.cancel({ laneId: lane.id, gameId: "arknights" });
  startup.resolve();
  await stopped;
  expect(h.workerRequests).not.toContain("connect");
  expect(h.lanePreparations.size).toBe(0);
  expect(h.executions.get(`preparing:${lane.id}`).status).toBe("cancelled");
});

it("rejects an overlapping game on the same original lane while allowing a different lane", async () => {
  const h = await host(),
    [a, b] = h.configured.lanes;
  await h.start({ laneId: a.id, gameId: "arknights", requestId: "a" });
  await started(h, "a");
  await expect(
    h.start({ laneId: a.id, gameId: "onmyoji", requestId: "same-lane" }),
  ).rejects.toThrow(/运行/);
  await h.start({ laneId: b.id, gameId: "arknights", requestId: "b" });
  await started(h, "b");
  expect(h.executions.snapshot()).toHaveLength(2);
});

it("preserves the physical lease when two original lanes share an emulator", async () => {
  const h = await host(),
    [a, b] = h.configured.lanes;
  b.instance = a.instance;
  await h.start({ laneId: a.id, gameId: "arknights", requestId: "owner" });
  await started(h, "owner");
  await expect(
    h.start({ laneId: b.id, gameId: "onmyoji", requestId: "conflict" }),
  ).rejects.toThrow(/占用|执行|资源/);
  expect(h.launches).toHaveLength(1);
  expect(h.gameSlotRuns.has(b.id)).toBe(false);
});

it("stops only the owned game request and leaves another account running", async () => {
  const h = await host(),
    [a, b] = h.configured.lanes;
  await h.start({ laneId: a.id, gameId: "arknights", requestId: "a" });
  await h.start({ laneId: b.id, gameId: "onmyoji", requestId: "b" });
  await started(h, "a");
  await started(h, "b");
  await expect(h.cancel({ laneId: a.id, gameId: "onmyoji" })).rejects.toThrow(
    /归属|范围|游戏/,
  );
  expect(h.stop).not.toHaveBeenCalled();
  await h.cancel({ laneId: a.id, gameId: "arknights" });
  expect(h.stop.mock.calls).toEqual([[a.id]]);
  expect(h.executions.get(`a:${a.id}`).status).toBe("cancelled");
  expect(h.executions.get(`b:${b.id}`).status).toBe("running");
});

it("refuses legacy mixed requests and forged scope metadata without stopping their worker", async () => {
  const h = await host(),
    lane = h.configured.lanes[0];
  const lease = await h.executions.begin({
    id: `legacy:${lane.id}`,
    source: "daily",
    laneId: lane.id,
    batchId: "legacy",
    resources: [mumuResource(lane.managerPath, lane.instance)],
    snapshot: freezeLaneExecution(
      lane,
      defaultArknightsProfiles,
      false,
    ) as unknown as Record<string, unknown>,
  });
  await expect(
    h.cancel({ laneId: lane.id, gameId: "arknights" }),
  ).rejects.toThrow(/归属|范围|游戏/);
  h.gameSlotRuns.set(lane.id, {
    gameId: "arknights",
    batchId: "legacy",
    controller: new AbortController(),
    done: Promise.resolve(),
  });
  await expect(
    h.cancel({ laneId: lane.id, gameId: "arknights" }),
  ).rejects.toThrow(/归属|范围|游戏/);
  expect(h.stop).not.toHaveBeenCalled();
  await lease.finish("cancelled", "fixture cleanup");
});

it("cancels preparation during durable admission and retains the final cancelled receipt", async () => {
  const h = await host(),
    lane = h.configured.lanes[0],
    persisted = deferred(),
    continueAdmission = deferred();
  const begin = h.executions.begin.bind(h.executions);
  vi.spyOn(h.executions, "begin").mockImplementation(async (...args) => {
    const lease = await begin(...args);
    persisted.resolve();
    await continueAdmission.promise;
    return lease;
  });
  const launch = h.start({
    laneId: lane.id,
    gameId: "arknights",
    requestId: "preparing",
  });
  await persisted.promise;
  const cancelling = h.cancel({ laneId: lane.id, gameId: "arknights" });
  continueAdmission.resolve();
  await launch;
  await cancelling;
  expect(h.launches).toEqual([]);
  expect(h.executions.get(`preparing:${lane.id}`).status).toBe("cancelled");
  expect(h.stop).not.toHaveBeenCalled();
  expect(h.gameSlotRuns.has(lane.id)).toBe(false);
});

it("does not let a stale slot cancellation stop a replacement game after completion", async () => {
  const h = await host(),
    lane = h.configured.lanes[0];
  await h.start({ laneId: lane.id, gameId: "arknights", requestId: "old" });
  await started(h, "old");
  h.gates.get("old")!.resolve();
  await Promise.allSettled([...h.laneJobs.values()]);
  await tick();
  await h.start({ laneId: lane.id, gameId: "onmyoji", requestId: "new" });
  await started(h, "new");
  await expect(
    h.cancel({ laneId: lane.id, gameId: "arknights" }),
  ).rejects.toThrow(/归属|范围|游戏/);
  expect(h.stop).not.toHaveBeenCalled();
  expect(h.executions.get(`new:${lane.id}`).status).toBe("running");
});

it("cancels a resource-queued slot without cancelling the already running account", async () => {
  const h = await host({ maxConcurrent: 1 }),
    [a, b] = h.configured.lanes;
  await h.start({ laneId: a.id, gameId: "arknights", requestId: "running" });
  await started(h, "running");
  await h.start({ laneId: b.id, gameId: "onmyoji", requestId: "queued" });
  expect(h.gates.has("queued")).toBe(false);
  await h.cancel({ laneId: b.id, gameId: "onmyoji" });
  expect(h.executions.get(`queued:${b.id}`).status).toBe("cancelled");
  expect(h.executions.get(`running:${a.id}`).status).toBe("running");
  expect(h.stop.mock.calls).toEqual([[b.id]]);
});

it("reports a failed stop transport immediately while retaining request ownership for a safe retry", async () => {
  const h = await host({ ignoreAbort: true }),
    lane = h.configured.lanes[0];
  await h.start({
    laneId: lane.id,
    gameId: "arknights",
    requestId: "transport",
  });
  await started(h, "transport");
  h.stop.mockRejectedValueOnce(Error("stop transport failed"));
  let result = "pending";
  const cancelling = h.cancel({ laneId: lane.id, gameId: "arknights" }).then(
    () => {
      result = "succeeded";
    },
    (error) => {
      result = String(error);
    },
  );
  await tick();
  await tick();
  expect(result).toContain("stop transport failed");
  expect(h.executions.get(`transport:${lane.id}`).status).toBe("running");
  expect(h.gameSlotRuns.has(lane.id)).toBe(true);
  h.gates.get("transport")!.resolve();
  await cancelling;
});

it("preload forwards exact game scopes with distinct request IDs and keeps legacy API behavior", async () => {
  const invoke = vi.fn(async () => undefined);
  let api: import("../packages/protocol").DesktopAPI | undefined;
  let sequence = 0;
  const context = createContext({
    require: (name: string) => {
      expect(name).toBe("electron");
      return {
        contextBridge: {
          exposeInMainWorld: (_key: string, value: typeof api) => {
            api = value;
          },
        },
        ipcRenderer: { invoke },
      };
    },
    crypto: { randomUUID: () => `request-${++sequence}` },
  });
  runInContext(
    transformSync(
      readFileSync(
        new URL("../apps/desktop/preload/index.ts", import.meta.url),
        "utf8",
      ),
      { loader: "ts", format: "cjs", target: "node22" },
    ).code,
    context,
  );
  const target = { laneId: "lane-a", gameId: "onmyoji" as const };
  await api!.startGameSlot(target);
  await api!.startGameSlot(target);
  await api!.startGameSlot({ ...target, requestId: "explicit" });
  await api!.stopGameSlot(target);
  await api!.startLane("lane-a", "legacy");
  await api!.stopLane("lane-a");
  expect(invoke.mock.calls).toEqual([
    ["gp:game-slot-start", { ...target, requestId: "request-1" }],
    ["gp:game-slot-start", { ...target, requestId: "request-2" }],
    ["gp:game-slot-start", { ...target, requestId: "explicit" }],
    ["gp:game-slot-stop", target],
    ["gp:lane-start", { laneId: "lane-a", requestId: "legacy" }],
    ["gp:lane-stop", "lane-a"],
  ]);
  expect(target).toEqual({ laneId: "lane-a", gameId: "onmyoji" });
});

it("planner preview rejects both slot device operations at the trusted IPC boundary", () => {
  const listeners = new Map<
    string,
    (event: unknown, payload: unknown) => unknown
  >();
  const callback = vi.fn();
  const frame = { url: "file:///isolated-renderer.html" };
  const contents = { mainFrame: frame };
  const context = createContext({
    ipcMain: {
      handle: (
        name: string,
        listener: (event: unknown, payload: unknown) => unknown,
      ) => listeners.set(name, listener),
    },
    window: { webContents: contents },
    rendererUrl: frame.url,
    plannerPreview: true,
    callback,
  });
  runInContext(
    transformSync(
      `${ipcHandle}\nhandle("gp:game-slot-start", callback);\nhandle("gp:game-slot-stop", callback);`,
      { loader: "ts", target: "node22" },
    ).code,
    context,
  );
  for (const listener of listeners.values())
    expect(() =>
      listener(
        { sender: contents, senderFrame: frame },
        { laneId: "lane-a", gameId: "arknights" },
      ),
    ).toThrow(/预览/);
  expect(callback).not.toHaveBeenCalled();
});

it.each(["arknights", "onmyoji"] as const)(
  "a successful manual %s run completes its whole single-game channel schedule",
  async (gameId) => {
    const h = await host({ realExecution: true });
    const lane = h.configured.lanes[0];
    lane.arknights.enabled = gameId === "arknights";
    lane.onmyoji.enabled = gameId === "onmyoji";
    await h.start({ laneId: lane.id, gameId, requestId: "whole-channel" });
    await Promise.allSettled([...h.laneJobs.values()]);
    expect(h.scheduleLedger().completedDay).toContain(dailyLaneScope(lane));
  },
);

it.each(["arknights", "onmyoji"] as const)(
  "finishing only %s does not mark the original two-game daily schedule complete",
  async (gameId) => {
    const h = await host({ realExecution: true }),
      lane = h.configured.lanes[0];
    await h.start({ laneId: lane.id, gameId, requestId: "single-game" });
    await Promise.allSettled([...h.laneJobs.values()]);
    expect(h.executions.get(`single-game:${lane.id}`).status).toBe("succeeded");
    expect(h.executeLanePlan).toHaveBeenCalledTimes(1);
    expect(h.scheduleLedger().completedDay).toBeUndefined();
    expect(h.scheduleLedger().completions ?? []).toEqual([]);
    // The legacy whole-account entry still owns the whole-account completion marker.
    await h.legacyStart({ laneId: lane.id, requestId: "whole-account" });
    await Promise.allSettled([...h.laneJobs.values()]);
    expect(h.executions.get(`whole-account:${lane.id}`).status).toBe(
      "succeeded",
    );
    expect(h.scheduleLedger().completedDay).toContain(dailyLaneScope(lane));
  },
);
