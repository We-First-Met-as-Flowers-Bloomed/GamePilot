import { expect, it, vi } from "vitest";
import { validLocalControlParams } from "../packages/protocol/local-control";
async function forward() {
  const m = await import("../scripts/shared/game-app.mjs").catch(
    () => undefined,
  );
  expect(m?.runSavedGameChannel).toBeTypeOf("function");
  return m!.runSavedGameChannel;
}
it("forwards onmyoji once and reads the exact game/account durable terminal result", async () => {
  const run = await forward();
  let polls = 0;
  const request = vi.fn(async (_data, method, input) => ({
    ok: true,
    result:
      method === "game-run-channel"
        ? { batchId: input.requestId }
        : { ...input, status: ++polls === 1 ? "running" : "unknown" },
  }));
  expect(
    await run("profile", "lane-a-onmyoji", "onmyoji", {
      requestId: "stable",
      request,
      pause: async () => {},
    }),
  ).toMatchObject({
    gameId: "onmyoji",
    laneId: "lane-a-onmyoji",
    batchId: "stable",
    status: "unknown",
  });
  expect(request.mock.calls.map((call) => call[1])).toEqual([
    "game-run-channel",
    "game-run-status",
    "game-run-status",
  ]);
});
it("does not retry uncertain admission or accept another game's result", async () => {
  const run = await forward();
  const request = vi.fn(async () => ({
    ok: false,
    error: { code: "TIMEOUT", message: "uncertain", outcomeUnknown: true },
  }));
  await expect(
    run("profile", "lane-a-onmyoji", "onmyoji", {
      requestId: "stable",
      request,
    }),
  ).rejects.toMatchObject({ outcomeUnknown: true });
  expect(request).toHaveBeenCalledTimes(1);
  const wrong = vi.fn(async (_data, method) => ({
    ok: true,
    result:
      method === "game-run-channel"
        ? { batchId: "stable" }
        : {
            gameId: "arknights",
            laneId: "lane-a-onmyoji",
            batchId: "stable",
            status: "succeeded",
          },
  }));
  await expect(
    run("profile", "lane-a-onmyoji", "onmyoji", {
      requestId: "stable",
      request: wrong,
    }),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE", outcomeUnknown: true });
});
it("accepts only saved channels/jobs and refuses device or step overrides at the protocol boundary", () => {
  expect(
    validLocalControlParams("game-run-channel", {
      gameId: "onmyoji",
      laneId: "lane-a-onmyoji",
      requestId: "stable",
    }),
  ).toBe(true);
  expect(
    validLocalControlParams("game-run-channel", {
      gameId: "onmyoji",
      laneId: "lane-a-onmyoji",
      requestId: "stable",
      skillIds: ["mail"],
    }),
  ).toBe(false);
  expect(validLocalControlParams("game-tick", { gameId: "invalid" })).toBe(
    false,
  );
});
