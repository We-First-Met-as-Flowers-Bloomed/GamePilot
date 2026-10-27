import { describe, expect, it } from "vitest";

const modulePath = "../scripts/shared/daily-ownership.mjs";
const api = await import(/* @vite-ignore */ modulePath).catch(() => ({}));
const assess = api.assessDailyOwnership as
  | ((
      response: unknown,
      lanes: unknown[],
      target: number,
      persisted: unknown[],
    ) => { allowed: boolean })
  | undefined;
const lanes = [
  { id: "lane-a", instance: 0, deviceInstances: { onmyoji: 2 } },
  { id: "lane-b", instance: 1 },
];
const response = (requests: unknown[]) => ({ ok: true, result: { requests } });
const decision = (input: unknown, persisted: unknown[] = []) => {
  expect(
    assess,
    "daily ownership must inspect host and offline records",
  ).toBeTypeOf("function");
  return assess!(input, lanes, 0, persisted);
};

describe("legacy daily ownership checks", () => {
  it("rejects active host requests on the target device", () => {
    expect(
      decision(response([{ laneId: "lane-a", status: "running" }])).allowed,
    ).toBe(false);
  });
  it("does not block unrelated devices", () => {
    expect(
      decision(response([{ laneId: "lane-b", status: "running" }])).allowed,
    ).toBe(true);
  });
  it("closed App permits the scheduled run when offline records are conclusive", () => {
    expect(
      decision({ ok: false, error: { code: "APP_NOT_RUNNING" } }, [
        { laneId: "lane-a", status: "succeeded" },
      ]).allowed,
    ).toBe(true);
  });
  it("closed App never erases an unresolved unknown record", () => {
    expect(
      decision({ ok: false, error: { code: "APP_NOT_RUNNING" } }, [
        { laneId: "lane-a", status: "unknown" },
      ]).allowed,
    ).toBe(false);
  });
  it.each(["CONNECTION_FAILED", "TIMEOUT", "INVALID_DISCOVERY"])(
    "fails closed on %s",
    (code) => {
      expect(decision({ ok: false, error: { code } }).allowed).toBe(false);
    },
  );
  it("missing lane binding or malformed successful status is uncertain", () => {
    expect(decision(response([{ status: "running" }])).allowed).toBe(false);
    expect(decision({ ok: true, result: {} }).allowed).toBe(false);
  });
  it("keeps the frozen physical device blocked after the lane is remapped", () => {
    expect(
      decision(response([]), [
        {
          laneId: "lane-b",
          status: "unknown",
          resources: [
            "mumu:d:\\mumu12\\mumu player 12\\nx_main\\mumumanager.exe#0",
          ],
        },
      ]).allowed,
    ).toBe(false);
  });
});
