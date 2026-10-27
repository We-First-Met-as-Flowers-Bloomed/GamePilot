import { expect, it } from "vitest";
import { inspectDevice } from "../packages/runtime/device-inspection";
const device = { name: "MuMu", adbPath: "adb.exe", address: "127.0.0.1:16384" };
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
  "base64",
);
const singleWindow = "Display: mDisplayId=0\n mCurrentFocus=Window{abc u0 com.hypergryph.arknights/.MainActivity}\nmTopFocusedDisplayId=0";
const singleDisplay = "mViewports=[DisplayViewport{type=INTERNAL, valid=true, isActive=true, displayId=0, uniqueId='local:4619827820427265280', deviceWidth=1, deviceHeight=1}]";
it("reads only device state, foreground window and screenshot; never verifies account from a package", async () => {
  const calls: string[][] = [];
  const result = await inspectDevice(device, async (_file, args) => {
    calls.push(args);
    if (args.includes("get-state")) return Buffer.from("device\n");
    if (args.includes("getprop")) return Buffer.from("1\n");
    if (args.includes("window")) return Buffer.from(singleWindow);
    if (args.includes("display")) return Buffer.from(singleDisplay);
    return png;
  });
  expect(result.accountVerified).toBe(false);
  expect(result.foregroundPackage).toBe("com.hypergryph.arknights");
  expect(result.image).toMatch(/^data:image\/png;base64,/);
  expect(calls).toEqual([
    ["connect", device.address],
    ["-s", device.address, "get-state"],
    ["-s", device.address, "shell", "getprop", "sys.boot_completed"],
    ["-s", device.address, "shell", "dumpsys", "window"],
    ["-s", device.address, "shell", "dumpsys", "display"],
    ["-s", device.address, "exec-out", "screencap", "-p", "-d", "4619827820427265280"],
    ["-s", device.address, "shell", "dumpsys", "window"],
    ["-s", device.address, "shell", "dumpsys", "display"],
  ]);
});
it("stops on offline devices and rejects a non-image screenshot", async () => {
  await expect(
    inspectDevice(device, async () => Buffer.from("offline")),
  ).rejects.toThrow("设备");
  await expect(
    inspectDevice(device, async (_f, a) =>
      Buffer.from(
        a.includes("get-state")
          ? "device"
          : a.includes("getprop")
            ? "1"
            : a.includes("window") ? singleWindow : a.includes("display") ? singleDisplay : "invalid",
      ),
    ),
  ).rejects.toThrow("截图");
});
it("does not accept a PNG signature alone as a screenshot", async () => {
  await expect(
    inspectDevice(device, async (_f, a) =>
      a.includes("screencap")
        ? Buffer.from("89504e470d0a1a0a", "hex")
        : Buffer.from(
            a.includes("get-state")
              ? "device"
              : a.includes("getprop")
                ? "1"
                : a.includes("window") ? singleWindow : a.includes("display") ? singleDisplay : "",
          ),
    ),
  ).rejects.toThrow("截图");
});

const multiWindow = `Display: mDisplayId=0
  mCurrentFocus=Window{a u0 com.mumu.launcher/.Launcher}
Display: mDisplayId=2
  mCurrentFocus=Window{b u0 com.hypergryph.arknights/.MainActivity}
mTopFocusedDisplayId=2`;
const multiDisplay = `mViewports=[DisplayViewport{type=INTERNAL, valid=true, isActive=true, displayId=0, uniqueId='local:4619827820427265280', deviceWidth=1, deviceHeight=1}, DisplayViewport{type=INTERNAL, valid=true, isActive=true, displayId=2, uniqueId='local:4619827767814508545', deviceWidth=1, deviceHeight=1}]`;

it("captures the focused game display without accepting a warning-prefixed desktop PNG", async () => {
  const calls: string[][] = [];
  const result = await inspectDevice(device, async (_file, args) => {
    calls.push(args);
    if (args.includes("get-state")) return Buffer.from("device\n");
    if (args.includes("getprop")) return Buffer.from("1\n");
    if (args.includes("window")) return Buffer.from(multiWindow);
    if (args.includes("display")) return Buffer.from(multiDisplay);
    if (args.includes("screencap"))
      return args.includes("4619827767814508545")
        ? png
        : Buffer.concat([Buffer.from("[Warning] Multiple displays were found\n"), png]);
    return Buffer.alloc(0);
  });
  expect(result.foregroundPackage).toBe("com.hypergryph.arknights");
  expect(result.image).toBe(`data:image/png;base64,${png.toString("base64")}`);
  expect(calls.find((args) => args.includes("screencap"))).toEqual([
    "-s", device.address, "exec-out", "screencap", "-p", "-d", "4619827767814508545",
  ]);
});

it("discards an image when the focused display changes during capture", async () => {
  let captured = false;
  await expect(inspectDevice(device, async (_file, args) => {
    if (args.includes("get-state")) return Buffer.from("device\n");
    if (args.includes("getprop")) return Buffer.from("1\n");
    if (args.includes("window")) return Buffer.from(
      captured ? multiWindow.replace("mTopFocusedDisplayId=2", "mTopFocusedDisplayId=0") : multiWindow,
    );
    if (args.includes("display")) return Buffer.from(multiDisplay);
    if (args.includes("screencap")) { captured = true; return png; }
    return Buffer.alloc(0);
  })).rejects.toThrow(/display|显示/i);
});


it("retries the readiness gate on transient adb offline (readiness retry)", async () => {
  const device = { name: "MuMu", adbPath: "adb.exe", address: "127.0.0.1:16416" };
  let stateCalls = 0;
  const result = await inspectDevice(
    device,
    async (_file, args) => {
      if (args.includes("get-state")) {
        stateCalls += 1;
        // 前两次瞬时 offline，第三次恢复
        return Buffer.from(stateCalls < 3 ? "offline\n" : "device\n");
      }
      if (args.includes("getprop")) return Buffer.from("1\n");
      if (args.includes("window")) return Buffer.from(singleWindow);
      if (args.includes("display")) return Buffer.from(singleDisplay);
      return png;
    },
    { attempts: 3, sleep: async () => {} },
  );
  expect(result.foregroundPackage).toBe("com.hypergryph.arknights");
  expect(stateCalls).toBe(3);
});

it("throws the last reason after exhausting readiness attempts", async () => {
  const device = { name: "MuMu", adbPath: "adb.exe", address: "127.0.0.1:16416" };
  let attempts = 0;
  await expect(
    inspectDevice(
      device,
      async (_file, args) => {
        if (args.includes("get-state")) {
          attempts += 1;
          return Buffer.from("offline\n");
        }
        return Buffer.from("");
      },
      { attempts: 3, sleep: async () => {} },
    ),
  ).rejects.toThrow("设备未就绪");
  expect(attempts).toBe(3);
});

it("does not retry a capture failure (display changed)", async () => {
  const device = { name: "MuMu", adbPath: "adb.exe", address: "127.0.0.1:16384" };
  let screens = 0;
  await expect(
    inspectDevice(
      device,
      async (_file, args) => {
        if (args.includes("get-state")) return Buffer.from("device\n");
        if (args.includes("getprop")) return Buffer.from("1\n");
        if (args.includes("window")) return Buffer.from(singleWindow);
        if (args.includes("display")) return Buffer.from(singleDisplay);
        screens += 1;
        // 第一次抓帧返回合法 PNG，第二次返回被截断的字节 → 抓帧校验失败
        return screens === 1 ? png : Buffer.from([0, 1, 2]);
      },
      { attempts: 3, sleep: async () => {} },
    ),
  ).rejects.toThrow();
});
