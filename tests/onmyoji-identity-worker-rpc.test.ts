import { afterEach, expect, it, vi } from "vitest";
import ownProfile from "./fixtures/onmyoji/own-settings-a-20261027.json";

const mocks = vi.hoisted(() => ({
  observe: vi.fn(),
  packages: vi.fn(),
  isAppRunning: vi.fn(),
  appProcessRunning: vi.fn(),
  click: vi.fn(),
  startApp: vi.fn(),
  connect: vi.fn(),
  busy: false,
}));
vi.mock("../packages/runtime/app-process", () => ({
  appProcessRunning: mocks.appProcessRunning,
}));
vi.mock("../packages/runtime/maa", () => ({
  MaaEngine: class {
    init = async () => {};
    connect = mocks.connect;
    observe = mocks.observe;
    packages = mocks.packages;
    isAppRunning = mocks.isAppRunning;
    click = mocks.click;
    startApp = mocks.startApp;
  },
}));
vi.mock("../packages/runtime/runner", () => ({
  Runner: class {
    get busy() {
      return mocks.busy;
    }
  },
}));
const processWithPort = process as unknown as { parentPort?: unknown };
const prior = processWithPort.parentPort;
afterEach(() => {
  if (prior === undefined) delete processWithPort.parentPort;
  else processWithPort.parentPort = prior;
  mocks.busy = false;
  vi.resetModules();
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("exposes a read-only experimental identity RPC on the connected worker, with redacted public facts", async () => {
  vi.useFakeTimers();
  vi.stubEnv("GAMEPILOT_DATA", "D:/fixture/worker-data");
  const responses: { id?: string; result?: unknown; error?: string }[] = [];
  let receive!: (event: {
    data: { id: string; method: string; payload?: unknown };
  }) => void;
  processWithPort.parentPort = {
    on: (_event: string, callback: typeof receive) => {
      receive = callback;
    },
    postMessage: (message: (typeof responses)[number]) =>
      responses.push(message),
  };
  mocks.connect.mockResolvedValue({ connected: true, version: "fixture" });
  mocks.packages.mockResolvedValue(["com.netease.onmyoji"]);
  mocks.isAppRunning.mockResolvedValue(true);
  mocks.appProcessRunning.mockResolvedValue(true);
  mocks.observe.mockResolvedValue({ width: 1920, height: 1080, texts: [] });
  await import("../packages/runtime/worker");
  const send = async (id: string, method: string, payload?: unknown) => {
    receive({ data: { id, method, payload } });
    await vi.waitFor(
      () => expect(responses.some((response) => response.id === id)).toBe(true),
      { timeout: 6000 },
    );
    return responses.find((response) => response.id === id)!;
  };
  expect(
    await send("config", "onmyoji-config", {
      identity: { roleId: "local-secret-role", serverName: "local-server" },
    }),
  ).toMatchObject({ result: null });
  expect(
    await send("connect", "connect", {
      name: "fixture",
      adbPath: "D:/fixture/adb.exe",
      address: "fixture:1",
    }),
  ).toMatchObject({ result: { connected: true } });
  const read = await send("inspect", "inspect-onmyoji-identity");
  expect(read).toMatchObject({
    result: {
      inspection: { status: "unknown", certified: false, configured: true },
      localEvidence: {
        expected: { roleId: "local-secret-role" },
        frames: [{}, {}],
      },
    },
  });
  const result = read.result as { inspection: unknown };
  expect(JSON.stringify(result.inspection)).not.toContain("local-secret-role");
  expect(mocks.observe).toHaveBeenCalledTimes(2);
  expect(mocks.appProcessRunning).toHaveBeenCalledTimes(2);
  expect(mocks.appProcessRunning).toHaveBeenCalledWith(
    expect.objectContaining({ address: "fixture:1" }),
    "com.netease.onmyoji",
    expect.any(AbortSignal),
  );
  expect(mocks.isAppRunning).not.toHaveBeenCalled();
  expect(mocks.click).not.toHaveBeenCalled();
  expect(mocks.startApp).not.toHaveBeenCalled();
  expect(
    await send("bad-config", "onmyoji-config", {
      identity: { roleId: "x", serverName: "" },
    }),
  ).toHaveProperty("error");
  expect(
    await send("bad-inspection-config", "inspect-onmyoji-identity", {
      config: null,
    }),
  ).toHaveProperty("error");
  expect(mocks.observe).toHaveBeenCalledTimes(2);
  mocks.busy = true;
  expect(await send("busy", "inspect-onmyoji-identity")).toMatchObject({
    error: expect.stringContaining("其他操作"),
  });
  expect(mocks.observe).toHaveBeenCalledTimes(2);
  mocks.busy = false;
  mocks.appProcessRunning.mockRejectedValue(new Error("ADB disconnected"));
  const offline = await send("offline", "inspect-onmyoji-identity");
  expect(offline).toMatchObject({
    result: {
      inspection: { status: "unknown", reason: "observation-failed" },
      localEvidence: { frames: [] },
    },
  });
  expect(mocks.observe).toHaveBeenCalledTimes(2);
  mocks.appProcessRunning.mockResolvedValue(true);
  const profileRead = await send(
    "profile-inspect",
    "inspect-onmyoji-identity",
    {
      config: { identity: { roleId: "106123456" } },
      mode: "profile",
    },
  );
  expect(profileRead).toMatchObject({
    result: {
      inspection: { status: "unknown", certified: false },
      localEvidence: { certification: "profile-uid-v1" },
    },
  });
  expect(mocks.click).not.toHaveBeenCalled();
  const home = {
    width: 1920,
    height: 1080,
    texts: [
      { text: "测试角色", box: [194, 45, 126, 36], score: 0.99 },
      { text: "加成", box: [550, 55, 32, 56], score: 0.99 },
      { text: "召唤", box: [1578, 262, 60, 107], score: 0.99 },
    ],
  };
  for (const frame of [home, home, ownProfile, ownProfile, home, home])
    mocks.observe.mockResolvedValueOnce(frame);
  const verified = await send("profile-matched", "inspect-onmyoji-identity", {
    config: { identity: { roleId: "106123456" } },
    mode: "profile",
  });
  expect(verified).toMatchObject({
    result: {
      inspection: { status: "matched", certified: true, configured: true },
    },
  });
  expect(
    JSON.stringify((verified.result as { inspection: unknown }).inspection),
  ).not.toContain("106123456");
  expect(mocks.click).toHaveBeenCalledTimes(2);
}, 15000);
