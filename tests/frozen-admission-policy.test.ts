import { expect, it } from "vitest";
import { frozenAdmissionPolicy } from "../apps/desktop/main/frozen-admission-policy";
import { freezeLaneExecution } from "../apps/desktop/main/lane-snapshot";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { dailyLaneScope } from "../apps/desktop/main/daily-policy";

it("saved evening daily keeps its original dual-game scope and daily completion authority", () => {
  const fixture = createFixtureSnapshot();
  const lane = fixture.lanes!.lanes[0];
  lane.onmyoji.enabled = true;
  const scope = dailyLaneScope(lane);
  const frozen = freezeLaneExecution(
    lane,
    fixture.profiles!,
    false,
    new Date("2026-10-04T12:00:00Z"),
    "secondary",
  );
  expect(frozen.onmyojiPlan).toBeUndefined();
  expect(dailyLaneScope(frozen.lane)).not.toBe(scope);
  expect(
    frozenAdmissionPolicy(
      {
        requestId: "review",
        kind: "saved-daily",
        daily: { slot: "secondary", scopes: { [lane.id]: scope } },
      },
      frozen,
    ),
  ).toEqual({ source: "daily", custom: false, scope, slot: "secondary" });
  expect(frozenAdmissionPolicy({ requestId: "model" }, frozen)).toMatchObject({
    source: "single",
    custom: true,
  });
  expect(() =>
    frozenAdmissionPolicy({ requestId: "review", kind: "saved-daily" }, frozen),
  ).toThrow();
});
