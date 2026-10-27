import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceLane, DeviceLanes } from "../packages/protocol";
import { withDisplayQueries, physicalDisplay } from "./android-capture-fixture";
import {
  LanePreviewService,
  type LanePreviewOptions,
} from "../apps/desktop/main/lane-preview";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
  "base64",
);
const lane = (id = "lane-a", instance = 0): DeviceLane => ({
  id,
  name: `账号 ${instance + 1}`,
  managerPath: "D:\\MuMu\\nx_main\\MuMuManager.exe",
  instance,
  enabled: true,
  arknights: { enabled: true, profileId: "default" },
  onmyoji: { enabled: true },
  closeEmulatorAfterSuccess: false,
});
const adbPath = "D:\\MuMu\\nx_main\\adb.exe";
const address = "127.0.0.1:16384";
function fixture(overrides: Partial<LanePreviewOptions> = {}) {
  let configured: DeviceLanes = {
    version: 1,
    lanes: [lane(), lane("lane-b", 1)],
  };
  let now = 10000;
  const execute = vi.fn(async () => png);
  const resolveIdleTarget = vi.fn(async () => undefined);
  const service = new LanePreviewService({
    readLanes: async () => configured,
    resolveIdleTarget,
    checkExecutable: async () => true,
    clock: () => now,
    ...overrides,
    execute: withDisplayQueries(overrides.execute ?? execute),
  });
  const generation = {};
  service.registerConnected({ lane: lane(), adbPath, address, generation });
  return {
    service,
    generation,
    execute,
    resolveIdleTarget,
    setConfig: (value: DeviceLanes) => {
      configured = value;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const turn = () => new Promise<void>((done) => setImmediate(done));
afterEach(() => vi.useRealTimers());

describe("read-only lane preview", () => {
  it("previews the active frozen game override and rejects a changed binding", async () => {
    const configured = lane();
    configured.deviceInstances = { onmyoji: 2 };
    const active = { ...structuredClone(configured), instance: 2 };
    active.arknights.enabled = false;
    delete active.deviceInstances;
    const { service, execute, setConfig, setNow } = fixture();
    setConfig({ version: 1, lanes: [configured] });
    service.registerConnected({
      lane: active,
      adbPath,
      address,
      generation: {},
      gameId: "onmyoji",
    });
    const frame = await service.capture(active.id);
    expect(frame.status).toBe("connected");
    expect(frame.instance).toBe(2);
    configured.deviceInstances.onmyoji = 3;
    setNow(12000);
    expect((await service.capture(active.id)).status).toBe("unavailable");
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("captures the registered account using only bounded screencap and returns no transport secrets", async () => {
    const execute = vi.fn(async () => png);
    const configured: DeviceLanes = { version: 1, lanes: [lane()] };
    const service = new LanePreviewService({
      readLanes: async () => configured,
      execute: withDisplayQueries(execute),
      checkExecutable: async () => true,
      clock: () => Date.parse("2026-10-13T01:02:03.000Z"),
    });
    service.registerConnected({
      lane: lane(),
      adbPath,
      address,
      generation: {},
      requestId: "request-a",
      gameId: "onmyoji",
    });
    const frame = await service.capture("lane-a");
    expect(frame).toEqual({
      status: "connected",
      laneId: "lane-a",
      laneName: "账号 1",
      instance: 0,
      requestId: "request-a",
      gameId: "onmyoji",
      capturedAt: "2026-10-13T01:02:03.000Z",
      imageDataUrl: `data:image/png;base64,${png.toString("base64")}`,
      message: "设备画面已更新",
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      adbPath,
      ["-s", address, "exec-out", "screencap", "-p", "-d", physicalDisplay],
      {
        encoding: "buffer",
        windowsHide: true,
        shell: false,
        timeout: 5000,
        maxBuffer: 12 * 1024 * 1024,
      },
    );
    expect(JSON.stringify(frame)).not.toMatch(
      /127\.0\.0\.1|adb\.exe|MuMuManager/,
    );
  });

  it.each([
    undefined,
    null,
    0,
    {},
    { laneId: "lane-a", address },
    "not-configured",
    "lane-a\n",
  ])(
    "rejects non-ID or unknown renderer input %j without resolving or executing a device",
    async (input) => {
      const { service, execute, resolveIdleTarget } = fixture();
      const result = await service.capture(input);
      expect(result.status).toBe("unavailable");
      expect(result.laneId).toBe("");
      expect(result.imageDataUrl).toBeUndefined();
      expect(execute).not.toHaveBeenCalled();
      expect(resolveIdleTarget).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["D:\\Elsewhere\\adb.exe", address],
    [adbPath, "192.168.1.2:16384"],
    [adbPath, "127.0.0.1:0"],
    [adbPath, "127.0.0.1:65536"],
    [adbPath, "127.0.0.1:16384; input tap 1 1"],
    ["adb.exe", address],
  ])(
    "fails closed for an untrusted bound transport %s %s without idle fallback",
    async (file, serial) => {
      const { service, execute, resolveIdleTarget } = fixture();
      service.registerConnected({
        lane: lane(),
        adbPath: file,
        address: serial,
        generation: {},
      });
      const result = await service.capture("lane-a");
      expect(result.status).toBe("unavailable");
      expect(execute).not.toHaveBeenCalled();
      expect(resolveIdleTarget).not.toHaveBeenCalled();
    },
  );

  it("rejects a missing MuMu ADB executable without invoking capture", async () => {
    const { service, execute } = fixture({
      checkExecutable: async () => false,
    });
    expect((await service.capture("lane-a")).status).toBe("unavailable");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not capture from a binding whose configured MuMu instance changed", async () => {
    const { service, execute, resolveIdleTarget, setConfig } = fixture();
    setConfig({ version: 1, lanes: [lane("lane-a", 2)] });
    expect((await service.capture("lane-a")).status).toBe("unavailable");
    expect(execute).not.toHaveBeenCalled();
    expect(resolveIdleTarget).not.toHaveBeenCalled();
  });

  it("discards a frame after the configured binding changes during capture", async () => {
    const pending = deferred<Buffer>();
    const execute = vi.fn(() => pending.promise);
    const { service, setConfig } = fixture({ execute });
    const capture = service.capture("lane-a");
    await turn();
    expect(execute).toHaveBeenCalledOnce();
    setConfig({
      version: 1,
      lanes: [{ ...lane(), managerPath: "D:\\Other\\MuMuManager.exe" }],
    });
    pending.resolve(png);
    const result = await capture;
    expect(result.status).toBe("unavailable");
    expect(result.imageDataUrl).toBeUndefined();
  });

  it("discards frames from a replaced worker and ignores late old-worker unregister", async () => {
    const pending = deferred<Buffer>();
    const execute = vi.fn(() => pending.promise);
    const { service, generation, setNow } = fixture({ execute });
    const capture = service.capture("lane-a");
    await turn();
    const replacement = {};
    service.registerConnected({
      lane: lane(),
      adbPath,
      address,
      generation: replacement,
    });
    service.unregister("lane-a", generation);
    pending.resolve(png);
    expect((await capture).status).toBe("unavailable");
    setNow(11000);
    expect((await service.capture("lane-a")).status).toBe("connected");
  });

  it("rejects an exiting worker before capture and never falls back to idle discovery", async () => {
    const { service, execute, resolveIdleTarget } = fixture();
    service.registerConnected({
      lane: lane(),
      adbPath,
      address,
      generation: {},
      isCurrent: () => false,
    });
    expect((await service.capture("lane-a")).status).toBe("unavailable");
    expect(execute).not.toHaveBeenCalled();
    expect(resolveIdleTarget).not.toHaveBeenCalled();
  });

  it("rechecks worker availability after the screenshot returns", async () => {
    let current = true;
    const pending = deferred<Buffer>();
    const { service } = fixture({ execute: () => pending.promise });
    service.registerConnected({
      lane: lane(),
      adbPath,
      address,
      generation: {},
      isCurrent: () => current,
    });
    const capture = service.capture("lane-a");
    await turn();
    current = false;
    pending.resolve(png);
    const result = await capture;
    expect(result.status).toBe("unavailable");
    expect(result.imageDataUrl).toBeUndefined();
  });

  it.each(["unregister", "invalidate"])(
    "discards an in-flight capture after %s",
    async (action) => {
      const pending = deferred<Buffer>();
      const { service, generation } = fixture({
        execute: () => pending.promise,
      });
      const capture = service.capture("lane-a");
      await turn();
      if (action === "unregister") service.unregister("lane-a", generation);
      else service.invalidateAll();
      pending.resolve(png);
      expect((await capture).status).toBe("unavailable");
    },
  );

  it("allows one in-flight capture per account while another account stays independent", async () => {
    const pending = deferred<Buffer>();
    const execute = vi.fn((_file: string, args: string[]) =>
      args[1] === address ? pending.promise : Promise.resolve(png),
    );
    const { service } = fixture({ execute });
    service.registerConnected({
      lane: lane("lane-b", 1),
      adbPath,
      address: "127.0.0.1:16385",
      generation: {},
    });
    const first = service.capture("lane-a");
    await turn();
    const second = service.capture("lane-a");
    let concurrentStatus: string | undefined;
    void second.then((frame) => {
      concurrentStatus = frame.status;
    });
    await turn();
    expect((await service.capture("lane-b")).status).toBe("connected");
    pending.resolve(png);
    await second;
    expect((await first).status).toBe("connected");
    expect(concurrentStatus).toBe("unavailable");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("enforces a one-second cooldown including failed attempts", async () => {
    const execute = vi.fn(async () => {
      throw Error("private adb path / stderr");
    });
    const { service, setNow } = fixture({ execute });
    await service.capture("lane-a");
    setNow(10999);
    expect((await service.capture("lane-a")).status).toBe("unavailable");
    expect(execute).toHaveBeenCalledOnce();
    setNow(11000);
    const result = await service.capture("lane-a");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("ignores context from an old generation and discards a capture when its current context changes", async () => {
    const pending = deferred<Buffer>();
    const { service, generation, setNow } = fixture({
      execute: () => pending.promise,
    });
    service.updateContext(
      "lane-a",
      {},
      { requestId: "old-request", gameId: "old-game" },
    );
    service.updateContext("lane-a", generation, {
      requestId: "request-a",
      gameId: "onmyoji",
    });
    const capture = service.capture("lane-a");
    await turn();
    service.updateContext("lane-a", generation, {
      requestId: "request-b",
      gameId: "arknights",
    });
    pending.resolve(png);
    expect((await capture).status).toBe("unavailable");
    setNow(11000);
    expect(await service.capture("lane-a")).toMatchObject({
      status: "connected",
      requestId: "request-b",
      gameId: "arknights",
    });
  });

  it.each([
    Buffer.from("private stderr 127.0.0.1:16384"),
    Buffer.from("89504e470d0a1a0a", "hex"),
    (() => {
      const value = Buffer.from(png);
      value.writeUInt32BE(0, 16);
      return value;
    })(),
    (() => {
      const value = Buffer.from(png);
      value.writeUInt32BE(8193, 20);
      return value;
    })(),
    (() => {
      const value = Buffer.from(png);
      value.writeUInt32BE(8192, 16);
      value.writeUInt32BE(8192, 20);
      return value;
    })(),
    (() => {
      const value = Buffer.from(png);
      value.writeUInt32BE(12, 8);
      return value;
    })(),
    (() => {
      const value = Buffer.from(png);
      value.write("FAIL", 12);
      return value;
    })(),
    png.subarray(0, png.length - 1),
    Buffer.concat([png, Buffer.alloc(12 * 1024 * 1024)]),
  ])(
    "does not return malformed or oversized PNG as a frame (%#)",
    async (image) => {
      const { service } = fixture({ execute: async () => image });
      const result = await service.capture("lane-a");
      expect(result.status).toBe("unavailable");
      expect(result.imageDataUrl).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("private stderr");
    },
  );

  it("bounds a hung command and discards its late result before allowing a new capture", async () => {
    const pending = deferred<Buffer>();
    const execute = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(png);
    const { service, setNow } = fixture({ execute });
    vi.useFakeTimers();
    const capturing = service.capture("lane-a");
    let completed: string | undefined;
    void capturing.then((frame) => {
      completed = frame.status;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    const atDeadline = completed;
    setNow(16000);
    expect((await service.capture("lane-a")).status).toBe("unavailable");
    expect(execute).toHaveBeenCalledOnce();
    pending.resolve(png);
    await capturing;
    // The timed-out capture still owns its slot until the final display recheck settles.
    await vi.advanceTimersByTimeAsync(0);
    expect(atDeadline).toBe("unavailable");
    setNow(16000);
    expect((await service.capture("lane-a")).status).toBe("connected");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("releases the account slot after a synchronous command failure", async () => {
    const execute = vi
      .fn()
      .mockImplementationOnce(() => {
        throw Error("synchronous transport failure");
      })
      .mockResolvedValue(png);
    const { service, setNow } = fixture({ execute });
    expect((await service.capture("lane-a")).status).toBe("unavailable");
    setNow(11000);
    expect((await service.capture("lane-a")).status).toBe("connected");
  });

  it("can capture an idle account only after a trusted existing instance is resolved", async () => {
    const resolveIdleTarget = vi.fn(async () => ({
      adbPath,
      address,
      identityKey: "instance-0-pid-123",
    }));
    const { service, generation, execute } = fixture({ resolveIdleTarget });
    service.unregister("lane-a", generation);
    expect((await service.capture("lane-a")).status).toBe("connected");
    expect(resolveIdleTarget.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      adbPath,
      ["-s", address, "exec-out", "screencap", "-p", "-d", physicalDisplay],
      expect.any(Object),
    );
  });

  it("ignores context for an unknown generation rather than manufacturing a binding", async () => {
    const { service } = fixture({
      resolveIdleTarget: async () => ({
        adbPath,
        address: "127.0.0.1:16385",
        identityKey: "instance-1-pid-123",
      }),
    });
    service.updateContext("lane-b", undefined, {
      requestId: "unknown-request",
      gameId: "onmyoji",
    });
    const result = await service.capture("lane-b");
    expect(result.status).toBe("connected");
    expect(result.requestId).toBeUndefined();
  });

  it("uses the trusted idle target's live identity check immediately before and after capture", async () => {
    const phases: string[] = [];
    let captured = false;
    const isCurrent = vi.fn(async () => {
      phases.push(captured ? "after" : "before");
      return true;
    });
    const resolveIdleTarget = vi.fn(async () => ({
      adbPath,
      address,
      identityKey: "instance-0-pid-123",
      isCurrent,
    }));
    const { service, generation } = fixture({
      resolveIdleTarget,
      execute: async () => {
        captured = true;
        return png;
      },
    });
    service.unregister("lane-a", generation);
    expect((await service.capture("lane-a")).status).toBe("connected");
    expect(phases).toEqual(["before", "after"]);
    expect(resolveIdleTarget).toHaveBeenCalledOnce();
  });

  it("returns unavailable for a stopped idle instance without launching or connecting", async () => {
    const { service, generation, execute, resolveIdleTarget } = fixture();
    service.unregister("lane-a", generation);
    expect((await service.capture("lane-a")).status).toBe("unavailable");
    expect(resolveIdleTarget).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an idle target without stable identity", async () => {
    const { service, generation, execute } = fixture({
      resolveIdleTarget: async () => ({ adbPath, address, identityKey: "" }),
    });
    service.unregister("lane-a", generation);
    expect((await service.capture("lane-a")).status).toBe("unavailable");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an idle instance that was replaced before screenshot execution", async () => {
    let pid = 123;
    const resolveIdleTarget = async () => ({
      adbPath,
      address,
      identityKey: `instance-0-pid-${pid}`,
    });
    const { service, generation, execute } = fixture({
      resolveIdleTarget,
      checkExecutable: async () => {
        pid = 124;
        return true;
      },
    });
    service.unregister("lane-a", generation);
    expect((await service.capture("lane-a")).status).toBe("unavailable");
    expect(execute).not.toHaveBeenCalled();
  });

  it("discards a screenshot after its idle instance PID changes even when the port is reused", async () => {
    let pid = 123;
    const pending = deferred<Buffer>();
    const execute = vi.fn(() => pending.promise);
    const { service, generation } = fixture({
      execute,
      resolveIdleTarget: async () => ({
        adbPath,
        address,
        identityKey: `instance-0-pid-${pid}`,
      }),
    });
    service.unregister("lane-a", generation);
    const capturing = service.capture("lane-a");
    await turn();
    expect(execute).toHaveBeenCalledOnce();
    pid = 124;
    pending.resolve(png);
    expect((await capturing).status).toBe("unavailable");
  });

  it.each(["connected", "invalidate"])(
    "discards idle discovery when %s replaces its scope during lookup",
    async (action) => {
      const target = deferred<{
        adbPath: string;
        address: string;
        identityKey: string;
      }>();
      const { service, generation, execute } = fixture({
        resolveIdleTarget: () => target.promise,
      });
      service.unregister("lane-a", generation);
      const capturing = service.capture("lane-a");
      await turn();
      if (action === "connected")
        service.registerConnected({
          lane: lane(),
          adbPath,
          address,
          generation: {},
        });
      else service.invalidateAll();
      target.resolve({ adbPath, address, identityKey: "instance-0-pid-123" });
      expect((await capturing).status).toBe("unavailable");
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
