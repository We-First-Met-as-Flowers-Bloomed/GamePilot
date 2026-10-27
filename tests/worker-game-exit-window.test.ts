import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { expect, it, vi } from "vitest";
import { validExitObservation } from "../packages/protocol/execution-observation";
import type { ExecutionRecord } from "../packages/protocol/execution";

// Execute the production IPC branch without importing the native worker bootstrap.
const text = readFileSync("packages/runtime/worker.ts", "utf8");
const start = text.indexOf('    case "arknights-close":');
const end = text.indexOf('    case "ping":', start);
if (start < 0 || end < 0) throw Error("Worker close branch missing");
const branch = transformSync(
  `(async()=>{switch('arknights-close'){${text.slice(start, end)}}})()`,
  { loader: "ts", target: "node22" },
).code;
function run(readDelays: number[], running: boolean[] = []) {
  const startedAt = new Date().toISOString();
  let now = Date.now(),
    reads = 0;
  class ClockDate extends Date {
    constructor() {
      super(now);
    }
    static now() {
      return now;
    }
  }
  const connectedDevice = {
    name: "test",
    adbPath: "D:/MuMu/adb.exe",
    address: "127.0.0.1:16384",
  };
  const stop = vi.fn(async () => {});
  const result = runInNewContext(branch, {
    connectedDevice,
    arknightsConfig: {},
    arknightsPackage: () => "com.hypergryph.arknights",
    executeFile: stop,
    appProcessRunning: async () => {
      const i = reads++;
      now += readDelays[Math.min(i, readDelays.length - 1)];
      return running[i] ?? false;
    },
    deviceOperation: (f: () => unknown) => f(),
    delay: async (ms: number) => {
      now += ms;
    },
    Date: ClockDate,
    AbortController,
  });
  const record = {
    id: "exit",
    fingerprint: "proof",
    source: "daily",
    version: 1,
    status: "running",
    startedAt,
    message: "",
    resources: [],
    snapshot: { device: connectedDevice },
  } as ExecutionRecord;
  return { result, stop, reads: () => reads, record };
}
it("re-observes a slow ADB exit pair until it fits the unchanged five-second protocol window", async () => {
  const h = run([0, 6000, 0]);
  const proof = await h.result;
  expect(h.reads()).toBe(3);
  expect(
    validExitObservation(
      { ...proof, executionId: "exit", fingerprint: "proof" },
      h.record,
    ),
  ).toBe(true);
  expect(h.stop).toHaveBeenCalledOnce();
});
it("retains a normal fast pair and resets when the process reappears", async () => {
  for (const running of [
    [false, false],
    [false, true, false, false],
  ]) {
    const h = run([0], running);
    const proof = await h.result;
    expect(h.reads()).toBe(running.length);
    expect(
      validExitObservation(
        { ...proof, executionId: "exit", fingerprint: "proof" },
        h.record,
      ),
    ).toBe(true);
  }
});
it("does not emit invalid exit proof if all ADB checks are slow", async () => {
  const h = run([6000]);
  await expect(h.result).rejects.toThrow();
  expect(h.stop).toHaveBeenCalledOnce();
  expect(h.reads()).toBe(8);
});
