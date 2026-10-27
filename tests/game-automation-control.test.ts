import { expect, it, vi } from "vitest";
import { defaultDeviceLanes } from "../packages/protocol";
async function fixture() {
  const m = await import("../apps/desktop/main/game-automation-control").catch(
    () => undefined,
  );
  expect(m?.createGameAutomationControl).toBeTypeOf("function");
  const lane = defaultDeviceLanes({
    managerPath: "D:/MuMu/MuMuManager.exe",
    instance: 2,
    closeEmulatorAfterSuccess: false,
  }).lanes[0];
  lane.enabled = true;
  lane.arknights.enabled = false;
  lane.onmyoji.enabled = true;
  const records = new Map<string, any>();
  const launch = vi.fn(async (target, gameId, requestId) => {
    records.set(`${requestId}:${target.id}`, {
      batchId: requestId,
      laneId: target.id,
      status: "running",
      snapshot: { onmyojiPlan: {} },
    });
  });
  const service = {
    state: vi.fn(),
    tick: vi.fn(async () => []),
    runNow: vi.fn(),
    enableWithCutover: vi.fn(),
  };
  const control = m!.createGameAutomationControl({
    readLanes: async () => [lane],
    findExecution: (id) => records.get(id),
    launch,
    service: () => service,
    busy: () => false,
  });
  return { lane, control, records, launch, service };
}
it("admits saved onmyoji through the App exactly once and never replays an unknown receipt", async () => {
  const f = await fixture();
  const input = { gameId: "onmyoji", laneId: f.lane.id, requestId: "stable" };
  expect(await f.control["game-run-channel"](input)).toEqual({
    batchId: "stable",
  });
  f.records.get(`stable:${f.lane.id}`).status = "unknown";
  expect(await f.control["game-run-channel"](input)).toMatchObject({
    status: "unknown",
  });
  expect(f.launch).toHaveBeenCalledTimes(1);
  expect(
    await f.control["game-run-status"]({
      gameId: "onmyoji",
      laneId: f.lane.id,
      batchId: "stable",
    }),
  ).toMatchObject({ gameId: "onmyoji", status: "unknown" });
  await expect(
    f.control["game-run-status"]({
      gameId: "arknights",
      laneId: f.lane.id,
      batchId: "stable",
    }),
  ).rejects.toThrow(/范围/);
});
it("refuses a disabled account without invoking the worker admission", async () => {
  const f = await fixture();
  f.lane.enabled = false;
  await expect(
    f.control["game-run-channel"]({
      gameId: "onmyoji",
      laneId: f.lane.id,
      requestId: "stable",
    }),
  ).rejects.toThrow(/账号/);
  expect(f.launch).not.toHaveBeenCalled();
});
