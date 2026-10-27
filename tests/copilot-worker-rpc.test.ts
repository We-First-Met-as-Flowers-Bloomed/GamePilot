import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cacheCopilotJob } from "../games/arknights/copilot-library";
import { validateCopilotJob } from "../games/arknights/copilot-policy";
import { defaultArknightsConfig } from "../games/arknights/config";
import { copilotPlanDigest } from "../apps/desktop/main/copilot-service";
import type { PreparedCopilotPlan } from "../packages/protocol/copilot";
const mocks = vi.hoisted(() => ({ run: vi.fn(), connect: vi.fn() }));
vi.mock("../games/arknights/copilot-run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../games/arknights/copilot-run")>()),
  executeCopilotPlan: mocks.run,
}));
vi.mock("../packages/runtime/maa", () => ({
  MaaEngine: class {
    init = async () => {};
    connect = mocks.connect;
  },
}));
const portProcess = process as unknown as { parentPort?: unknown },
  prior = portProcess.parentPort;
let dir: string | undefined;
afterEach(() => {
  if (prior === undefined) delete portProcess.parentPort;
  else portProcess.parentPort = prior;
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});
it("starts temporary Copilot on the existing Runner event stream and existing stop cancels it, without changing saved configuration", async () => {
  dir = mkdtempSync(join(tmpdir(), "gp-copilot-rpc-"));
  vi.stubEnv("GAMEPILOT_DATA", dir);
  const events: any[] = [],
    responses: any[] = [];
  let receive!: (event: {
    data: { id: string; method: string; payload?: unknown };
  }) => void;
  portProcess.parentPort = {
    on: (_e: string, cb: typeof receive) => (receive = cb),
    postMessage: (m: any) =>
      m.event ? events.push(m.event) : responses.push(m),
  };
  const entry = cacheCopilotJob(
    dir,
    {
      id: 1001,
      stageName: "stage_go_8",
      title: "fixture",
      uploader: "",
      uploadTime: "",
    },
    validateCopilotJob({
      stage_name: "stage_go_8",
      minimum_required: "v6.7.0",
      actions: [{ type: "SkillDaemon" }],
    }),
  );
  const now = Date.now(),
    prepared: PreparedCopilotPlan = {
      version: 1,
      preparedId: "temporary",
      planHash: "0".repeat(64),
      revision: "r1",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 600000).toISOString(),
      account: {
        profileId: "p1",
        expectedUid: "12345678",
        clientType: "Official",
        revision: "a1",
      },
      stage: { id: "stage_go_8", code: "GO-8", aliases: ["stage_go_8"] },
      count: 1,
      jobs: [
        {
          id: entry.id,
          sha256: entry.sha256,
          file: entry.file,
          stageName: entry.stageName,
          title: entry.title,
        },
      ],
      budget: { maxBattles: 1, sanityPotions: 0, originite: 0 },
      skipStory: true,
      precheck: { status: "pending-live", unknown: ["live box required"] },
    };
  prepared.planHash = copilotPlanDigest(prepared);
  const config = {
    ...defaultArknightsConfig,
    expectedUid: "12345678",
    stage: "LS-6",
  };
  mocks.connect.mockResolvedValue({ connected: true });
  let runningSignal: AbortSignal | undefined;
  mocks.run.mockImplementation(async (options: any) => {
    runningSignal = options.signal;
    options.log("native submission saved", {
      arknights: {
        version: 1,
        taskType: "Copilot",
        submission: "submitted",
        completion: "unknown",
        taskId: 7,
        observedAt: new Date().toISOString(),
      },
    });
    await new Promise<void>((resolve) =>
      options.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    options.signal.throwIfAborted();
  });
  await import("../packages/runtime/worker");
  const send = async (id: string, method: string, payload?: unknown) => {
    receive({ data: { id, method, payload } });
    await vi.waitFor(() =>
      expect(responses.some((r) => r.id === id)).toBe(true),
    );
    return responses.find((r) => r.id === id);
  };
  await send("connect", "connect", {
    name: "fixture",
    adbPath: "D:/fixture/adb.exe",
    address: "fixture:1",
  });
  await send("saved", "arknights-config", config);
  const started = await send("start", "execute-copilot", { prepared, config });
  expect(started).toMatchObject({ result: { runId: expect.any(String) } });
  await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "status",
        status: "queued",
        plan: { gameId: "arknights", skillIds: ["copilot"], mode: "live" },
      }),
      expect.objectContaining({
        type: "step",
        skillId: "copilot",
        stepStatus: "running",
      }),
      expect.objectContaining({
        type: "log",
        result: {
          arknights: expect.objectContaining({ completion: "unknown" }),
        },
      }),
    ]),
  );
  expect(
    await send("busy", "execute-copilot", { prepared, config }),
  ).toHaveProperty("error");
  expect(await send("stop", "stop")).toMatchObject({ result: null });
  expect(runningSignal?.aborted).toBe(true);
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "status", status: "cancelled" }),
    ]),
  );
  expect(config.stage).toBe("LS-6");
  expect(
    await send("bad", "execute-copilot", {
      prepared: { ...prepared, planHash: "a".repeat(64) },
      config,
    }),
  ).toHaveProperty("error");
  expect(mocks.run).toHaveBeenCalledOnce();
});
