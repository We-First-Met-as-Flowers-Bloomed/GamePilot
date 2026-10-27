import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { DevicePreparationService } from "../apps/desktop/main/device-preparation";
import {
  defaultDeviceLanes,
  type Device,
  type EngineInfo,
} from "../packages/protocol";
import type { LaneWorker } from "../apps/desktop/main/lane-runtime";
import type {
  LanePreviewBinding,
  LanePreviewTarget,
} from "../apps/desktop/main/lane-preview";

const managerPath = "D:/MuMu/MuMuManager.exe";
const installation = { managerPath, adbPath: "D:/MuMu/adb.exe" };
const owned = {
  ...installation,
  instance: 2,
  address: "127.0.0.1:16448",
  startedByUs: true,
  pid: 42,
};
const engine = { connected: true } as EngineInfo;
function worker(request: LaneWorker["request"]): LaneWorker {
  return Object.assign(new EventEmitter(), { request, close() {} });
}
function fixture() {
  const calls: string[] = [];
  const resolve = vi.fn(async () => {
    calls.push("resolve");
    return installation;
  });
  const start = vi.fn(async () => {
    calls.push("start");
    return owned;
  });
  const checkReady = vi.fn(async (_device: Device, _signal: AbortSignal) => {
    calls.push("ready");
  });
  const previewTarget = vi.fn(async (): Promise<LanePreviewTarget> => {
    throw Error("No preview target");
  });
  const service = new DevicePreparationService({
    resolve,
    start,
    checkReady,
    previewTarget,
    pause: async () => {},
  });
  const request = vi.fn(async () => {
    calls.push("connect");
    return engine;
  });
  const input = {
    name: "Account",
    managerPath,
    instance: 2,
    worker: worker(request as LaneWorker["request"]),
    signal: new AbortController().signal,
    log: async (_message: string) => {},
  };
  return {
    calls,
    resolve,
    start,
    checkReady,
    previewTarget,
    service,
    request,
    input,
  };
}

it("resolves and persists the manager before starting and returns the original launch ownership", async () => {
  const f = fixture();
  const result = await f.service.prepareMuMu({
    ...f.input,
    onResolved: async (resolved) => {
      expect(resolved).toBe(managerPath);
      f.calls.push("persist");
    },
  });
  expect(f.calls).toEqual(["resolve", "persist", "start", "connect"]);
  expect(result.owned).toBe(owned);
  expect(result.device).toEqual({
    name: "Account",
    adbPath: owned.adbPath,
    address: owned.address,
  });
  expect(result.engine).toBe(engine);
  expect(f.request).toHaveBeenCalledExactlyOnceWith(
    "connect",
    result.device,
    60000,
  );
});

it("rechecks Android before each bounded transient connection retry using the same device", async () => {
  const f = fixture();
  let attempts = 0;
  f.request.mockImplementation(async () => {
    f.calls.push("connect");
    if (++attempts < 3)
      throw Object.assign(Error("offline"), { code: "connection-unavailable" });
    return engine;
  });
  const result = await f.service.prepareMuMu(f.input);
  expect(f.calls).toEqual([
    "resolve",
    "start",
    "connect",
    "ready",
    "connect",
    "ready",
    "connect",
  ]);
  expect(f.checkReady.mock.calls.map((call) => call[0])).toEqual([
    result.device,
    result.device,
  ]);
  expect(f.start).toHaveBeenCalledTimes(1);
});

it("does not connect after cancellation while waiting for emulator startup", async () => {
  const f = fixture(),
    controller = new AbortController();
  f.start.mockImplementation(async () => {
    controller.abort();
    return owned;
  });
  await expect(
    f.service.prepareMuMu({ ...f.input, signal: controller.signal }),
  ).rejects.toThrow();
  expect(f.request).not.toHaveBeenCalled();
});

it("does not start or resolve a device for an already cancelled request", async () => {
  const f = fixture();
  await expect(
    f.service.prepareMuMu({ ...f.input, signal: AbortSignal.abort() }),
  ).rejects.toThrow();
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
});

it("keeps a connected worker without reading or connecting the saved device", async () => {
  const f = fixture(),
    readDevice = vi.fn(async () => owned);
  expect(await f.service.ensureConnected({ ...f.input, readDevice })).toEqual({
    engine,
  });
  expect(f.request).toHaveBeenCalledExactlyOnceWith("info");
  expect(readDevice).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
});

it("connects a saved device once without launching MuMu", async () => {
  const f = fixture();
  f.request.mockResolvedValueOnce({ connected: false } as EngineInfo);
  const result = await f.service.ensureConnected({
    ...f.input,
    readDevice: async () => owned,
  });
  expect(result.device).toEqual({
    name: "已保存的设备",
    adbPath: owned.adbPath,
    address: owned.address,
  });
  expect(f.request.mock.calls).toEqual([
    ["info"],
    ["connect", result.device, 60000],
  ]);
  expect(f.start).not.toHaveBeenCalled();
});

it("registers only the connected transport and releases the matching preview generation on exit", async () => {
  const f = fixture();
  const lane = defaultDeviceLanes({
    managerPath,
    instance: 2,
    closeEmulatorAfterSuccess: false,
  }).lanes[0];
  const isCurrent = vi.fn(async () => true);
  f.previewTarget.mockResolvedValue({
    ...owned,
    identityKey: "instance-2",
    isCurrent,
  });
  const registerConnected = vi.fn<(binding: LanePreviewBinding) => void>();
  const unregister = vi.fn();
  let quitting = false;
  await f.service.prepareMuMu({
    ...f.input,
    preview: {
      lane,
      service: { registerConnected, unregister },
      requestId: "batch:lane",
      gameId: "onmyoji",
      isQuitting: () => quitting,
    },
  });
  expect(registerConnected).toHaveBeenCalledTimes(1);
  const binding = registerConnected.mock.calls[0][0];
  expect(binding).toMatchObject({
    generation: f.input.worker,
    requestId: "batch:lane",
    gameId: "onmyoji",
  });
  expect(await binding.isCurrent?.()).toBe(true);
  quitting = true;
  expect(await binding.isCurrent?.()).toBe(false);
  f.input.worker.emit("exit");
  expect(unregister).toHaveBeenCalledExactlyOnceWith(lane.id, f.input.worker);
});

it("continues after optional preview discovery fails", async () => {
  const f = fixture();
  f.previewTarget.mockRejectedValue(Error("preview unavailable"));
  const lane = defaultDeviceLanes({
    managerPath,
    instance: 2,
    closeEmulatorAfterSuccess: false,
  }).lanes[0];
  const registerConnected = vi.fn();
  await expect(
    f.service.prepareMuMu({
      ...f.input,
      preview: {
        lane,
        service: { registerConnected, unregister: vi.fn() },
        isQuitting: () => false,
      },
    }),
  ).resolves.toMatchObject({ owned, engine });
  expect(registerConnected).not.toHaveBeenCalled();
});
