import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { RunEvent } from "../packages/protocol";
import { validFailureEvidence } from "../packages/protocol/fault";

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("electron", () => ({ utilityProcess: { fork } }));
import { WorkerClient } from "../apps/desktop/main/worker-client";
class Child extends EventEmitter {
  sent: { id: string; method: string }[] = [];
  killed = false;
  postMessage(message: { id: string; method: string }) {
    this.sent.push(message);
  }
  kill() {
    this.killed = true;
    return true;
  }
}
afterEach(() => {
  vi.useRealTimers();
  fork.mockReset();
});
describe("isolated worker recovery", () => {
  it("publishes exit isolation before a timeout terminal event and clears it only on exit", async () => {
    const { child, client, emit, ready } = onmyojiRun();
    await ready;
    const order: string[] = [];
    expect(client.exitPending).toBe(false);
    client.on("terminating", () => {
      expect(client.exitPending).toBe(true);
      order.push("terminating");
    });
    client.on("event", (event) => {
      if (event.status === "failed") {
        expect(client.exitPending).toBe(true);
        order.push("failed");
      }
    });
    client.on("exit", () => {
      expect(client.exitPending).toBe(false);
      order.push("exit");
    });
    emit({ type: "step", skillId: "login", stepStatus: "running" });
    child.emit("message", {
      nativeWait: { id: "shot-1", operation: "screencap", phase: "begin" },
    });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(order).toEqual(["terminating", "failed"]);
    client.close();
    expect(client.exitPending).toBe(true);
    expect(order).toHaveLength(2);
    child.emit("exit", 1);
    expect(order).toEqual(["terminating", "failed", "exit"]);
  });
  it("bounds a native screencap after start has returned and blocks reuse until real exit", async () => {
    const { child, client, emit, events, ready } = onmyojiRun();
    await ready;
    emit({ type: "step", skillId: "login", stepStatus: "running" });
    child.emit("message", {
      nativeWait: { id: "shot-1", operation: "screencap", phase: "begin" },
    });
    await vi.advanceTimersByTimeAsync(14_000);
    child.emit("message", {
      nativeWait: { id: "shot-1", operation: "screencap", phase: "begin" },
    });
    child.emit("message", {
      nativeWait: { id: "other-shot", operation: "screencap", phase: "end" },
    });
    child.emit("message", {
      nativeWait: { id: "shot-1", operation: "recognition", phase: "end" },
    });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(child.killed).toBe(true);
    expect(events.at(-1)).toMatchObject({
      status: "failed",
      resultUncertain: true,
      fault: {
        source: "watchdog",
        code: "worker-native-timeout",
        skillId: "login",
        capture: { status: "not-attempted" },
      },
    });
    expect(events.at(-1)?.message).toContain("截图");
    expect(validFailureEvidence(events.at(-1)?.fault)).toBe(true);
    expect(() => client.request("ping")).toThrow(/终止/);
    emit({ type: "status", status: "succeeded" });
    expect(events.at(-1)?.status).toBe("failed");
    child.emit("exit", 1);
    client.close();
  });
  it("clears only the matching native deadline after completion", async () => {
    const { child, client, ready } = onmyojiRun();
    await ready;
    child.emit("message", {
      nativeWait: { id: "shot-1", operation: "screencap", phase: "begin" },
    });
    await vi.advanceTimersByTimeAsync(14_000);
    child.emit("message", {
      nativeWait: { id: "shot-1", operation: "screencap", phase: "end" },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.killed).toBe(false);
    client.close();
  });
  it.each(["close", "timeout", "kill-false", "kill-throws"])(
    "never releases a worker without exit after %s",
    async (kind) => {
      vi.useFakeTimers();
      const child = new Child();
      fork.mockReturnValue(child);
      const client = new WorkerClient("worker.cjs", "data");
      const ping = client.request("ping");
      child.emit("message", { id: child.sent[0].id, result: true });
      await ping;
      if (kind === "kill-throws")
        vi.spyOn(child, "kill").mockImplementation(() => {
          throw Error("kill failed");
        });
      if (kind === "kill-false") vi.spyOn(child, "kill").mockReturnValue(false);
      if (kind === "close") client.close();
      const failed = expect(client.closeAndWait(100)).rejects.toThrow(
        /退出未确认/,
      );
      await vi.advanceTimersByTimeAsync(101);
      await failed;
      expect(() => client.request("ping")).toThrow(/终止/);
      const disposal = client.closeAndWait(100);
      let confirmed = false;
      void disposal.then(() => {
        confirmed = true;
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(confirmed).toBe(false);
      child.emit("exit", 1);
      await disposal;
      expect(confirmed).toBe(true);
      expect(fork).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["connection", "discovery", "resource", "recognition", "input"])(
    "bounds a stalled native %s and rejects all pending RPCs",
    async (operation) => {
      vi.useFakeTimers();
      const child = new Child();
      fork.mockReturnValue(child);
      const client = new WorkerClient("worker.cjs", "data");
      const one = client.request("capture").catch((error) => error);
      const two = client.request("info").catch((error) => error);
      child.emit("message", {
        nativeWait: { id: "native-1", operation, phase: "begin" },
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(child.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(child.killed).toBe(true);
      expect(await one).toMatchObject({
        message: expect.stringMatching(/等待超过 30 秒/),
      });
      expect(await two).toMatchObject({
        message: expect.stringMatching(/等待超过 30 秒/),
      });
      expect(() => client.request("capture")).toThrow(/终止/);
      child.emit("exit", 1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("coalesces concurrent shutdown requests and accepts a late exit after watchdog timeout", async () => {
    vi.useFakeTimers();
    const first = new Child(),
      second = new Child();
    fork.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const client = new WorkerClient("worker.cjs", "data");
    const pending = client
      .request("capture", undefined, 20)
      .catch((error) => error);
    const kill = vi.spyOn(first, "kill");
    await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toMatchObject({
      message: expect.stringContaining("超时"),
    });
    const one = client.closeAndWait(100).catch((error) => error);
    const two = client.closeAndWait(200);
    await vi.advanceTimersByTimeAsync(101);
    expect((await one).message).toContain("退出未确认");
    expect(kill).toHaveBeenCalledTimes(1);
    expect(() => client.request("ping")).toThrow(/终止/);
    first.emit("exit", 1);
    await two;
    const next = client.request("ping");
    first.emit("message", {
      nativeWait: { id: "late", operation: "screencap", phase: "begin" },
    });
    second.emit("message", { id: second.sent[0].id, result: true });
    await next;
    await vi.advanceTimersByTimeAsync(15_001);
    expect(second.killed).toBe(false);
    client.close();
    second.emit("exit", 0);
  });
  it("waits for a real exit before confirming disposal and rejects a kill without exit", async () => {
    vi.useFakeTimers();
    const child = new Child();
    fork.mockReturnValue(child);
    const client = new WorkerClient("worker.cjs", "data");
    const ready = client.request("ping");
    child.emit("message", { id: child.sent[0].id, result: true });
    await ready;
    const disposed = client.closeAndWait(1000);
    let done = false;
    void disposed.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(child.killed).toBe(true);
    expect(done).toBe(false);
    child.emit("exit", 0);
    await disposed;
    expect(done).toBe(true);
    const other = new Child();
    fork.mockReturnValue(other);
    const next = new WorkerClient("worker.cjs", "data");
    const ping = next.request("ping");
    other.emit("message", { id: other.sent[0].id, result: true });
    await ping;
    const pending = expect(next.closeAndWait(100)).rejects.toThrow(
      /退出未确认/,
    );
    await vi.advanceTimersByTimeAsync(101);
    await pending;
  });
  function onmyojiRun() {
    vi.useFakeTimers();
    const child = new Child();
    fork.mockReturnValue(child);
    const client = new WorkerClient("worker.cjs", "data");
    const events: RunEvent[] = [];
    client.on("event", (e) => events.push(e));
    const ready = client.request("ping");
    child.emit("message", { id: child.sent[0].id, result: true });
    const emit = (e: Partial<RunEvent>) =>
      child.emit("message", {
        event: {
          runId: "yys",
          gameId: "onmyoji",
          at: new Date().toISOString(),
          message: "",
          ...e,
        },
      });
    emit({
      type: "status",
      status: "queued",
      plan: {
        gameId: "onmyoji",
        mode: "live",
        skillIds: ["login", "foster", "hana-claim"],
      },
    });
    return { child, client, events, emit, ready };
  }
  it("gives foster its own budget after earlier steps instead of killing the plan at 12 minutes", async () => {
    const { child, client, emit, ready } = onmyojiRun();
    await ready;
    emit({ type: "step", skillId: "login", stepStatus: "running" });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    emit({ type: "step", skillId: "login", stepStatus: "succeeded" });
    emit({ type: "step", skillId: "foster", stepStatus: "running" });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(child.killed).toBe(false);
    emit({ type: "step", skillId: "foster", stepStatus: "succeeded" });
    emit({ type: "step", skillId: "hana-claim", stepStatus: "running" });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    emit({ type: "status", status: "succeeded" });
    await vi.advanceTimersByTimeAsync(120 * 60_000);
    expect(child.killed).toBe(false);
    client.close();
  });
  it("does not let repeated progress or a foreign terminal event renew a stuck step", async () => {
    const { child, client, emit, events, ready } = onmyojiRun();
    await ready;
    emit({ type: "step", skillId: "foster", stepStatus: "running" });
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    emit({ type: "log", skillId: "foster", message: "扫描中" });
    emit({ type: "step", skillId: "foster", stepStatus: "running" });
    emit({ type: "status", status: "running" });
    emit({ type: "status", runId: "old-run", status: "succeeded" });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(child.killed).toBe(true);
    expect(events.at(-1)?.fault).toMatchObject({
      code: "worker-run-timeout",
      skillId: "foster",
    });
    client.close();
  });
  it("still bounds the whole plan when no step events arrive", async () => {
    const { child, client, ready } = onmyojiRun();
    await ready;
    await vi.advanceTimersByTimeAsync(42 * 60_000);
    expect(child.killed).toBe(true);
    client.close();
  });
  it.each(["run", "rpc", "exit"])(
    "records a structured %s failure without attempting capture after worker termination",
    async (kind) => {
      vi.useFakeTimers();
      const child = new Child();
      fork.mockReturnValue(child);
      const client = new WorkerClient("worker.cjs", "data", 1000),
        events: RunEvent[] = [];
      client.on("event", (e) => events.push(e));
      const request = client
        .request("start", undefined, kind === "rpc" ? 100 : 5000)
        .catch(() => undefined);
      child.emit("message", {
        event: {
          runId: "test-run",
          gameId: "onmyoji",
          type: "status",
          status: "running",
          at: new Date().toISOString(),
          message: "",
        },
      });
      if (kind === "exit") child.emit("exit", 1);
      else await vi.advanceTimersByTimeAsync(kind === "rpc" ? 101 : 1001);
      expect(events.at(-1)?.fault).toMatchObject({
        runId: "test-run",
        source: "watchdog",
        code:
          kind === "run"
            ? "worker-run-timeout"
            : kind === "rpc"
              ? "worker-rpc-timeout"
              : "worker-exited",
        capture: { status: "not-attempted" },
      });
      expect(events.at(-1)?.resultUncertain).toBe(true);
      await request;
      client.close();
    },
  );
  it("preserves only the allowed connection failure code across IPC", async () => {
    const child = new Child();
    fork.mockReturnValue(child);
    const client = new WorkerClient("worker.cjs", "data");
    const failed = client.request("connect").catch((error) => error);
    child.emit("message", {
      id: child.sent[0].id,
      error: "offline",
      errorCode: "connection-unavailable",
    });
    expect(await failed).toMatchObject({
      code: "connection-unavailable",
      message: "offline",
    });
    const unknown = client.request("connect").catch((error) => error);
    child.emit("message", {
      id: child.sent[1].id,
      error: "unknown",
      errorCode: "retry-everything",
    });
    expect(await unknown).not.toHaveProperty("code");
    client.close();
  });
  it("honors the Arknights runtime limit and emits exit only after the process exits", async () => {
    vi.useFakeTimers();
    const child = new Child();
    fork.mockReturnValue(child);
    const client = new WorkerClient("worker.cjs", "data");
    const exits = vi.fn();
    client.on("exit", exits);
    const config = client.request("arknights-config", { maxRunMinutes: 30 });
    child.emit("message", { id: child.sent[0].id, result: null });
    await config;
    child.emit("message", {
      event: {
        runId: "ark",
        gameId: "arknights",
        type: "status",
        status: "running",
        at: "",
        message: "",
      },
    });
    await vi.advanceTimersByTimeAsync(13 * 60_000);
    expect(child.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(19 * 60_000);
    expect(child.killed).toBe(true);
    expect(exits).not.toHaveBeenCalled();
    child.emit("exit", 1);
    expect(exits).toHaveBeenCalledTimes(1);
    client.close();
  });
  it("rejects every pending request on exit, fails active work and allows restart", async () => {
    const first = new Child(),
      second = new Child();
    fork.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const client = new WorkerClient("worker.cjs", "data"),
      events: RunEvent[] = [];
    client.on("event", (e) => events.push(e));
    const one = client.request("info"),
      two = client.request("capture");
    const failures = Promise.all([
      expect(one).rejects.toThrow("退出"),
      expect(two).rejects.toThrow("退出"),
    ]);
    first.emit("message", {
      event: {
        runId: "run-1",
        type: "status",
        status: "running",
        at: "",
        message: "",
      },
    });
    first.emit("exit", 1);
    await failures;
    expect(events.at(-1)?.status).toBe("failed");
    const recovered = client.request("ping");
    second.emit("message", { id: second.sent[0].id, result: { protocol: 1 } });
    expect(await recovered).toEqual({ protocol: 1 });
    expect(fork).toHaveBeenCalledTimes(2);
    client.close();
  });
  it("waits for a timed-out worker exit before allowing a replacement", async () => {
    vi.useFakeTimers();
    const first = new Child(),
      second = new Child();
    fork.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const client = new WorkerClient("worker.cjs", "data");
    const pending = client.request("capture", undefined, 20);
    const rejected = expect(pending).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    expect(first.killed).toBe(true);
    expect(() => client.request("ping")).toThrow("终止");
    first.emit("exit", 1);
    const next = client.request("ping");
    first.emit("exit", 1);
    second.emit("message", { id: second.sent[0].id, result: "ready" });
    expect(await next).toBe("ready");
    client.close();
  });
  it("supervises a running job after its start RPC has returned", async () => {
    vi.useFakeTimers();
    const first = new Child(),
      second = new Child();
    fork.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const client = new WorkerClient("worker.cjs", "data", 40),
      events: RunEvent[] = [];
    client.on("event", (e) => events.push(e));
    const start = client.request("start");
    first.emit("message", { id: first.sent[0].id, result: { runId: "r" } });
    await start;
    first.emit("message", {
      event: {
        runId: "r",
        type: "status",
        status: "running",
        at: "",
        message: "",
      },
    });
    await vi.advanceTimersByTimeAsync(41);
    expect(first.killed).toBe(true);
    expect(events.at(-1)?.message).toContain("超时");
    expect(() => client.request("start")).toThrow("终止");
    first.emit("exit", 1);
    const next = client.request("ping");
    first.emit("message", {
      event: {
        runId: "r",
        type: "status",
        status: "succeeded",
        at: "",
        message: "late",
      },
    });
    expect(events.at(-1)?.status).toBe("failed");
    second.emit("message", { id: second.sent[0].id, result: "ready" });
    expect(await next).toBe("ready");
    client.close();
  });
  it("routes responses by request ID rather than arrival order", async () => {
    const child = new Child();
    fork.mockReturnValue(child);
    const client = new WorkerClient("worker.cjs", "data");
    const one = client.request("one"),
      two = client.request("two");
    child.emit("message", { id: child.sent[1].id, result: 2 });
    child.emit("message", { id: child.sent[0].id, error: "failed action" });
    await expect(one).rejects.toThrow("failed action");
    expect(await two).toBe(2);
    client.close();
  });
});
