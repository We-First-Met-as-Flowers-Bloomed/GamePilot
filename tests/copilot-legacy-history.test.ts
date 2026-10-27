import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readEvidence } from "../packages/acceptance/files";
import { projectExecutionDetail } from "../games/execution-detail";
import { guardHistory } from "../apps/desktop/main/agent-execution-policy";
import { defaultArknightsConfig } from "../games/arknights/config";
import { RunLedger } from "../apps/desktop/main/run-ledger";
import {
  readTaskRecord,
  validateTaskRecord,
  taskRecordKey,
  type TaskRecord,
} from "../packages/protocol/task-record";
import { validArknightsEvidence } from "../games/arknights/evidence";
import { evaluateGameSkillOutcome } from "../games/goal-outcome";
import { historyStepStatus } from "../games/agent-history";
import { summarizeTaskResult } from "../games/task-result-summary";
import { assertNativeEffectsKnown } from "../games/continuation-history";
const at = "2026-10-12T03:00:00.000Z",
  end = "2026-10-12T03:02:00.000Z";
function legacy(): TaskRecord {
  return {
    version: 1,
    runId: "legacy-copilot",
    laneId: "lane-a",
    gameId: "arknights",
    plan: { gameId: "arknights", skillIds: ["copilot"], mode: "live" },
    startedAt: at,
    updatedAt: end,
    finishedAt: end,
    status: "succeeded",
    message: "native task returned",
    steps: [
      {
        skillId: "copilot",
        status: "succeeded",
        startedAt: at,
        finishedAt: end,
        message: "native task returned",
        diagnostics: [],
        result: {
          arknights: {
            version: 1,
            taskType: "Copilot",
            submission: "submitted",
            completion: "native-confirmed",
            observedAt: "2026-10-12T03:01:00.000Z",
            taskId: 1,
          },
        },
      },
    ],
  };
}
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
it("reads exact six-field legacy evidence without upgrading its state or supplying new success proof", () => {
  const original = legacy(),
    bytes = JSON.stringify(original),
    read = readTaskRecord(original);
  expect(read).toEqual(original);
  expect(JSON.stringify(original)).toBe(bytes);
  expect(read.status).toBe("succeeded");
  expect(read.steps[0].status).toBe("succeeded");
  expect(read.steps[0].result!.arknights).not.toHaveProperty("copilot");
  expect(validArknightsEvidence(read.steps[0].result!.arknights)).toBe(false);
  expect(() => validateTaskRecord(original)).toThrow();
});
it("loads a legacy terminal ledger without globally degrading storage or rewriting its bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gp-copilot-legacy-"));
  dirs.push(dir);
  const original = legacy(),
    raw = JSON.stringify(original, null, 2),
    file = join(
      dir,
      createHash("sha256").update(taskRecordKey(original)).digest("hex") +
        ".json",
    );
  await writeFile(file, raw);
  const ledger = new RunLedger(dir);
  await ledger.load();
  expect(ledger.error).toBeUndefined();
  expect(() => ledger.assertHealthy()).not.toThrow();
  expect(ledger.snapshot()).toEqual([original]);
  expect(await readFile(file, "utf8")).toBe(raw);
});
it("projects legacy claimed success as unknown and blocks same-day native-effect admission without rewriting the raw task", () => {
  const original = legacy(),
    before = JSON.stringify(original),
    read = readTaskRecord(original);
  expect(historyStepStatus(read.steps[0])).toBe("unknown");
  const summary = summarizeTaskResult(read);
  expect(summary.counts.unknown).toBe(1);
  expect(summary.counts.completed).toBe(0);
  expect(summary.issues[0].message).toMatch(/旧版|逐场|主页/);
  expect(() =>
    assertNativeEffectsKnown(
      read,
      new Date("2026-10-12T03:05:00.000Z"),
      undefined,
      [read],
      [],
    ),
  ).toThrow(/未确认/);
  expect(JSON.stringify(original)).toBe(before);
});
it.each([
  "copilot-metadata",
  "recognition",
  "login",
  "wrong-skill",
  "wrong-game",
  "malformed-task-id",
  "missing-field",
])("refuses %s as an exact legacy adapter match", (kind) => {
  const task = legacy(),
    native = task.steps[0].result!.arknights!;
  if (kind === "copilot-metadata") native.copilot = {} as never;
  if (kind === "recognition") native.recognition = {} as never;
  if (kind === "login") native.login = {} as never;
  if (kind === "wrong-skill") {
    task.steps[0].skillId = "fight";
    task.plan.skillIds = ["fight"];
  }
  if (kind === "wrong-game") {
    task.gameId = "onmyoji";
    task.plan.gameId = "onmyoji";
  }
  if (kind === "malformed-task-id") native.taskId = 0;
  if (kind === "missing-field") delete native.taskId;
  expect(() => readTaskRecord(task)).toThrow();
  expect(validArknightsEvidence(native)).toBe(false);
});
it.each(["2000-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"])(
  "identifies legacy by exact shape instead of date: %s",
  (date) => {
    const task = legacy();
    task.steps[0].result!.arknights!.observedAt = date;
    expect(readTaskRecord(task).steps[0].result!.arknights!.observedAt).toBe(
      date,
    );
  },
);

it("acceptance history reads a legacy receipt as data while projection keeps raw state and explains missing current proof", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gp-copilot-legacy-read-"));
  dirs.push(dir);
  const fs = await import("node:fs/promises");
  await fs.mkdir(join(dir, "task-runs"));
  const task = legacy(),
    bytes = JSON.stringify(task, null, 2),
    file = join(
      dir,
      "task-runs",
      createHash("sha256").update(taskRecordKey(task)).digest("hex") + ".json",
    );
  await writeFile(file, bytes);
  const read = await readEvidence(dir);
  expect(read.errors).toEqual([]);
  expect(read.tasks).toEqual([task]);
  expect(await readFile(file, "utf8")).toBe(bytes);
  const associated = { ...task, laneId: undefined, executionId: "old-copilot" },
    request = {
      version: 1 as const,
      id: "old-copilot",
      source: "single" as const,
      fingerprint: "old",
      resources: [],
      status: "succeeded" as const,
      startedAt: at,
      finishedAt: end,
      message: "raw terminal",
      snapshot: { plan: task.plan, arknights: defaultArknightsConfig },
    };
  const detail = projectExecutionDetail(request, [associated]);
  expect(detail.games[0].record?.status).toBe("succeeded");
  expect(detail.games[0].summary?.counts.unknown).toBe(1);
  expect(detail.games[0].summary?.issues[0].message).toContain("旧版作业");
});
it("new live ledger submissions cannot reuse legacy readable shape as a current confirmed result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gp-copilot-current-"));
  dirs.push(dir);
  const ledger = new RunLedger(dir);
  await ledger.load();
  const task = legacy();
  await ledger.append({
    runId: task.runId,
    laneId: task.laneId,
    gameId: task.gameId,
    plan: task.plan,
    type: "status",
    status: "queued",
    at,
    message: "queued",
  });
  await expect(
    ledger.append({
      runId: task.runId,
      laneId: task.laneId,
      gameId: task.gameId,
      type: "log",
      skillId: "copilot",
      at,
      message: "legacy shaped new result",
      result: task.steps[0].result,
    }),
  ).rejects.toThrow(/新任务原生证据/);
  expect(ledger.error).toContain("尚未确认");
  expect(ledger.snapshot()[0].steps[0].result).toBeUndefined();
  expect(ledger.snapshot()[0].status).toBe("queued");
});
it("preserves ordinary disjoint daily admission while preventing replay of the old Copilot scope", () => {
  const task = legacy(),
    lane = {
      id: "lane-a",
      name: "fixture",
      enabled: true,
      managerPath: "D:/MuMu/MuMuManager.exe",
      instance: 0,
      arknights: { enabled: true, profileId: "p" },
      onmyoji: { enabled: true },
      closeEmulatorAfterSuccess: false,
    },
    target = {
      lane,
      profile: { ...defaultArknightsConfig, id: "p", name: "fixture" },
      startedAt: end,
      arknightsPlan: {
        gameId: "arknights",
        skillIds: ["login", "award"],
        mode: "live" as const,
      },
    },
    context = { tasks: [readTaskRecord(task)], requests: [] } as never,
    now = new Date("2026-10-12T03:05:00.000Z");
  expect(() => guardHistory(target, context, now)).not.toThrow();
  expect(() =>
    guardHistory(target, context, now, {
      gameId: "arknights",
      skillIds: ["copilot"],
      mode: "live",
    }),
  ).toThrow(/本游戏日/);
});

it("legacy native completion cannot fulfill a current gameplay goal even with an added generic success annotation", () => {
  const task = readTaskRecord(legacy()),
    step = task.steps[0];
  step.result = {
    ...step.result,
    goalSatisfied: true,
    evidenceTimestamp: end,
    evidenceReference: "generic-old-claim",
  };
  const outcome = evaluateGameSkillOutcome("arknights", step, {});
  expect(outcome.goalSatisfied).toBeNull();
  expect(outcome.summary).toContain("尚未核验");
  expect(step.status).toBe("succeeded");
});
