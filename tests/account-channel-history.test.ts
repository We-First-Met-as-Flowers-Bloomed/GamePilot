import { expect, it } from "vitest";
import type { DeviceLane, Plan } from "../packages/protocol";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { TaskRecord } from "../packages/protocol/task-record";
import {
  channelGame,
  channelHistoryLaneIds,
  channelOwnsHistoryRequest,
  requestMayAffectChannel,
  canonicalChannelDeviceKey,
} from "../packages/protocol/account-channel";
import { migrateAccountChannels } from "../apps/desktop/main/channel-migration";
import { assertAgentScheduleClear } from "../apps/desktop/main/agent-schedule-guard";
import {
  guardHistory,
  taskMatchesRequest,
} from "../apps/desktop/main/agent-execution-policy";
import { mumuResource } from "../apps/desktop/main/execution-coordinator";
import { prepareChannelCopies } from "../apps/desktop/main/channel-template";
import { defaultArknightsProfiles } from "../games/arknights/config";

const source: DeviceLane = {
  id: "lane-a",
  name: "原渠道",
  instance: 0,
  managerPath: "D:/MuMu/nx_main/MuMuManager.exe",
  enabled: true,
  arknights: { enabled: true, profileId: "default" },
  onmyoji: { enabled: true },
  deviceInstances: { onmyoji: 2 },
  closeEmulatorAfterSuccess: false,
};
const channels = migrateAccountChannels({ version: 1, lanes: [source] });
const [ark, onm] = channels.lanes;
const now = new Date("2026-10-25T05:00:00Z");
const plan: Plan = {
  gameId: "onmyoji",
  mode: "live",
  skillIds: ["login", "mail"],
};
function receipt(): ExecutionRecord {
  const frozen = structuredClone(source);
  frozen.instance = 2;
  frozen.arknights.enabled = false;
  delete frozen.deviceInstances;
  return {
    version: 1,
    id: "original:lane-a",
    batchId: "original",
    laneId: "lane-a",
    source: "daily",
    resources: [mumuResource(source.managerPath, 2)],
    snapshot: { lane: frozen, onmyojiPlan: plan },
    fingerprint: "original",
    status: "unknown",
    startedAt: "2026-10-25T03:00:00Z",
    finishedAt: "2026-10-25T03:10:00Z",
    message: "unknown",
  };
}
function task(): TaskRecord {
  return {
    version: 1,
    executionId: "original:lane-a",
    batchId: "original",
    laneId: "lane-a",
    instance: 2,
    runId: "run",
    gameId: "onmyoji",
    plan,
    status: "unknown",
    startedAt: "2026-10-25T03:00:00Z",
    updatedAt: "2026-10-25T03:10:00Z",
    message: "unknown",
    steps: [],
  };
}

it("keeps the original receipt and task association while attributing its game to the successor", () => {
  const request = receipt();
  const before = structuredClone(request);
  expect(channelGame(onm)).toBe("onmyoji");
  expect(channelHistoryLaneIds(onm)).toEqual(["lane-a-onmyoji", "lane-a"]);
  expect(channelOwnsHistoryRequest(request, onm)).toBe(true);
  expect(channelOwnsHistoryRequest(request, ark)).toBe(false);
  expect(taskMatchesRequest(task(), request)).toBe(true);
  expect(request).toEqual(before);
});

it("does not let the retained Ark ID acquire an unrelated physical Onmyoji failure", () => {
  const request = receipt();
  expect(requestMayAffectChannel(request, ark)).toBe(false);
  expect(() => assertAgentScheduleClear(ark, [request], now)).not.toThrow();
  expect(() =>
    guardHistory(
      {
        lane: ark,
        startedAt: now.toISOString(),
        arknightsPlan: {
          gameId: "arknights",
          mode: "live",
          skillIds: ["login", "award"],
        },
      },
      { requests: [request], tasks: [task()] },
      now,
    ),
  ).not.toThrow();
  expect(() => assertAgentScheduleClear(onm, [request], now)).toThrow();
});

it("retains mixed and missing-scope uncertainty for both successor channels", () => {
  const request = receipt();
  request.snapshot.lane = source;
  request.snapshot.arknightsPlan = {
    gameId: "arknights",
    mode: "live",
    skillIds: ["login"],
  };
  for (const lane of channels.lanes)
    expect(requestMayAffectChannel(request, lane)).toBe(true);
  delete request.snapshot.arknightsPlan;
  delete request.snapshot.onmyojiPlan;
  for (const lane of channels.lanes)
    expect(requestMayAffectChannel(request, lane)).toBe(true);
});

it.each(["unknown-skill", "contradictory-binding", "future-schema"])(
  "keeps %s evidence conservative when splitting a historical lane",
  (kind) => {
    const request = receipt();
    if (kind === "unknown-skill")
      request.snapshot.onmyojiPlan = { ...plan, skillIds: ["unknown-skill"] };
    if (kind === "contradictory-binding")
      (request.snapshot.lane as DeviceLane).arknights.enabled = true;
    if (kind === "future-schema") request.snapshot.schemaVersion = 999;
    expect(requestMayAffectChannel(request, ark)).toBe(true);
  },
);

it("recognizes normalized physical paths before considering game or legacy IDs", () => {
  const request = receipt();
  request.laneId = "unrelated";
  request.resources = [
    "mumu:d:\\mumu\\nx_main\\..\\nx_main\\MuMuManager.exe#0",
  ];
  expect(requestMayAffectChannel(request, ark)).toBe(true);
});

it("keeps a physical wildcard and a shared emulator exclusive across games", () => {
  const request = receipt();
  request.resources = ["*"];
  expect(requestMayAffectChannel(request, ark)).toBe(true);
  request.resources = [mumuResource(source.managerPath, 0)];
  expect(requestMayAffectChannel(request, ark)).toBe(true);
});

it("copies a fresh channel without inheriting legacy history or its read-only source", () => {
  const result = prepareChannelCopies(
    channels,
    defaultArknightsProfiles,
    {
      sourceLaneId: ark.id,
      gameId: "arknights",
      targets: [{ instance: 5, name: "新渠道" }],
    },
    () => "fresh",
  );
  const copy = result.lanes.lanes.at(-1)!;
  expect(copy.legacyBinding).toBeUndefined();
  expect(channelHistoryLaneIds(copy)).toEqual([copy.id]);
});

it("refuses to copy a V2 channel as a different game's inactive configuration", () => {
  expect(() =>
    prepareChannelCopies(
      channels,
      defaultArknightsProfiles,
      {
        sourceLaneId: onm.id,
        gameId: "arknights",
        targets: [{ instance: 5, name: "错误来源" }],
      },
      () => "fresh",
    ),
  ).toThrow(/来源游戏|源渠道.*游戏/);
});

it.each([
  "D:/MuMu/nx_main/../nx_main/./MuMuManager.exe",
  "d:\\mumu\\nx_main\\MuMuManager.exe",
  "D:/MuMu//nx_main/MuMuManager.exe",
  "D:/MuMu/nx_main/MuMuManager.exe/",
  "D:/../MuMu/nx_main/MuMuManager.exe",
  "\\\\server\\share\\MuMu\\..\\MuMuManager.exe",
  "D:MuMu\\..\\MuMuManager.exe",
  "",
])("uses the same Windows physical key as admission for %s", (manager) => {
  expect(canonicalChannelDeviceKey(manager, 2)).toBe(mumuResource(manager, 2));
});
