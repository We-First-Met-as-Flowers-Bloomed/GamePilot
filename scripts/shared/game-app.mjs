import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  requestLocalControl,
  LocalControlError,
} from "../agent/local-control-client.mjs";

/** A compatibility caller submits once and observes the App's exact durable request. */
export async function runSavedGameChannel(
  profileDir,
  laneId,
  gameId,
  {
    requestId = randomUUID(),
    wait = true,
    signal,
    request = requestLocalControl,
    pause = (ms) => delay(ms, undefined, { signal }),
    now = Date.now,
    timeoutMs = 360 * 60_000 + 120_000,
    onAdmitted,
    legacyArknights = false,
  } = {},
) {
  if (
    !["arknights", "onmyoji"].includes(gameId) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(laneId) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(requestId) ||
    requestId.length + laneId.length + 1 > 160
  )
    throw new LocalControlError("INVALID_ARGUMENTS", "游戏账号或请求编号无效");
  signal?.throwIfAborted();
  const admitted = await request(
    profileDir,
    legacyArknights ? "arknights-run-channel" : "game-run-channel",
    { laneId, requestId, ...(legacyArknights ? {} : { gameId }) },
    { requestId, signal, timeoutMs: 30000 },
  );
  if (!admitted.ok)
    throw new LocalControlError(
      admitted.error.code,
      admitted.error.message,
      admitted.error.outcomeUnknown,
    );
  if (admitted.result?.batchId !== requestId)
    throw new LocalControlError(
      "INVALID_RESPONSE",
      "App受理回执不匹配，请在App核对",
      true,
    );
  try {
    onAdmitted?.(admitted.result);
    if (!wait) return admitted.result;
    const deadline = now() + timeoutMs;
    for (;;) {
      signal?.throwIfAborted();
      const response = await request(
        profileDir,
        legacyArknights ? "arknights-run-status" : "game-run-status",
        { laneId, batchId: requestId, ...(legacyArknights ? {} : { gameId }) },
        { signal, timeoutMs: 6000 },
      );
      const result = response.result;
      if (!response.ok)
        throw new LocalControlError(
          response.error.code,
          response.error.message,
          true,
        );
      if (
        (!legacyArknights && result?.gameId !== gameId) ||
        result?.laneId !== laneId ||
        result?.batchId !== requestId ||
        !["running", "succeeded", "failed", "cancelled", "unknown"].includes(
          result.status,
        )
      )
        throw new LocalControlError(
          "INVALID_RESPONSE",
          "App执行状态回执不匹配，请在App核对",
          true,
        );
      if (result.status !== "running") return result;
      if (now() >= deadline)
        throw new LocalControlError(
          "TIMEOUT",
          "App任务仍在运行，已停止等待；不会重复提交",
          true,
        );
      await pause(1500);
    }
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError")
      throw new LocalControlError(
        "CANCELLED",
        "已停止等待App结果；已受理的任务仍由App管理，请在App核对",
        true,
      );
    if (error instanceof LocalControlError)
      throw new LocalControlError(error.code, error.message, true);
    throw new LocalControlError(
      "CONTROL_FAILED",
      "等待App执行结果未完成，请在App核对；不会重复提交",
      true,
    );
  }
}
