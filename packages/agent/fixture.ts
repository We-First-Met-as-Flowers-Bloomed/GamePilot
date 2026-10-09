import { defaultDeviceLanes } from "../protocol";
import { defaultArknightsConfig } from "../../games/arknights/config";
import type { AgentSnapshot } from "../protocol/agent";

/** Deliberately synthetic; not a copy of the user's accounts or runtime data. */
export function createFixtureSnapshot(): AgentSnapshot {
  const lane = defaultDeviceLanes({
    managerPath: "D:/PRIVATE/MuMuManager.exe",
    instance: 0,
    closeEmulatorAfterSuccess: false,
  }).lanes[0];
  const at = "2026-09-25T00:00:00.000Z";
  const plan = {
    gameId: "arknights",
    skillIds: ["login", "fight"],
    mode: "live" as const,
  };
  return {
    source: "fixture",
    capturedAt: "2026-09-25T01:00:00.000Z",
    errors: [],
    lanes: {
      version: 1,
      lanes: [
        lane,
        {
          ...structuredClone(lane),
          id: "lane-b",
          name: "MuMu 1",
          instance: 1,
          arknights: { enabled: true, profileId: "second" },
        },
      ],
    },
    profiles: {
      version: 1,
      activeProfileId: "default",
      profiles: [
        {
          ...defaultArknightsConfig,
          id: "default",
          name: "模拟账号A",
          stage: "LS-6",
          mail: true,
          expectedUid: "111111111",
          accountName: "PRIVATE-A",
          clientType: "Bilibili",
        },
        {
          ...defaultArknightsConfig,
          id: "second",
          name: "模拟账号B",
          stage: "LS-6",
          mail: true,
          expectedUid: "222222222",
          accountName: "PRIVATE-B",
        },
      ],
    },
    requests: [
      {
        version: 1,
        id: "fixture:lane-a",
        source: "daily",
        resources: ["fixture"],
        fingerprint: "fixture",
        laneId: "lane-a",
        batchId: "fixture",
        snapshot: { lane: structuredClone(lane), arknightsPlan: plan },
        status: "unknown",
        startedAt: at,
        finishedAt: "2026-09-25T00:05:00.000Z",
        message: "PRIVATE diagnostic",
      },
    ],
    tasks: [
      {
        version: 1,
        executionId: "fixture:lane-a",
        laneId: "lane-a",
        batchId: "fixture",
        instance: 0,
        runId: "fixture-ark",
        gameId: "arknights",
        plan,
        startedAt: at,
        updatedAt: "2026-09-25T00:05:00.000Z",
        status: "unknown",
        message: "PRIVATE diagnostic",
        steps: [
          {
            skillId: "login",
            status: "succeeded",
            message: "PRIVATE-A",
            diagnostics: [],
          },
          {
            skillId: "fight",
            status: "unknown",
            message: "PRIVATE failure",
            diagnostics: ["PRIVATE account data"],
          },
        ],
      },
    ],
  };
}
