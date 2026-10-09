import { expect, it, vi } from "vitest";
import { AgentToolError } from "../packages/protocol/agent";
import { createDshRuntime } from "../packages/agent/dsh/adapter";
import {
  isUnconfirmedRuntimeShutdown,
  retryableRuntimeClose,
} from "../packages/agent/runtime-lifecycle";

it.each(["SHUTDOWN_FAILED", "DSH_REAP_FAILED"])(
  "recognizes unconfirmed process exit from %s",
  (code) => {
    expect(
      isUnconfirmedRuntimeShutdown(new AgentToolError(code, "退出未确认")),
    ).toBe(true);
  },
);

it.each(["CANCELLED", "TIMEOUT", "MODEL_FAILED", "PROTOCOL_ERROR"])(
  "does not infer a live process from ordinary %s failure",
  (code) => {
    expect(
      isUnconfirmedRuntimeShutdown(new AgentToolError(code, "运行失败")),
    ).toBe(false);
  },
);

it("retries failed cleanup while keeping the runtime closed to new work", async () => {
  let closed = false;
  const cleanup = vi.fn(async () => {
    closed = true;
    if (cleanup.mock.calls.length === 1)
      throw new AgentToolError("DSH_REAP_FAILED", "退出未确认");
  });
  const close = retryableRuntimeClose(cleanup);
  await expect(close()).rejects.toMatchObject({ code: "DSH_REAP_FAILED" });
  expect(closed).toBe(true);
  await expect(close()).resolves.toBeUndefined();
  await close();
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(closed).toBe(true);
});

it("shares an in-flight cleanup before and after a failed attempt", async () => {
  let release!: () => void;
  const cleanup = vi.fn(async () => {
    await new Promise<void>((done) => {
      release = done;
    });
    if (cleanup.mock.calls.length === 1)
      throw new AgentToolError("DSH_REAP_FAILED", "退出未确认");
  });
  const close = retryableRuntimeClose(cleanup);
  const first = close();
  expect(close()).toBe(first);
  const rejected = expect(first).rejects.toMatchObject({
    code: "DSH_REAP_FAILED",
  });
  release();
  await rejected;
  const retry = close();
  expect(close()).toBe(retry);
  expect(cleanup).toHaveBeenCalledTimes(2);
  release();
  await retry;
  expect(close()).toBe(retry);
});

it("keeps each unsuccessful retry visible and rejects synchronous cleanup failures", async () => {
  const cleanup = vi.fn(() => {
    throw new AgentToolError("DSH_REAP_FAILED", "退出未确认");
  });
  const close = retryableRuntimeClose(cleanup);
  await expect(close()).rejects.toMatchObject({ code: "DSH_REAP_FAILED" });
  await expect(close()).rejects.toMatchObject({ code: "DSH_REAP_FAILED" });
  expect(cleanup).toHaveBeenCalledTimes(2);
});

it("closes the actual DSH admission gate immediately and keeps successful close idempotent", async () => {
  const callTool = vi.fn();
  const runtime = createDshRuntime({
    connection: {
      baseUrl: "http://127.0.0.1:1",
      model: "unused-offline",
      apiKey: "unused-offline-key",
    },
    tools: [],
    callTool,
  });
  const closing = runtime.close();
  expect(runtime.close()).toBe(closing);
  await expect(
    runtime.run({ prompt: "closed runtime", at: "2026-10-07T00:00:00.000Z" }),
  ).rejects.toMatchObject({ code: "DSH_CLOSED" });
  await closing;
  expect(runtime.close()).toBe(closing);
  expect(callTool).not.toHaveBeenCalled();
});
