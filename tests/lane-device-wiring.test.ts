import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { parse } from "@babel/parser";
import type { Node } from "@babel/types";
import { transformSync } from "esbuild";
import { expect, it, vi } from "vitest";
import { defaultDeviceLanes } from "../packages/protocol";
import { mumuResource } from "../apps/desktop/main/execution-coordinator";
import { freezeLaneDevice } from "../apps/desktop/main/lane-device";
import {
  freezeLaneExecution,
  freezeLaneExecutionForGame,
  scheduledGames,
} from "../apps/desktop/main/lane-snapshot";
import { defaultArknightsProfiles } from "../games/arknights/config";
import { dailyLaneScope } from "../apps/desktop/main/daily-policy";

const text = readFileSync(
  new URL("../apps/desktop/main/index.ts", import.meta.url),
  "utf8",
);
const source = parse(text, { sourceType: "module", plugins: ["typescript"] });
let handler = "";
let schedulerGuard = "";
let schedulerRetry = "";
let runtimeConstruction = "";
function find(node: Node) {
  if (
    node.type === "NewExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "LaneRuntimeManager"
  )
    runtimeConstruction = `globalThis.runtime = ${text.slice(node.start!, node.end!)};`;
  if (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "handle" &&
    node.arguments[0]?.type === "StringLiteral" &&
    node.arguments[0].value === "gp:onmyoji-identity-inspect"
  )
    handler = text.slice(node.start!, node.end!);
  if (
    node.type === "VariableDeclarator" &&
    node.id.type === "Identifier" &&
    node.id.name === "assertScheduledHistoryClear"
  )
    schedulerGuard = `globalThis.guard = ${text.slice(node.init!.start!, node.init!.end!)};`;
  if (
    node.type === "VariableDeclarator" &&
    node.id.type === "Identifier" &&
    node.id.name === "laneRetryDecision"
  )
    schedulerRetry = `globalThis.retry = ${text.slice(node.init!.start!, node.init!.end!)};`;
  for (const value of Object.values(node))
    for (const child of Array.isArray(value) ? value : [value])
      if (child && typeof child === "object" && typeof child.type === "string")
        find(child as Node);
}
find(source);
if (!handler) throw new Error("Main identity inspection seam missing");
const compiled = transformSync(handler, {
  loader: "ts",
  target: "node22",
}).code;

it("production runtime enables four independent channels with a bounded low-memory wait", () => {
  let options: any;
  const context = createContext({
    __dirname: "main",
    dataDir: "test",
    join: (...parts: string[]) => parts.join("/"),
    executions: { trackWorker() {} },
    LaneRuntimeManager: class {
      constructor(...args: any[]) {
        options = args[4];
      }
    },
  });
  runInContext(
    transformSync(runtimeConstruction, { loader: "ts", target: "node22" }).code,
    context,
  );
  expect(options?.maxConcurrent).toBe(4);
  expect(options.minFreeMemoryBytes).toBeGreaterThan(0);
  expect(options.waitTimeoutMs).toBeGreaterThan(0);
  expect(Number.isFinite(options.waitTimeoutMs)).toBe(true);
});

it("cross-device scheduled retry refuses whole-lane replay explicitly", async () => {
  const lane = defaultDeviceLanes({
    managerPath: "D:/MuMu/MuMuManager.exe",
    instance: 0,
    closeEmulatorAfterSuccess: false,
  }).lanes[0];
  lane.arknights.enabled = lane.onmyoji.enabled = true;
  lane.deviceInstances = { onmyoji: 2 };
  const context = createContext({
    deviceLanes: { read: async () => ({ lanes: [lane] }) },
    arknights: { read: async () => defaultArknightsProfiles },
    dailyLaneScope,
    freezeLaneExecution,
    freezeLaneDevice,
    scheduledGames,
  });
  runInContext(
    transformSync(schedulerRetry, { loader: "ts", target: "node22" }).code,
    context,
  );
  const result = await context.retry(
    lane.id,
    { slot: "primary", dueAt: new Date() },
    { scope: dailyLaneScope(lane), now: new Date(), attempts: 1 },
  );
  expect(result.allowed).toBe(false);
  expect(result.reason).toMatch(/不同.*实例/);
});

it("scheduled preflight checks each game's actual device before split requests", async () => {
  const lane = defaultDeviceLanes({
    managerPath: "D:/MuMu/MuMuManager.exe",
    instance: 0,
    closeEmulatorAfterSuccess: false,
  }).lanes[0];
  lane.arknights.enabled = lane.onmyoji.enabled = true;
  lane.deviceInstances = { onmyoji: 2 };
  const assertDailyHistoryClear = vi.fn();
  const context = createContext({
    executions: { assertHealthy() {}, snapshot: () => [] },
    runLedger: {
      assertHealthy() {},
      flush: async () => {},
      snapshot: () => [],
    },
    arknights: { read: async () => defaultArknightsProfiles },
    assertDailyHistoryClear,
    readStartupFacts: () => [],
    freezeLaneExecution,
    freezeLaneExecutionForGame,
    scheduledGames,
  });
  runInContext(
    transformSync(schedulerGuard, { loader: "ts", target: "node22" }).code,
    context,
  );
  await context.guard(lane, { slot: "primary", dueAt: new Date() });
  expect(
    assertDailyHistoryClear.mock.calls.map((call) => call[0].lane.instance),
  ).toEqual([0, 2]);
});

it("identity inspection addresses and locks the Onmyoji override", async () => {
  const configured = defaultDeviceLanes({
    managerPath: "D:/MuMu/MuMuManager.exe",
    instance: 0,
    closeEmulatorAfterSuccess: false,
  });
  configured.lanes[0].deviceInstances = { onmyoji: 2 };
  const currentMuMuDevice = vi.fn(async () => ({ address: "test-device" }));
  const inspect = vi.fn(async (_resources, action) => action());
  const trackWorker = vi.fn();
  let invoke!: (id: string) => Promise<unknown>;
  const context = createContext({
    handle: (_name: string, callback: typeof invoke) => {
      invoke = callback;
    },
    smoke: false,
    plannerPreview: false,
    quitting: false,
    configuring: false,
    startupInspectionRunning: false,
    starting: false,
    connecting: false,
    finishing: false,
    automaticReserved: false,
    deviceLanes: { read: async () => configured },
    executions: { inspect, trackWorker, active: false },
    history: { active: false },
    laneRuntime: { isRunning: () => false },
    currentMuMuDevice,
    mumuResource,
    freezeLaneDevice,
    __dirname: "main",
    dataDir: "test",
    join: (...parts: string[]) => parts.join("/"),
    randomUUID: () => "test",
    WorkerClient: class {
      async request() {
        return { inspection: "checked" };
      }
      async closeAndWait() {}
    },
  });
  runInContext(compiled, context);
  expect(await invoke(configured.lanes[0].id)).toBe("checked");
  expect(currentMuMuDevice).toHaveBeenCalledWith(
    configured.lanes[0].managerPath,
    2,
  );
  expect(inspect.mock.calls[0][0]).toEqual([
    mumuResource(configured.lanes[0].managerPath, 2),
  ]);
  expect(trackWorker.mock.calls[0][1]()).toEqual([
    mumuResource(configured.lanes[0].managerPath, 2),
  ]);
  expect(configured.lanes[0].instance).toBe(0);
});
