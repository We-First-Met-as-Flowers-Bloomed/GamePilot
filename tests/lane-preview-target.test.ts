import { expect, it, vi } from "vitest";
import type { DeviceLane } from "../packages/protocol";
import { resolveMuMuPreviewTarget } from "../apps/desktop/main/lane-preview-target";

const lane = {
  id: "lane-a",
  managerPath: "D:\\MuMu\\MuMuManager.exe",
  instance: 0,
} as DeviceLane;
const info = {
  pid: 123,
  ready: true,
  running: true,
  address: "127.0.0.1:16384",
};
it("pins read-only preview to the actual instance and process creation identity", async () => {
  const readInfo = vi.fn(async () => info);
  const readGeneration = vi.fn(async () => "process-creation-A");
  const target = await resolveMuMuPreviewTarget(lane, {
    readInfo,
    readGeneration,
  });
  expect(target.address).toBe(info.address);
  expect(target.adbPath).toBe("D:\\MuMu\\adb.exe");
  expect(readInfo).toHaveBeenCalledWith(lane.managerPath, 0);
  expect(await target.isCurrent?.()).toBe(true);
  readGeneration.mockResolvedValue("process-creation-B");
  expect(await target.isCurrent?.()).toBe(false);
});
it("rejects stopped or unidentifiable processes and changed serials", async () => {
  const readGeneration = vi.fn(async () => "process-A");
  for (const change of [
    { ready: false },
    { running: false },
    { pid: undefined },
  ]) {
    await expect(
      resolveMuMuPreviewTarget(lane, {
        readInfo: async () => ({ ...info, ...change }),
        readGeneration,
      }),
    ).rejects.toThrow();
  }
  const readInfo = vi.fn(async () => info);
  const target = await resolveMuMuPreviewTarget(lane, {
    readInfo,
    readGeneration,
  });
  readInfo.mockResolvedValue({ ...info, address: "127.0.0.1:16385" });
  expect(await target.isCurrent?.()).toBe(false);
});
