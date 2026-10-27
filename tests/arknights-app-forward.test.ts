import { expect, it, vi } from "vitest";
import { runSavedArknightsChannel } from "../scripts/shared/arknights-app.mjs";
import { LocalControlError } from "../scripts/agent/local-control-client.mjs";
it("waits for the exact durable App outcome and never treats admission as completion", async () => {
  const calls: string[] = [];
  let polls = 0;
  const request = vi.fn(async (_data: string, method: string, input: any) => {
    calls.push(method);
    return method === "arknights-run-channel"
      ? { ok: true, result: { batchId: input.requestId } }
      : {
          ok: true,
          result: {
            batchId: input.batchId,
            laneId: input.laneId,
            status: ++polls === 1 ? "running" : "failed",
            message: "native error",
          },
        };
  });
  const result = await runSavedArknightsChannel("fixture", "ark-a", {
    requestId: "stable",
    request,
    pause: async () => {},
  });
  expect(result.status).toBe("failed");
  expect(calls).toEqual([
    "arknights-run-channel",
    "arknights-run-status",
    "arknights-run-status",
  ]);
});
it("does not resubmit after an uncertain admission or a mismatched status receipt", async () => {
  const request = vi.fn(async () => ({
    ok: false,
    error: { code: "TIMEOUT", message: "uncertain", outcomeUnknown: true },
  }));
  await expect(
    runSavedArknightsChannel("fixture", "ark-a", {
      requestId: "stable",
      request,
    }),
  ).rejects.toMatchObject({ outcomeUnknown: true });
  expect(request).toHaveBeenCalledTimes(1);
  const wrong = vi.fn(async (_data: string, method: string) => ({
    ok: true,
    result:
      method === "arknights-run-channel"
        ? { batchId: "stable" }
        : { batchId: "other", laneId: "ark-a", status: "succeeded" },
  }));
  await expect(
    runSavedArknightsChannel("fixture", "ark-a", {
      requestId: "stable",
      request: wrong,
    }),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  expect(wrong).toHaveBeenCalledTimes(2);
});
it("returns an explicitly requested admission receipt without inventing a terminal status", async () => {
  const request = vi.fn(async () => ({
    ok: true,
    result: { batchId: "stable" },
  }));
  expect(
    await runSavedArknightsChannel("fixture", "ark-a", {
      requestId: "stable",
      wait: false,
      request,
    }),
  ).toEqual({ batchId: "stable" });
  expect(request).toHaveBeenCalledTimes(1);
});

it("keeps an admitted game uncertain when a read-only status transport fails", async () => {
  const request = vi.fn(async (_data: string, method: string) => {
    if (method === "arknights-run-channel")
      return { ok: true, result: { batchId: "stable" } };
    throw new LocalControlError(
      "CONNECTION_FAILED",
      "status pipe closed",
      false,
    );
  });
  await expect(
    runSavedArknightsChannel("fixture", "ark-a", {
      requestId: "stable",
      request,
    }),
  ).rejects.toMatchObject({ code: "CONNECTION_FAILED", outcomeUnknown: true });
  expect(request.mock.calls.map(([, method]) => method)).toEqual([
    "arknights-run-channel",
    "arknights-run-status",
  ]);
});

it("only cancels waiting after admission and never sends a game stop or resubmission", async () => {
  const controller = new AbortController();
  const request = vi.fn(async (_data: string, method: string) => ({
    ok: true,
    result:
      method === "arknights-run-channel"
        ? { batchId: "stable" }
        : { batchId: "stable", laneId: "ark-a", status: "running" },
  }));
  const waiting = runSavedArknightsChannel("fixture", "ark-a", {
    requestId: "stable",
    signal: controller.signal,
    request,
    pause: async () => {
      controller.abort();
      throw controller.signal.reason;
    },
  });
  await expect(waiting).rejects.toMatchObject({
    code: "CANCELLED",
    outcomeUnknown: true,
  });
  expect(request.mock.calls.map(([, method]) => method)).toEqual([
    "arknights-run-channel",
    "arknights-run-status",
  ]);
});
