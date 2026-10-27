import { expect, it } from "vitest";
import * as catchup from "../scripts/game-mode/catchup";
import * as report from "../scripts/game-mode/report";

it.each(["succeeded", "failed", "cancelled", "unknown"] as const)(
  "uses exact durable App %s receipts for both games without reading native aggregates",
  async (status) => {
    const { runGameMode } = await import("../scripts/game-mode.mjs");
    const reports: string[] = [];
    const reads: string[] = [];
    const calls: unknown[][] = [];
    const result = await runGameMode([], {
      read: (file) => {
        reads.push(file);
        return JSON.stringify({
          lanes: [
            {
              id: "ark-a",
              enabled: true,
              instance: 0,
              arknights: { enabled: true },
              onmyoji: { enabled: false },
            },
            {
              id: "yys-a",
              enabled: true,
              instance: 2,
              arknights: { enabled: false },
              onmyoji: { enabled: true },
            },
          ],
        });
      },
      run: async (...args) => {
        calls.push(args);
        return {
          batchId: `exact-${args[2]}`,
          laneId: args[1],
          gameId: args[2],
          status,
          message: "App的真实执行回执",
        };
      },
      write: (_file, body) => reports.push(body),
      mkdir: () => {},
      log: () => {},
      root: "D:/fixture",
    });
    expect(result).toBe(status === "succeeded" ? 0 : 1);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/device-lanes.json$/);
    expect(calls.map((call) => call[2]).sort()).toEqual([
      "arknights",
      "onmyoji",
    ]);
    expect(reports.join("\n")).toContain("exact-onmyoji");
    expect(reports.join("\n")).toContain("exact-arknights");
    expect(reports.join("\n")).toContain(status);
    expect(reports.join("\n")).toContain("App的真实执行回执");
    expect(reports.join("\n")).not.toContain("完成 **6/6**");
  },
);

it("shows the App catch-up entry for Arknights without proposing unsupported temporary steps", () => {
  const markdown = catchup.renderCatchup([
    {
      lane: "ark-a",
      laneName: "方舟账号",
      game: "arknights",
      skills: ["recruit"],
      labels: ["公招"],
    },
  ]);
  expect(markdown).toContain("arknights-app.mjs --due");
  expect(markdown).not.toContain("--only");
});

it("requires both native step evidence and an exact successful App receipt for a mixed invocation", () => {
  const input: Parameters<typeof report.gameModeRunSucceeded>[0] = {
    combos: [
      { lane: "onm-a", game: "onmyoji" },
      { lane: "ark-a", game: "arknights" },
    ],
    results: [
      { lane: "onm-a", game: "onmyoji", code: 0 },
      { lane: "ark-a", game: "arknights", code: 0 },
    ],
    runs: [],
    appRuns: [{ lane: "ark-a", batchId: "app-batch", status: "succeeded" }],
  };
  expect(report.gameModeRunSucceeded(input)).toBe(false);
  input.runs = [
    {
      lane: "onm-a",
      laneName: "阴阳师",
      game: "onmyoji",
      address: "unused",
      startedAt: "2026-10-26T01:00:00Z",
      finishedAt: "2026-10-26T02:00:00Z",
      outcomes: [
        {
          skill: "mail",
          label: "邮件",
          required: true,
          status: "succeeded",
          attempts: 1,
        },
      ],
    },
  ];
  expect(report.gameModeRunSucceeded(input)).toBe(true);
  input.appRuns[0].status = "running";
  expect(report.gameModeRunSucceeded(input)).toBe(false);
  input.appRuns[0].status = "succeeded";
  input.runs[0].outcomes[0].status = "failed";
  expect(report.gameModeRunSucceeded(input)).toBe(false);
});
