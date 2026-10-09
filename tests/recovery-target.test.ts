import { expect, it } from "vitest";
import { recoveryDevice } from "../apps/desktop/main/recovery-service";
import { currentMuMuDevice } from "../apps/desktop/main/mumu";
import { defaultDeviceLanes, validateAutomation } from "../packages/protocol";
import type { ExecutionRecord } from "../packages/protocol/execution";
const automation = validateAutomation({
  managerPath: "D:/MuMu/MuMuManager.exe",
  instance: 0,
});
const lanes = defaultDeviceLanes(automation);
const settings = {
  adbPath: "adb.exe",
  address: "127.0.0.1:16384",
  modelEndpoint: "",
  modelName: "",
};
const record: ExecutionRecord = {
  version: 1,
  id: "r",
  fingerprint: "h",
  status: "unknown",
  resources: ["*"],
  source: "daily",
  laneId: "lane-a",
  snapshot: { lane: lanes.lanes[0] },
  startedAt: "2026-09-25T00:00:00Z",
  message: "exit",
};
it("rejects reassigned lanes before inspecting any device", async () => {
  const changed = structuredClone(lanes);
  changed.lanes[0]!.instance = 1;
  let called = false;
  await expect(
    recoveryDevice(record, changed, automation, settings, async () => {
      called = true;
      return { ...settings, name: "device" };
    }),
  ).rejects.toThrow("绑定");
  expect(called).toBe(false);
});
it("reads only the original MuMu instance and never launches an offline emulator", async () => {
  const calls: string[][] = [];
  await expect(
    currentMuMuDevice(automation.managerPath, 0, async (_f, args) => {
      calls.push(args);
      return JSON.stringify({
        index: "0",
        is_android_started: false,
        is_process_started: false,
      });
    }),
  ).rejects.toThrow("未就绪");
  expect(calls).toEqual([["info", "-v", "0"]]);
});
