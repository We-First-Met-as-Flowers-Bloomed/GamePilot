import { expect, it } from "vitest";
import { arknightsMode, onmyojiMode } from "../scripts/game-mode/plans";
import { mergeStatus, type AppRequest } from "../scripts/game-mode/status";
import type { LaneRun } from "../scripts/game-mode/report";

const scope = '["mumu",0,"profile-a",true]';
const lanes = [
  {
    id: "lane-a",
    name: "Ark A",
    enabled: { arknights: true, onmyoji: false },
    legacyBinding: { laneId: "lane-a", instance: 0, scope },
  },
  {
    id: "lane-a-onmyoji",
    name: "Onm A",
    enabled: { arknights: false, onmyoji: true },
    legacyBinding: { laneId: "lane-a", instance: 2, scope },
  },
];
const plans = [
  {
    ...arknightsMode,
    steps: arknightsMode.steps.filter((step) => step.skill === "login"),
  },
  {
    ...onmyojiMode,
    steps: onmyojiMode.steps.filter((step) => step.skill === "mail"),
  },
];
const at = "2026-10-25T04:00:00.000Z";

it("reads the original mixed request into each successor game without modifying its record", () => {
  const requests: AppRequest[] = [
    {
      requestId: "old-mixed",
      laneId: "lane-a",
      status: "succeeded",
      finishedAt: at,
      games: {
        arknights: { steps: [{ stepId: "login", status: "succeeded", at }] },
        onmyoji: { steps: [{ stepId: "mail", status: "succeeded", at }] },
      },
    },
  ];
  const before = JSON.stringify(requests);
  const statuses = mergeStatus({ plans, lanes, requests, runs: [] });
  expect(
    statuses.map((status) => [status.lane, status.game, status.items[0].state]),
  ).toEqual([
    ["lane-a", "arknights", "succeeded"],
    ["lane-a-onmyoji", "onmyoji", "succeeded"],
  ]);
  expect(JSON.stringify(requests)).toBe(before);
});

it("shows original Onmyoji run artifacts on the successor while leaving the artifact unchanged", () => {
  const runs: LaneRun[] = [
    {
      lane: "lane-a",
      laneName: "Original A",
      game: "onmyoji",
      address: "127.0.0.1:16448",
      startedAt: at,
      finishedAt: at,
      outcomes: [
        {
          skill: "mail",
          label: "mail",
          required: true,
          attempts: 1,
          status: "succeeded",
          summary: "完成",
        },
      ],
    },
  ];
  const before = JSON.stringify(runs);
  const statuses = mergeStatus({ plans, lanes, requests: [], runs });
  expect(statuses[1].items[0]).toMatchObject({
    state: "succeeded",
    source: "game-mode",
  });
  expect(statuses[0].items[0].state).toBe("pending");
  expect(JSON.stringify(runs)).toBe(before);
});

it("does not hide an unresolved original Onmyoji request after channels split", () => {
  const statuses = mergeStatus({
    plans,
    lanes,
    runs: [],
    requests: [
      {
        requestId: "old-onmyoji",
        laneId: "lane-a",
        status: "unknown",
        startedAt: at,
        games: { onmyoji: { steps: [] } },
      },
    ],
  });
  expect(statuses[1]).toMatchObject({ catchupBlocked: true });
  expect(statuses[1].items[0].state).toBe("unknown");
  expect(statuses[0].items[0].state).toBe("pending");
});
