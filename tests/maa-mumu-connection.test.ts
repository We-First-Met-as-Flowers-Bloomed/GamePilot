import { afterEach, expect, it, vi } from "vitest";
import { MaaEngine } from "../packages/runtime/maa";

vi.mock("@maaxyz/maa-node", () => ({}));
vi.mock("node:fs/promises", () => ({ access: vi.fn(async () => {}) }));

afterEach(() => vi.unstubAllGlobals());
const device = {
  name: "MuMu",
  adbPath: "D:/MuMuPlayer/nx_main/adb.exe",
  address: "127.0.0.1:16416",
};
const metadata = {
  path: "D:\\MuMuPlayer",
  index: 1,
  libraryPath: "D:\\MuMuPlayer\\nx_main\\sdk\\external_renderer_ipc.dll",
  appPackage: "com.example.game",
};

function native(connected = true) {
  const constructed = vi.fn(),
    destroy = vi.fn(),
    startApp = vi.fn(() => ({ wait: async () => ({ succeeded: true }) }));
  vi.stubGlobal("maa", {
    Global: { version: "v5.13.0" },
    AdbScreencapMethod: { Default: "7", EmulatorExtras: "64" },
    AdbInputMethod: { Default: "7", AdbShell: "1", EmulatorExtras: "8" },
    AdbController: class {
      connected = connected;
      constructor(...args: unknown[]) {
        constructed(...args);
      }
      post_connection = () => ({
        wait: async () => ({ succeeded: connected }),
      });
      post_start_app = startApp;
      destroy = destroy;
    },
  });
  return { constructed, destroy, startApp };
}

it("binds both native channels to the exact MuMu instance and current package", async () => {
  const { constructed, startApp } = native();
  const resolver = vi.fn(async () => metadata);
  const waits: { operation: string; phase: string }[] = [];
  const engine = new MaaEngine((wait) => waits.push(wait), resolver);
  await engine.connect(device);
  const args = constructed.mock.calls[0];
  expect(args.slice(0, 4)).toEqual([device.adbPath, device.address, "64", "8"]);
  expect(JSON.parse(args[4] as string)).toEqual({
    extras: {
      mumu: {
        enable: true,
        path: metadata.path,
        index: 1,
        lib: metadata.libraryPath,
        app_package: "com.example.game",
        app_cloned_index: 0,
      },
    },
  });
  expect(resolver).toHaveBeenCalledWith(device);
  expect(waits).toEqual([
    expect.objectContaining({ operation: "connection", phase: "begin" }),
    expect.objectContaining({ operation: "connection", phase: "end" }),
  ]);
  await engine.startApp("com.example.other", new AbortController().signal);
  expect(startApp).toHaveBeenCalledWith("com.example.other");
});

it("does not create a desktop fallback when MuMu metadata resolution fails", async () => {
  const { constructed } = native();
  const engine = new MaaEngine(undefined, async () => {
    throw Error("MuMu SDK missing");
  });
  await expect(engine.connect(device)).rejects.toThrow("SDK");
  expect(constructed).not.toHaveBeenCalled();
});

it("preserves discovered non-MuMu methods and configuration", async () => {
  const { constructed } = native();
  const engine = new MaaEngine(undefined, async () => undefined);
  const target = {
    name: "Android",
    adbPath: "D:/platform-tools/adb.exe",
    address: "phone",
  };
  Object.assign(engine, {
    detected: new Map([
      [
        `${target.adbPath}|${target.address}`,
        [
          target.name,
          target.adbPath,
          target.address,
          "2",
          "4",
          '{"keep":true}',
        ],
      ],
    ]),
  });
  await engine.connect(target);
  expect(constructed).toHaveBeenCalledWith(
    target.adbPath,
    target.address,
    "2",
    "4",
    '{"keep":true}',
  );
});

it("destroys an explicitly configured MuMu controller after a failed native connection", async () => {
  const { destroy } = native(false);
  const engine = new MaaEngine(undefined, async () => metadata);
  await expect(engine.connect(device)).rejects.toMatchObject({
    code: "connection-unavailable",
  });
  expect(destroy).toHaveBeenCalledOnce();
});
