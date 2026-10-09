import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { HistoryStore } from "../apps/desktop/main/history";
import { mergeHistory } from "../apps/desktop/renderer/hooks/useDesktop";
import type { RunEvent } from "../packages/protocol";
import { deviceLanePlanKey } from "../packages/protocol";
import { boundRunHistory } from "../packages/protocol/run-state";
import { dailyLaneState } from "../apps/desktop/renderer/daily-state";
const dirs: string[] = [];
it("preserves a single-request source after an interrupted restart", async () => {
  const path = await setup();
  const e: RunEvent = {
    runId: "b",
    batchId: "b",
    laneId: "a",
    executionSource: "single",
    type: "status",
    status: "running",
    message: "login",
    at: new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify([e]));
  const store = new HistoryStore(path);
  await store.load();
  expect(store.snapshot().at(-1)).toMatchObject({
    status: "failed",
    executionSource: "single",
  });
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "gamepilot-history-test-"));
  dirs.push(dir);
  return join(dir, "history.json");
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    if (
      !resolve(dir).startsWith(
        resolve(tmpdir()) + sep + "gamepilot-history-test-",
      )
    )
      throw new Error("Unexpected test directory");
    await rm(dir, { recursive: true, force: true });
  }
});
const event = (message: string, status?: RunEvent["status"]): RunEvent => ({
  runId: "run-1",
  type: status ? "status" : "log",
  status,
  message,
  at: "2026-09-14T00:00:00.000Z",
});
it("keeps another lane active when one lane of the same batch finishes, even after log eviction", async () => {
  const path = await setup();
  const store = new HistoryStore(path);
  await store.load();
  const a = {
    ...event("A", "running"),
    runId: "batch",
    batchId: "batch",
    laneId: "a",
  };
  const b = { ...a, laneId: "b", message: "B" };
  const done = { ...b, status: "succeeded" as const };
  await store.append(a);
  await store.append(b);
  await store.append(done);
  expect(store.active).toBe(true);
  const logs = Array.from({ length: 505 }, (_, i) => ({
    ...a,
    status: undefined,
    type: "log" as const,
    message: String(i),
  }));
  await Promise.all(logs.map((item) => store.append(item)));
  expect(store.active).toBe(true);
  expect(mergeHistory([a, b, done], logs)).toContainEqual(a);
  const restarted = new HistoryStore(path);
  await restarted.load();
  expect(restarted.snapshot()).toContainEqual(
    expect.objectContaining({ laneId: "a", status: "failed" }),
  );
  expect(restarted.active).toBe(false);
});
it("serializes concurrent history writes and bounds disk and memory to 500 events", async () => {
  const path = await setup();
  const store = new HistoryStore(path);
  await store.load();
  await Promise.all(
    Array.from({ length: 505 }, (_, i) => store.append(event(String(i)))),
  );
  expect(store.snapshot()).toHaveLength(500);
  expect(store.snapshot()[0].message).toBe("5");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(
    JSON.parse(JSON.stringify(store.snapshot())),
  );
});
it("marks a previously active run interrupted once after restart", async () => {
  const path = await setup();
  const store = new HistoryStore(path);
  await store.load();
  await store.append(event("running", "running"));
  expect(store.active).toBe(true);
  const restarted = new HistoryStore(path);
  await restarted.load();
  expect(restarted.active).toBe(false);
  expect(restarted.snapshot().at(-1)).toMatchObject({
    status: "failed",
    runId: "run-1",
  });
  const again = new HistoryStore(path);
  await again.load();
  expect(again.snapshot()).toEqual(restarted.snapshot());
});
it("preserves concurrent newer events while hydrating overlapping history", () => {
  const running = event("start", "running"),
    completed = event("done", "succeeded");
  expect(mergeHistory([running], [running, completed])).toEqual([
    running,
    completed,
  ]);
  expect(mergeHistory([running, completed], [running, completed])).toEqual([
    running,
    completed,
  ]);
});
it("retains active status through a full window of progress logs", async () => {
  const store = new HistoryStore(await setup());
  await store.load();
  const running = event("start", "running");
  await store.append(running);
  const logs = Array.from({ length: 501 }, (_, i) => event(`progress ${i}`));
  await Promise.all(logs.map((item) => store.append(item)));
  expect(store.active).toBe(true);
  expect(store.snapshot()).toHaveLength(500);
  expect(store.snapshot()[0]).toEqual(running);
  expect(mergeHistory([running], logs)[0]).toEqual(running);
});
it("persists lane and batch identity when an active lane is recovered", async () => {
  const path = await setup();
  const store = new HistoryStore(path);
  await store.load();
  await store.append({
    ...event("lane running", "running"),
    laneId: "lane-b",
    batchId: "batch-1",
  });
  const restarted = new HistoryStore(path);
  await restarted.load();
  expect(restarted.snapshot().at(-1)).toMatchObject({
    laneId: "lane-b",
    batchId: "batch-1",
    status: "failed",
  });
});

it.each([false, true])(
  "preserves start time and maintenance=%s after recovering and evicting an interrupted run",
  async (maintenance) => {
    const path = await setup();
    const startedAt = "2026-09-24T08:00:00+08:00";
    const lane = {
      id: "a",
      name: "A",
      managerPath: "",
      instance: 0,
      enabled: true,
      arknights: { enabled: true, profileId: "default" },
      onmyoji: { enabled: false },
      closeEmulatorAfterSuccess: false,
    };
    const running: RunEvent = {
      ...event("lane running", "running"),
      runId: "daily-batch",
      batchId: "daily-batch",
      laneId: "a",
      at: startedAt,
      startedAt,
      maintenance,
      executionSource: maintenance ? "maintenance" : "daily",
      planKey: deviceLanePlanKey(lane),
    };
    await writeFile(path, JSON.stringify([running]));
    const restarted = new HistoryStore(path);
    await restarted.load();
    const logs = Array.from({ length: 505 }, (_, i): RunEvent => ({
      ...running,
      type: "log",
      status: undefined,
      message: String(i),
    }));
    const history = boundRunHistory([...restarted.snapshot(), ...logs]);
    expect(history).toHaveLength(500);
    expect(history).not.toContainEqual(running);
    expect(history.find((item) => item.status === "failed")).toMatchObject({
      startedAt,
      maintenance,
    });
    const state = dailyLaneState(
      lane,
      history,
      new Date("2026-09-24T09:00:00+08:00"),
    );
    expect(state.status).toBe(maintenance ? null : "failed");
  },
);
