import { expect, it, vi } from "vitest";
import { appProcessRunning } from "../packages/runtime/app-process";
const device = { adbPath: "C:/adb.exe", address: "127.0.0.1:16384" };
const signal = new AbortController().signal;
it("accepts no-process only with quiet exit one and fresh connected checks", async () => {
  const run = vi
    .fn()
    .mockResolvedValueOnce({ stdout: "device\n", stderr: "" })
    .mockRejectedValueOnce({ code: 1, stdout: "", stderr: "" })
    .mockResolvedValueOnce({ stdout: "device\n", stderr: "" });
  expect(
    await appProcessRunning(device, "com.hypergryph.arknights", signal, run),
  ).toBe(false);
  expect(run.mock.calls.map((c) => c[1].slice(2))).toEqual([
    ["get-state"],
    ["shell", "pidof", "com.hypergryph.arknights"],
    ["get-state"],
  ]);
});
it("returns running only for valid positive process ids", async () => {
  const run = vi
    .fn()
    .mockResolvedValueOnce({ stdout: "device", stderr: "" })
    .mockResolvedValueOnce({ stdout: "124 567\n", stderr: "" })
    .mockResolvedValueOnce({ stdout: "device", stderr: "" });
  expect(
    await appProcessRunning(device, "com.hypergryph.arknights", signal, run),
  ).toBe(true);
});
it("never promotes ADB faults, invalid output, timeout or lost connectivity to exited", async () => {
  for (const value of [
    { code: 1, stdout: "", stderr: "error: device offline" },
    { code: 1, stdout: "", stderr: "error: unauthorized" },
    { code: "ETIMEDOUT", stdout: "", stderr: "" },
  ]) {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "device", stderr: "" })
      .mockRejectedValueOnce(value);
    await expect(
      appProcessRunning(device, "com.hypergryph.arknights", signal, run),
    ).rejects.toThrow();
  }
  for (const stdout of [
    "",
    "garbled",
    "0",
    "NaN",
    "123\n456",
    "99999999999999999999",
  ]) {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "device", stderr: "" })
      .mockResolvedValueOnce({ stdout, stderr: "" });
    await expect(
      appProcessRunning(device, "com.hypergryph.arknights", signal, run),
    ).rejects.toThrow();
  }
  const run = vi
    .fn()
    .mockResolvedValueOnce({ stdout: "device", stderr: "" })
    .mockRejectedValueOnce({ code: 1, stdout: "", stderr: "" })
    .mockResolvedValueOnce({ stdout: "offline", stderr: "" });
  await expect(
    appProcessRunning(device, "com.hypergryph.arknights", signal, run),
  ).rejects.toThrow();
});
it("does not run a process after cancellation or malformed package input", async () => {
  const run = vi.fn();
  const controller = new AbortController();
  controller.abort();
  await expect(
    appProcessRunning(
      device,
      "com.hypergryph.arknights",
      controller.signal,
      run,
    ),
  ).rejects.toThrow();
  await expect(
    appProcessRunning(device, "bad;command", signal, run),
  ).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});
