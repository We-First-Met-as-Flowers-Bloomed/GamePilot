import { expect, it } from "vitest";
import {
  copilotBinding,
  copilotConfigurationRevision,
  freezeCopilotExecution,
} from "../apps/desktop/main/copilot-admission";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import type { PreparedCopilotPlan } from "../packages/protocol/copilot";
import { mumuResource } from "../apps/desktop/main/execution-coordinator";
it("binds copilot to the Arknights override without changing saved devices", () => {
  const f = createFixtureSnapshot();
  f.lanes!.lanes[0].deviceInstances = { arknights: 2, onmyoji: 3 };
  const binding = copilotBinding(
    f.lanes!,
    f.profiles!,
    f.profiles!.profiles[0].id,
  );
  expect(binding.lane.instance).toBe(2);
  expect(binding.lane.deviceInstances).toBeUndefined();
  expect(f.lanes!.lanes[0].instance).toBe(0);
});
it("freezes one temporary lane without changing the saved daily and rejects revision drift", () => {
  const f = createFixtureSnapshot(),
    lanes = f.lanes!,
    profiles = f.profiles!,
    revision = copilotConfigurationRevision(lanes, profiles, "engine-A"),
    profile = profiles.profiles[0];
  const plan = {
    revision,
    account: {
      profileId: profile.id,
      expectedUid: profile.expectedUid,
      clientType: profile.clientType,
      revision,
    },
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  } as PreparedCopilotPlan;
  const before = JSON.stringify({ lanes, profiles });
  const frozen = freezeCopilotExecution(
    plan,
    lanes,
    profiles,
    "engine-A",
    [],
    [],
  );
  expect(frozen.arknightsPlan?.skillIds).toEqual(["copilot"]);
  expect(frozen.lane.onmyoji.enabled).toBe(false);
  expect(JSON.stringify({ lanes, profiles })).toBe(before);
  expect(() =>
    freezeCopilotExecution(plan, lanes, profiles, "engine-B", [], []),
  ).toThrow(/变化/);
  const r = {
    ...f.requests![0],
    resources: [mumuResource(frozen.lane.managerPath, frozen.lane.instance)],
  };
  expect(() =>
    freezeCopilotExecution(plan, lanes, profiles, "engine-A", [r], []),
  ).toThrow(/未核对/);
  expect(() =>
    freezeCopilotExecution(
      plan,
      lanes,
      profiles,
      "engine-A",
      [
        {
          ...r,
          status: "succeeded",
          snapshot: { ...r.snapshot, schemaVersion: 99 },
        },
      ],
      [],
    ),
  ).toThrow(/未核对/);
  expect(() =>
    freezeCopilotExecution(
      plan,
      lanes,
      profiles,
      "engine-A",
      [
        {
          ...r,
          status: "unknown",
          resolution: {
            action: "abandoned",
            at: new Date().toISOString(),
            note: "reviewed",
          },
        },
      ],
      [],
    ),
  ).toThrow(/未核对/);
  const ended = new Date(Date.now() - 1000).toISOString(),
    started = new Date(Date.now() - 2000).toISOString();
  const safe = {
    ...r,
    status: "failed" as const,
    startedAt: started,
    finishedAt: ended,
    resolution: { action: "abandoned" as const, at: ended, note: "reviewed" },
    startupFault: {
      version: 1 as const,
      source: "startup" as const,
      code: "mumu-boot-timeout" as const,
      observedAt: ended,
    },
  };
  expect(() =>
    freezeCopilotExecution(plan, lanes, profiles, "engine-A", [safe], []),
  ).not.toThrow();
  expect(() =>
    freezeCopilotExecution(
      plan,
      lanes,
      profiles,
      "engine-A",
      [safe],
      [
        {
          ...f.tasks![0],
          executionId: safe.id,
          laneId: safe.laneId,
          batchId: safe.batchId,
        },
      ],
    ),
  ).toThrow();
});
it("rejects ambiguous profile/device bindings", () => {
  const f = createFixtureSnapshot();
  f.lanes!.lanes[1].arknights.profileId = f.profiles!.profiles[0].id;
  expect(() =>
    copilotBinding(f.lanes!, f.profiles!, f.profiles!.profiles[0].id),
  ).toThrow(/唯一/);
});
