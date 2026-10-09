import { expect, it } from "vitest";
import { checkDeviceReady } from "../packages/runtime/device-ready";
const device = { name: "test", adbPath: "adb.exe", address: "127.0.0.1:16384" };
it("checks the exact target transport and Android boot before retry", async () => {
  const calls: string[][] = [];
  await checkDeviceReady(
    device,
    new AbortController().signal,
    async (_file, args) => {
      calls.push(args);
      return args.includes("get-state") ? "device\n" : "1\n";
    },
  );
  expect(calls).toEqual([
    ["-s", device.address, "get-state"],
    ["-s", device.address, "shell", "getprop", "sys.boot_completed"],
  ]);
});
it("marks only known offline or not-ready observations as recoverable", async () => {
  await expect(
    checkDeviceReady(
      device,
      new AbortController().signal,
      async () => "offline\n",
    ),
  ).rejects.toMatchObject({ code: "connection-unavailable" });
  await expect(
    checkDeviceReady(device, new AbortController().signal, async () => {
      throw Object.assign(Error("offline"), {
        stderr: "error: device offline",
      });
    }),
  ).rejects.toMatchObject({ code: "connection-unavailable" });
  await expect(
    checkDeviceReady(
      device,
      new AbortController().signal,
      async (_file, args) => (args.includes("get-state") ? "device" : "0"),
    ),
  ).rejects.toMatchObject({ code: "connection-unavailable" });
});
it("preserves unknown errors and never probes after cancellation", async () => {
  const error = Object.assign(Error("missing executable"), { code: "ENOENT" });
  await expect(
    checkDeviceReady(device, new AbortController().signal, async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  let calls = 0;
  await expect(
    checkDeviceReady(device, AbortSignal.abort(), async () => {
      calls++;
      return "device";
    }),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
