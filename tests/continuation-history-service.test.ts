import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ContinuationService } from "../apps/desktop/main/continuation-service";
import {
  ExecutionCoordinator,
  mumuResource,
} from "../apps/desktop/main/execution-coordinator";
import { ExecutionDetailService } from "../apps/desktop/main/execution-detail";
import { RunLedger } from "../apps/desktop/main/run-ledger";
import { defaultArknightsConfig, taskFor } from "../games/arknights/config";
import type {
  DeviceLane,
  Plan,
  RunEvent,
  SkillResult,
} from "../packages/protocol";
import type {
  ContinuationInput,
  ContinuationLink,
} from "../packages/protocol/continuation";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    if (
      !resolve(directory).startsWith(
        resolve(tmpdir()) + "\\gp-continuation-history-",
      )
    )
      throw Error("Unsafe temporary test cleanup");
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-05T01:00:00Z") });
  const directory = await mkdtemp(join(tmpdir(), "gp-continuation-history-"));
  directories.push(directory);
  const executions = new ExecutionCoordinator(join(directory, "requests"));
  const ledger = new RunLedger(join(directory, "tasks"));
  await Promise.all([executions.load(), ledger.load()]);
  const lane: DeviceLane = {
    id: "lane-a",
    name: "fixture account",
    managerPath: "D:\\MuMu\\MuMuManager.exe",
    instance: 0,
    enabled: true,
    arknights: { enabled: true, profileId: "fixture-profile" },
    onmyoji: { enabled: false },
    closeEmulatorAfterSuccess: false,
  };
  const profile = {
    ...defaultArknightsConfig,
    id: "fixture-profile",
    name: "fixture profile",
    expectedUid: "111222333",
    stage: "LS-6",
    creditShopping: true,
    mail: true,
  };
  const plan: Plan = {
    gameId: "arknights",
    mode: "live",
    skillIds: ["login", "friends", "award"],
  };
  async function record(
    batchId: string,
    at: string,
    options: {
      lane?: DeviceLane;
      plan?: Plan;
      outcome?: "succeeded" | "not-submitted" | "unknown";
      continuation?: ContinuationLink;
    } = {},
  ) {
    const currentLane = options.lane ?? lane,
      currentPlan = options.plan ?? plan;
    const outcome = options.outcome ?? "succeeded";
    vi.setSystemTime(new Date(at));
    const id = `${batchId}:${currentLane.id}`;
    const lease = await executions.begin({
      id,
      batchId,
      laneId: currentLane.id,
      source: "daily",
      resources: [mumuResource(currentLane.managerPath, currentLane.instance)],
      snapshot: {
        lane: currentLane,
        profile,
        arknightsPlan: currentPlan,
        appVersion: "fixture",
        ...(options.continuation ? { continuation: options.continuation } : {}),
      },
    });
    const metadata = {
      executionId: id,
      batchId,
      laneId: currentLane.id,
      instance: currentLane.instance,
      profileId: profile.id,
      gameId: "arknights",
      runId: `${batchId}-run`,
      executionSource: "daily" as const,
    };
    const emit = async (event: Partial<RunEvent>, offset: number) => {
      vi.setSystemTime(new Date(Date.parse(at) + offset * 1000));
      await ledger.append({
        ...metadata,
        type: "log",
        message: "fixture structured event",
        at: new Date().toISOString(),
        ...event,
      });
    };
    await emit({ type: "status", status: "queued", plan: currentPlan }, 0);
    await emit({ type: "status", status: "running" }, 1);
    for (let i = 0; i < currentPlan.skillIds.length; i++) {
      const skillId = currentPlan.skillIds[i],
        offset = 10 + i * 20;
      const failed = skillId !== "login" && outcome !== "succeeded";
      await emit({ type: "step", skillId, stepStatus: "running" }, offset);
      const observedAt = new Date(
        Date.parse(at) + (offset + 1) * 1000,
      ).toISOString();
      const result: SkillResult = {
        evidenceTimestamp: observedAt,
        evidenceReference: `fixture:${id}:${skillId}`,
        goalSatisfied: failed ? null : true,
        arknights: {
          version: 1,
          taskType: taskFor(skillId, {
            ...defaultArknightsConfig,
            stage: "LS-6",
          }).type,
          observedAt,
          submission:
            failed && outcome === "not-submitted"
              ? "not-submitted"
              : "submitted",
          completion: failed
            ? outcome === "not-submitted"
              ? "not-started"
              : "unknown"
            : "native-confirmed",
          ...(!(failed && outcome === "not-submitted")
            ? { taskId: i + 1 }
            : {}),
          ...(skillId === "login"
            ? {
                login: {
                  expectedUid: profile.expectedUid,
                  observedUid: profile.expectedUid,
                  observedAt,
                  home: true as const,
                },
              }
            : {}),
        },
      };
      await emit({ skillId, result }, offset + 1);
      await emit(
        { type: "step", skillId, stepStatus: failed ? "failed" : "succeeded" },
        offset + 2,
      );
      if (failed) break;
    }
    await emit(
      {
        type: "status",
        status: outcome === "succeeded" ? "succeeded" : "failed",
      },
      100,
    );
    await lease.finish(
      outcome === "succeeded" ? "succeeded" : "unknown",
      "fixture terminal fact",
    );
    await Promise.all([ledger.flush(), executions.flush()]);
    return executions.get(id);
  }
  const parent = await record("old-09", "2026-10-05T01:00:00Z", {
    outcome: "not-submitted",
  });
  vi.setSystemTime(new Date("2026-10-05T04:00:00Z"));
  const assertCanStart = vi.fn(async () => {});
  const service = new ContinuationService({
    executions,
    ledger,
    details: new ExecutionDetailService(executions, ledger),
    lanes: async () => ({ version: 1, lanes: [lane] }),
    profiles: async () => ({
      version: 1,
      activeProfileId: profile.id,
      profiles: [profile],
    }),
    appVersion: "fixture",
    assertCanStart,
  });
  const input = async (): Promise<ContinuationInput> => {
    const preview = await service.preview(parent.id);
    return {
      parentId: parent.id,
      fingerprint: preview.fingerprint,
      selections: preview.defaults,
      acknowledgePartial: true,
    };
  };
  return {
    service,
    executions,
    ledger,
    parent,
    lane,
    plan,
    record,
    input,
    assertCanStart,
  };
}

it("rejects the real old-09 ledger after an independent 12:00 run completed today's same-device business", async () => {
  const t = await fixture();
  expect((await t.service.preview(t.parent.id)).canContinue).toBe(true);
  const stale = await t.input();
  const later = await t.record("independent-12", "2026-10-05T04:00:00Z");
  const facts = {
    requests: t.executions.snapshot(),
    tasks: t.ledger.snapshot(),
  };
  const preview = await t.service.preview(t.parent.id);
  expect(preview.canContinue).toBe(false);
  expect(preview.reasons.join(";")).toMatch(/独立请求|重叠/);
  const launch = vi.fn(async () => {});
  await expect(
    t.service.startForGoal(stale, launch, undefined, {
      batchId: "goal-old-retry",
    }),
  ).rejects.toThrow(/独立请求|重叠/);
  expect(launch).not.toHaveBeenCalled();
  expect(t.executions.snapshot()).toHaveLength(2);
  expect(t.executions.get(t.parent.id)).toEqual(t.parent);
  expect(t.executions.get(later.id).status).toBe("succeeded");
  expect({
    requests: t.executions.snapshot(),
    tasks: t.ledger.snapshot(),
  }).toEqual(facts);
});

it("freshly rejects a success admitted while the old continuation awaits host checks", async () => {
  const t = await fixture(),
    stale = await t.input(),
    launch = vi.fn(async () => {});
  t.assertCanStart.mockImplementationOnce(async () => {
    await t.record("independent-during-check", "2026-10-05T04:00:00Z");
  });
  await expect(t.service.start(stale, launch)).rejects.toThrow(/独立请求|重叠/);
  expect(launch).not.toHaveBeenCalled();
  expect(t.executions.snapshot()).toHaveLength(2);
  expect(t.executions.get(t.parent.id).status).toBe("unknown");
});

it("does not let renamed lanes or differently cased physical paths bypass actual successful history", async () => {
  const t = await fixture(),
    stale = await t.input(),
    launch = vi.fn(async () => {});
  await t.record("independent-alias", "2026-10-05T04:00:00Z", {
    lane: {
      ...t.lane,
      id: "renamed-lane",
      managerPath: "d:/MUMU/./MuMuManager.exe",
    },
  });
  expect((await t.service.preview(t.parent.id)).canContinue).toBe(false);
  await expect(t.service.start(stale, launch)).rejects.toThrow(/独立请求|重叠/);
  expect(launch).not.toHaveBeenCalled();
});

it("keeps an independent submitted native result unknown and refuses replay even after abandonment", async () => {
  const t = await fixture(),
    stale = await t.input(),
    launch = vi.fn(async () => {});
  const unresolved = await t.record(
    "independent-uncertain",
    "2026-10-05T04:00:00Z",
    { outcome: "unknown" },
  );
  await t.executions.resolve(
    unresolved.id,
    "fixture review without completion evidence",
  );
  const preview = await t.service.preview(t.parent.id);
  expect(preview.canContinue).toBe(false);
  await expect(t.service.start(stale, launch)).rejects.toThrow(
    /未知|未确认|核对/,
  );
  expect(launch).not.toHaveBeenCalled();
  expect(t.executions.get(unresolved.id).status).toBe("unknown");
  expect(t.executions.snapshot()).toHaveLength(2);
});

it.each(["login-only", "other-device", "not-submitted"] as const)(
  "allows safe original remaining business when independent history is %s",
  async (kind) => {
    const t = await fixture();
    await t.record(`independent-${kind}`, "2026-10-05T04:00:00Z", {
      ...(kind === "login-only"
        ? { plan: { ...t.plan, skillIds: ["login"] } }
        : {}),
      ...(kind === "other-device"
        ? { lane: { ...t.lane, id: "lane-b", instance: 1 } }
        : {}),
      ...(kind === "not-submitted"
        ? { outcome: "not-submitted" as const }
        : {}),
    });
    const p = await t.service.preview(t.parent.id);
    expect(p.canContinue).toBe(true);
    expect(p.defaults).toEqual([
      { gameId: "arknights", skillIds: ["friends", "award"] },
    ]);
    const launch = vi.fn(async (_frozen, _batch, lease) => {
      await lease.finish("cancelled", "fixture no device launch");
    });
    await t.service.start(await t.input(), launch);
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    await launch.mock.results[0].value;
    await t.executions.flush();
    expect(t.executions.get(t.parent.id)).toEqual(t.parent);
  },
);

it("uses the server 04:00 game-day boundary and refuses carrying the old parent across it", async () => {
  const t = await fixture(),
    stale = await t.input(),
    launch = vi.fn(async () => {});
  vi.setSystemTime(new Date("2026-10-05T19:59:59Z"));
  expect((await t.service.preview(t.parent.id)).canContinue).toBe(true);
  vi.setSystemTime(new Date("2026-10-05T20:00:00Z"));
  const p = await t.service.preview(t.parent.id);
  expect(p.canContinue).toBe(false);
  expect(p.reasons.join(";")).toMatch(/跨游戏日/);
  await expect(t.service.start(stale, launch)).rejects.toThrow(/跨游戏日/);
  expect(launch).not.toHaveBeenCalled();
  expect(t.executions.snapshot()).toHaveLength(1);
});
