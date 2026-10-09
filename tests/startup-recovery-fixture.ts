import { vi } from "vitest";
import { ContinuationService } from "../apps/desktop/main/continuation-service";
import { mumuResource } from "../apps/desktop/main/execution-coordinator";
import { defaultArknightsConfig } from "../games/arknights/config";
import { projectExecutionDetail } from "../games/execution-detail";
import type { DeviceLane, Plan } from "../packages/protocol";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { TaskRecord } from "../packages/protocol/task-record";

export function startupRecoveryFixture(skillIds = ["login"]) {
  let now = new Date("2026-10-08T11:07:00.000Z");
  const lane: DeviceLane = {
    id: "lane-b",
    name: "账号二",
    enabled: true,
    managerPath: "D:/MuMu/MuMuManager.exe",
    instance: 1,
    arknights: { enabled: true, profileId: "official-b" },
    onmyoji: { enabled: false },
    closeEmulatorAfterSuccess: false,
  };
  const profile = {
    ...defaultArknightsConfig,
    id: "official-b",
    name: "账号二",
    expectedUid: "123456789",
  };
  const plan: Plan = { gameId: "arknights", mode: "live", skillIds };
  const parent: ExecutionRecord = {
    version: 1,
    id: "original:lane-b",
    batchId: "original",
    laneId: lane.id,
    source: "daily",
    status: "failed",
    fingerprint: "b".repeat(64),
    resources: [mumuResource(lane.managerPath, lane.instance)],
    startedAt: "2026-10-08T11:02:00.000Z",
    finishedAt: "2026-10-08T11:06:00.000Z",
    message: "等待 Android 启动超时",
    startupFault: {
      version: 1,
      source: "startup",
      code: "mumu-boot-timeout",
      observedAt: "2026-10-08T11:06:00.000Z",
    },
    snapshot: { lane, profile, arknightsPlan: plan, appVersion: "0.15.6" },
  };
  const sibling: ExecutionRecord = {
    ...structuredClone(parent),
    id: "original:lane-a",
    laneId: "lane-a",
    status: "succeeded",
    fingerprint: "a".repeat(64),
    startupFault: undefined,
    finishedAt: "2026-10-08T11:03:00.000Z",
    resources: [mumuResource(lane.managerPath, 0)],
    snapshot: {
      ...structuredClone(parent.snapshot),
      lane: {
        ...structuredClone(lane),
        id: "lane-a",
        instance: 0,
        arknights: { enabled: true, profileId: "official-a" },
      },
      profile: { ...profile, id: "official-a", expectedUid: "987654321" },
    },
  };
  const records = [sibling, parent];
  const tasks: TaskRecord[] = [];
  function succeeded(request: ExecutionRecord): TaskRecord {
    const p = request.snapshot.arknightsPlan as Plan;
    return {
      version: 1,
      runId: `${request.id}-run`,
      executionId: request.id,
      laneId: request.laneId,
      batchId: request.batchId,
      instance: (request.snapshot.lane as DeviceLane).instance,
      profileId: (request.snapshot.profile as typeof profile).id,
      gameId: p.gameId,
      plan: structuredClone(p),
      status: "succeeded",
      message: "verified",
      startedAt: request.startedAt,
      updatedAt: request.finishedAt!,
      finishedAt: request.finishedAt,
      steps: p.skillIds.map((skillId) => ({
        skillId,
        status: "succeeded",
        diagnostics: [],
        message: "verified",
        result: {
          goalSatisfied: true,
          evidenceTimestamp: request.finishedAt!,
          evidenceReference: `${request.id}:${skillId}`,
          summary: "已核对",
        },
      })),
    };
  }
  tasks.push(succeeded(sibling));
  const executions = {
    assertHealthy: vi.fn(),
    get: vi.fn((id: string) =>
      structuredClone(records.find((r) => r.id === id)!),
    ),
    snapshot: vi.fn(() => structuredClone(records)),
    begin: vi.fn(async (input: any) => {
      const request: ExecutionRecord = {
        ...structuredClone(input),
        version: 1,
        fingerprint: String(records.length).repeat(64),
        status: "running",
        startedAt: now.toISOString(),
        message: "started",
      };
      records.push(request);
      return {
        finish: vi.fn(
          async (status: ExecutionRecord["status"], message: string) => {
            request.status = status;
            request.message = message;
            request.finishedAt = now.toISOString();
          },
        ),
      };
    }),
  };
  const ledger = {
    assertHealthy: vi.fn(),
    flush: vi.fn(async () => {}),
    snapshot: vi.fn(() => structuredClone(tasks)),
    forExecution: vi.fn((id: string) =>
      structuredClone(tasks.filter((t) => t.executionId === id)),
    ),
  };
  const details = {
    get: vi.fn((id: string) =>
      projectExecutionDetail(executions.get(id), tasks),
    ),
  };
  const currentLane = structuredClone(lane),
    currentProfile = structuredClone(profile);
  const assertCanStart = vi.fn(async (_lane: DeviceLane) => {});
  const continuation = new ContinuationService({
    executions: executions as any,
    ledger: ledger as any,
    details: details as any,
    lanes: async () => ({ version: 1, lanes: [currentLane] }),
    profiles: async () => ({
      version: 1,
      activeProfileId: profile.id,
      profiles: [currentProfile],
    }),
    now: () => now,
    appVersion: "0.15.6",
    assertCanStart,
  });
  return {
    continuation,
    parent,
    sibling,
    records,
    tasks,
    executions,
    ledger,
    details,
    currentLane,
    currentProfile,
    assertCanStart,
    succeeded,
    now: () => now,
    setNow: (at: string) => {
      now = new Date(at);
    },
  };
}
