import { it, expect } from "vitest";
import { closeOwnedMuMu } from "../apps/desktop/main/mumu";
const owned = {
  managerPath: "D:\\MuMu\\MuMuManager.exe",
  instance: 0,
  startedByUs: true,
  pid: 123,
};
const info = (pid: number, running = true) =>
  JSON.stringify({
    index: "0",
    error_code: 0,
    is_process_started: running,
    is_android_started: false,
    pid,
  });
it("never shuts down a pre-existing emulator or an instance replaced by the user", async () => {
  const calls: string[][] = [];
  const run = async (_f: string, args: string[]) => {
    calls.push(args);
    return info(456);
  };
  expect(await closeOwnedMuMu({ ...owned, startedByUs: false }, run)).toBe(
    false,
  );
  expect(calls).toHaveLength(0);
  expect(await closeOwnedMuMu(owned, run)).toBe(false);
  expect(calls.every((a) => a[0] === "info")).toBe(true);
});
it("shuts down only the owned process and verifies that it stopped", async () => {
  const calls: string[][] = [];
  let shutdown = false;
  const run = async (_f: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "control") {
      shutdown = true;
      return '{"errcode":0}';
    }
    return info(123, !shutdown);
  };
  expect(await closeOwnedMuMu(owned, run)).toBe(true);
  expect(calls).toContainEqual(["control", "-v", "0", "shutdown"]);
});
it("reports management command failure instead of claiming shutdown", async () => {
  await expect(
    closeOwnedMuMu(owned, async (_f, a) =>
      a[0] === "info" ? info(123) : '{"errcode":7}',
    ),
  ).rejects.toThrow("关闭请求失败");
});
