import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
import { MaaCoreClient } from "../packages/runtime/maacore";

function fakeBridge() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 123,
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn(),
  });
  const requests: any[] = [];
  child.stdin.on("data", (data) => requests.push(JSON.parse(String(data))));
  spawn.mockReturnValue(child);
  return {
    child,
    requests,
    reply: (id: number, ok = true, result?: unknown, error?: string) =>
      child.stdout.write(JSON.stringify({ id, ok, result, error }) + "\n"),
  };
}
describe("MaaCore JSON process lifecycle", () => {
  beforeEach(() => spawn.mockReset());
  afterEach(() => vi.useRealTimers());
  it("binds MuMu capture and input to the configured instance and client", async () => {
    const f = fakeBridge();
    const c = new MaaCoreClient("bridge", "core", "logs", {clientType: "Bilibili"});
    const outcome = c.connect("D:\\MuMu\\nx_main\\adb.exe", "127.0.0.1:16416");
    f.reply(1, true, {version: "test"});
    await new Promise((done) => setImmediate(done));
    expect(f.requests[1]).toMatchObject({
      method: "connect", mumu: {path: "D:\\MuMu", index: 1, clientType: "Bilibili"},
    });
    f.reply(2);
    await outcome;
    f.child.exitCode = 0;
    f.child.emit("exit", 0);
    await c.close();
  });
  it.each([
    ["MaaCore connection failed", "connection-unavailable"],
    ["MaaCore connect timed out", "connection-unavailable"],
    ["MaaCore bridge exited (8)", undefined],
    ["Unexpected native exception", undefined],
  ])("classifies only known connect failure: %s", async (message, code) => {
    const f = fakeBridge();
    const c = new MaaCoreClient("bridge", "core", "logs");
    const info = c.info();
    f.reply(1, true, { version: "test" });
    await info;
    const outcome = c.connect("adb", "address").catch((error) => error);
    await Promise.resolve();
    f.reply(2, false, undefined, message);
    const error = await outcome;
    expect(error.message).toBe(message);
    expect(error.code).toBe(code);
    f.child.exitCode = 0;
    f.child.emit("exit", 0);
    await c.close();
  });
  it("does not classify init errors as safe connection failures", async () => {
    const f = fakeBridge();
    const c = new MaaCoreClient("bridge", "core", "logs");
    const outcome = c.connect("adb", "address").catch((error) => error);
    f.reply(1, false, undefined, "MaaCore connection failed");
    expect((await outcome).code).toBeUndefined();
    expect(f.requests.map((request) => request.method)).toEqual(["init"]);
    f.child.exitCode = 0;
    f.child.emit("exit", 0);
    await c.close();
  });
  it.each([
    [undefined, 120 * 60_000 + 60_000],
    [360 * 60_000 + 60_000, 360 * 60_000 + 60_000],
    [500, 500],
  ])(
    "uses request timeout %s and kills a timed-out bridge",
    async (timeout, expected) => {
      vi.useFakeTimers();
      const f = fakeBridge();
      f.child.kill.mockImplementation(() => {
        f.child.exitCode = 1;
        f.child.emit("exit", 1);
        return true;
      });
      const c = new MaaCoreClient("bridge", "core", "logs");
      const info = c.info();
      f.reply(1, true, { version: "test" });
      await info;
      const settled = vi.fn();
      const run = c.runTask(
        "Fight",
        {},
        new AbortController().signal,
        () => {},
        timeout,
      );
      const outcome = run.then(
        () => {
          settled();
          return null;
        },
        (error) => {
          settled();
          return error;
        },
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledOnce();
      expect((await outcome)?.message).toBe("MaaCore runTask timed out");
      expect(f.child.kill).toHaveBeenCalledOnce();
      await c.close();
      expect(f.requests.map((r) => r.method)).toEqual(["init", "runTask"]);
    },
  );
  it.each([0, -1, NaN, Infinity, 360 * 60_000 + 60_001])(
    "rejects invalid timeout %s before spawning",
    async (timeout) => {
      const f = fakeBridge();
      f.child.stdin.on("data", (data) => {
        const request = JSON.parse(String(data));
        f.reply(request.id, true, { version: "test" });
      });
      const c = new MaaCoreClient("bridge", "core", "logs");
      await expect(
        c.runTask("Fight", {}, new AbortController().signal, () => {}, timeout),
      ).rejects.toThrow(/timeout/i);
      expect(spawn).not.toHaveBeenCalled();
    },
  );
  it("holds cancellation until stop acknowledgement even if task rejects first", async () => {
    const f = fakeBridge();
    const c = new MaaCoreClient("bridge", "core", "logs");
    const info = c.info();
    f.reply(1, true, { version: "v6.17.5" });
    await info;
    const controller = new AbortController();
    const run = c.runTask("Award", {}, controller.signal, () => {});
    const settled = vi.fn();
    const result = run.catch((e) => {
      settled();
      return e;
    });
    await Promise.resolve();
    controller.abort();
    expect(f.requests.map((r) => r.method)).toEqual([
      "init",
      "runTask",
      "stop",
    ]);
    f.reply(2, false, undefined, "cancelled");
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    f.reply(3);
    expect((await result).message).toContain("cancelled");
    f.child.exitCode = 0;
    f.child.emit("exit", 0);
    await c.close();
  });
  it("rejects active work on unexpected child exit", async () => {
    const f = fakeBridge();
    const c = new MaaCoreClient("bridge", "core", "logs");
    const info = c.info();
    f.reply(1, true, { version: "v6.17.5" });
    await info;
    const run = c.runTask("Award", {}, new AbortController().signal, () => {});
    await Promise.resolve();
    f.child.exitCode = 8;
    f.child.emit("exit", 8);
    await expect(run).rejects.toThrow("exited (8)");
    await c.close();
  });
  it("retains native failure instead of interpreting a response as success", async () => {
    const f = fakeBridge();
    const c = new MaaCoreClient("bridge", "core", "logs");
    const info = c.info();
    f.reply(1, true, { version: "v6.17.5" });
    await info;
    const run = c.runTask("Award", {}, new AbortController().signal, () => {});
    await Promise.resolve();
    f.reply(2, false, undefined, "MaaCore task failed (10000)");
    await expect(run).rejects.toThrow("10000");
    f.child.exitCode = 0;
    f.child.emit("exit", 0);
    await c.close();
  });

  async function initializedBridge() {
    const fixture = fakeBridge();
    const client = new MaaCoreClient("bridge", "core", "logs");
    const info = client.info();
    fixture.reply(1, true, { version: "test" });
    await info;
    return { ...fixture, client };
  }

  it("coalesces simultaneous closes and waits for exit after the acknowledgement", async () => {
    vi.useFakeTimers();
    const f = await initializedBridge();
    const first = f.client.close();
    const second = f.client.close();
    expect(first).toBe(second);
    expect(f.requests.filter((r) => r.method === "close")).toHaveLength(1);
    f.reply(2);
    const settled = vi.fn();
    void first.then(settled);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.child.kill).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    f.child.exitCode = 0;
    f.child.emit("exit", 0);
    await first;
    await f.client.close();
    expect(f.requests.filter((r) => r.method === "close")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true, "throw", "error-event"])(
    "rejects unconfirmed exit after the final deadline (kill=%s)",
    async (killResult) => {
      vi.useFakeTimers();
      const f = await initializedBridge();
      f.child.kill.mockImplementation(() => {
        if (killResult === "throw") throw Error("Cannot kill process");
        if (killResult === "error-event")
          f.child.emit("error", Error("Kill denied"));
        return killResult === true;
      });
      let result: unknown = "pending";
      const closing = f.client.close().then(
        () => {
          result = "resolved";
        },
        (error) => {
          result = error;
        },
      );
      f.reply(2);
      await vi.advanceTimersByTimeAsync(4999);
      expect(result).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toBeInstanceOf(Error);
      await closing;
      expect((result as Error).message).toMatch(/exit.*unconfirmed/i);
      expect(f.child.listenerCount("exit")).toBe(1);
      expect(f.child.listenerCount("close")).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      await expect(f.client.close()).rejects.toThrow(/exit.*unconfirmed/i);
      // A later real exit can still settle a subsequent close without more RPC.
      f.child.emit("exit", 1);
      await expect(f.client.close()).resolves.toBeUndefined();
      expect(f.requests.filter((r) => r.method === "close")).toHaveLength(1);
    },
  );

  it("does not mistake a post-spawn error for process exit before close", async () => {
    vi.useFakeTimers();
    const f = await initializedBridge();
    f.child.emit("error", Error("Process kill failed"));
    let result: unknown = "pending";
    const closing = f.client.close().then(
      () => {
        result = "resolved";
      },
      (error) => {
        result = error;
      },
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(result).toBeInstanceOf(Error);
    await closing;
    expect((result as Error).message).toMatch(/exit.*unconfirmed/i);
    expect(f.requests.map((r) => r.method)).toEqual(["init"]);
  });

  it.each([false, "throw", "error-event"])(
    "bounds the whole close even when its RPC never replies (kill=%s)",
    async (killResult) => {
      vi.useFakeTimers();
      const f = await initializedBridge();
      f.child.kill.mockImplementation(() => {
        if (killResult === "throw") throw Error("Cannot kill process");
        if (killResult === "error-event")
          f.child.emit("error", Error("Kill denied"));
        return false;
      });
      let result: unknown = "pending";
      const closing = f.client.close().then(
        () => {
          result = "resolved";
        },
        (error) => {
          result = error;
        },
      );
      await vi.advanceTimersByTimeAsync(34999);
      expect(result).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toBeInstanceOf(Error);
      await closing;
      expect((result as Error).message).toMatch(/exit.*unconfirmed/i);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not admit another native operation while close is pending", async () => {
    vi.useFakeTimers();
    const f = await initializedBridge();
    const closing = f.client.close();
    const connecting = f.client.connect("adb", "address");
    await Promise.resolve();
    f.reply(3);
    await expect(connecting).rejects.toThrow(/closing/i);
    expect(f.requests.map((r) => r.method)).toEqual(["init", "close"]);
    f.child.exitCode = 0;
    f.child.emit("exit", 0);
    await closing;
  });
});
