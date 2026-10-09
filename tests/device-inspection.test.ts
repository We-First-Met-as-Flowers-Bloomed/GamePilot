import { expect, it } from "vitest";
import { inspectDevice } from "../packages/runtime/device-inspection";
const device = { name: "MuMu", adbPath: "adb.exe", address: "127.0.0.1:16384" };
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
  "base64",
);
it("reads only device state, foreground window and screenshot; never verifies account from a package", async () => {
  const calls: string[][] = [];
  const result = await inspectDevice(device, async (_file, args) => {
    calls.push(args);
    if (args.includes("get-state")) return Buffer.from("device\n");
    if (args.includes("getprop")) return Buffer.from("1\n");
    if (args.includes("dumpsys"))
      return Buffer.from(
        "mCurrentFocus=Window{abc u0 com.hypergryph.arknights/.MainActivity}",
      );
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
    ["-s", device.address, "exec-out", "screencap", "-p"],
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
            : "invalid",
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
                : "",
          ),
    ),
  ).rejects.toThrow("截图");
});
