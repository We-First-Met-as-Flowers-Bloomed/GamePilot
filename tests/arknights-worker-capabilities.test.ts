import { afterEach, expect, it, vi } from "vitest";
import { defaultArknightsConfig } from "../games/arknights/config";

const mocks = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("../packages/runtime/runner", () => ({
  Runner: class {
    busy = false;
    start = mocks.start;
  },
}));

const processWithPort = process as unknown as { parentPort?: unknown };
const previousPort = processWithPort.parentPort;
afterEach(() => {
  if (previousPort === undefined) delete processWithPort.parentPort;
  else processWithPort.parentPort = previousPort;
  vi.resetModules();
  vi.clearAllMocks();
});

it("accepts a supported upgraded daily plan before the worker runner starts login", async () => {
  const responses: { id?: string; result?: unknown; error?: string }[] = [];
  let receive!: (event: {
    data: { id: string; method: string; payload: unknown };
  }) => void;
  processWithPort.parentPort = {
    on: (_event: string, callback: typeof receive) => {
      receive = callback;
    },
    postMessage: (message: (typeof responses)[number]) =>
      responses.push(message),
  };
  mocks.start.mockReturnValue({
    runId: "unexpected",
    finished: Promise.resolve(),
  });
  await import("../packages/runtime/worker");
  receive({
    data: {
      id: "config",
      method: "arknights-config",
      payload: {
        ...defaultArknightsConfig,
        signInEvent: true,
      },
    },
  });
  await vi.waitFor(() =>
    expect(responses.some((r) => r.id === "config")).toBe(true),
  );
  receive({
    data: {
      id: "start",
      method: "start",
      payload: {
        gameId: "arknights",
        skillIds: ["login", "award"],
        mode: "live",
      },
    },
  });
  await vi.waitFor(() =>
    expect(responses.some((r) => r.id === "start")).toBe(true),
  );
  expect(responses.find((r) => r.id === "start")).toEqual({
    id: "start",
    result: { runId: "unexpected" },
  });
  expect(mocks.start).toHaveBeenCalledOnce();

  receive({
    data: {
      id: "login",
      method: "start",
      payload: {
        gameId: "arknights",
        skillIds: ["login"],
        mode: "live",
      },
    },
  });
  await vi.waitFor(() =>
    expect(responses.some((r) => r.id === "login")).toBe(true),
  );
  expect(responses.find((r) => r.id === "login")?.result).toEqual({
    runId: "unexpected",
  });
  expect(mocks.start).toHaveBeenCalledTimes(2);
});
