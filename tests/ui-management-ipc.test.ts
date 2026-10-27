import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { expect, it, vi } from "vitest";

function previewHandler(
  flags = {
    smoke: false,
    plannerPreview: false,
    quitting: false,
    configuring: false,
    startupInspectionRunning: false,
  },
  runningBatch = true,
) {
  const source = readFileSync("apps/desktop/main/index.ts", "utf8");
  const start = source.indexOf('handle("gp:lane-preview-capture",');
  const end = source.indexOf("\n      });", start);
  if (start < 0 || end < 0) throw Error("Account preview IPC is missing");
  const capture = vi.fn(async (laneId: string) => ({
    status: "connected",
    laneId,
    requestId: "batch-a:lane-a",
  }));
  const code = transformSync(
    `
    let result;
    const handle = (_channel, fn) => { result = fn; };
    const lanePreview = { capture };
    const laneRuntime = { isRunning: () => true, isRunningBatch: () => runningBatch };
    const { smoke, plannerPreview, quitting, configuring, startupInspectionRunning } = flags;
    ${source.slice(start, end + "\n      });".length)}
    return result;
  `,
    { loader: "ts" },
  ).code;
  return {
    capture,
    invoke: new Function("flags", "capture", "runningBatch", code)(
      flags,
      capture,
      runningBatch,
    ),
  };
}
it("uses the account preview service during execution instead of the single-worker inspection", async () => {
  const { capture, invoke } = previewHandler();
  expect(await invoke("lane-a")).toMatchObject({
    laneId: "lane-a",
    status: "connected",
  });
  expect(capture).toHaveBeenCalledExactlyOnceWith("lane-a");
});
it("drops old request metadata when the worker is reused for a different batch", async () => {
  const { invoke } = previewHandler(undefined, false);
  expect(await invoke("lane-a")).toMatchObject({
    status: "connected",
    laneId: "lane-a",
    requestId: undefined,
    gameId: undefined,
  });
});
it("never captures real device frames in isolated planner previews or while quitting", async () => {
  for (const key of [
    "smoke",
    "plannerPreview",
    "quitting",
    "configuring",
    "startupInspectionRunning",
  ] as const) {
    const flags = {
      smoke: false,
      plannerPreview: false,
      quitting: false,
      configuring: false,
      startupInspectionRunning: false,
      [key]: true,
    };
    const { capture, invoke } = previewHandler(flags);
    await expect(invoke("lane-a")).rejects.toThrow();
    expect(capture).not.toHaveBeenCalled();
  }
});

it("exposes only fixed account preview and explicit conversation-management IPC", async () => {
  const invoke = vi.fn(async () => ({}));
  let api: Record<string, (...args: unknown[]) => unknown> = {};
  const source = readFileSync("apps/desktop/preload/index.ts", "utf8");
  const code = transformSync(source, { loader: "ts", format: "cjs" }).code;
  new Function("require", code)((module: string) => {
    if (module !== "electron")
      throw Error(`Unexpected preload dependency: ${module}`);
    return {
      contextBridge: {
        exposeInMainWorld: (name: string, value: typeof api) => {
          expect(name).toBe("gamepilot");
          api = value;
        },
      },
      ipcRenderer: { invoke, on: vi.fn(), removeAllListeners: vi.fn() },
    };
  });
  await api.captureLanePreview("lane-a");
  await api.restoreArchivedChat({ archiveId: "archive-fixture" });
  await api.deleteChat({
    sessionId: "session-fixture",
    confirmation: "delete-chat",
  });
  expect(invoke.mock.calls).toEqual([
    ["gp:lane-preview-capture", "lane-a"],
    ["gp:chat-archive-restore", { archiveId: "archive-fixture" }],
    [
      "gp:chat-delete",
      { sessionId: "session-fixture", confirmation: "delete-chat" },
    ],
  ]);
  expect(api).not.toHaveProperty("exec");
  expect(api).not.toHaveProperty("shell");
});
