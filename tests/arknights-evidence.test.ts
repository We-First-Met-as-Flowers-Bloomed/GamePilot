import { expect, it } from "vitest";
import {
  ArknightsTaskEvidence,
  validArknightsEvidence,
} from "../games/arknights/evidence";
const msg = (code: number, taskchain = "Fight", taskid = 1) =>
  `MAA ${code}: ${JSON.stringify({ taskchain, taskid })}`;
it("validates profile identity and later home evidence together while preserving legacy login records", () => {
  const e = {
    version: 1,
    taskType: "StartUp",
    submission: "submitted",
    completion: "native-confirmed",
    taskId: 1,
    observedAt: "2026-09-30T12:00:00Z",
    login: {
      expectedUid: "864209759",
      observedUid: "864209759",
      observedAt: "2026-09-30T12:00:01Z",
      home: true,
    },
  };
  expect(validArknightsEvidence(e)).toBe(true);
  expect(
    validArknightsEvidence({
      ...e,
      login: {
        ...e.login,
        method: "profile",
        homeObservedAt: "2026-09-30T12:00:02Z",
      },
    }),
  ).toBe(true);
  for (const patch of [
    { method: "profile" },
    { homeObservedAt: "2026-09-30T12:00:02Z" },
    { method: "other", homeObservedAt: "2026-09-30T12:00:02Z" },
    { method: "profile", homeObservedAt: "2026-09-30T12:00:00Z" },
    { method: "profile", homeObservedAt: "bad" },
  ])
    expect(
      validArknightsEvidence({ ...e, login: { ...e.login, ...patch } }),
    ).toBe(false);
});
const settlement = (details: unknown, taskid = 1, taskchain = "Fight") =>
  `MAA 20003: ${JSON.stringify({ taskchain, taskid, what: "StageDrops", details })}`;
it("records only the latest matching settlement batch, not an invented total or completion", () => {
  const e = new ArknightsTaskEvidence("Fight");
  const drops = settlement({
    stage: { stageCode: "LS-6" },
    stars: 3,
    cur_times: 3,
  });
  e.accept(drops); // Before task start is not attributable.
  expect(e.finish(true, false).lastSettlement).toBeUndefined();
  e.accept(msg(10001));
  e.accept(drops);
  e.accept(drops); // Never sum replayed callbacks.
  expect(e.finish(true, false)).toMatchObject({
    completion: "unknown",
    lastSettlement: { stage: "LS-6", stars: 3, batchRuns: 3 },
  });
  e.accept(
    settlement({ stage: { stageCode: "LS-6" }, stars: 3, cur_times: 1 }),
  );
  e.accept(msg(10002));
  e.accept(settlement({ stage: { stageCode: "1-7" }, stars: 2, cur_times: 5 }));
  expect(e.finish(true, true)).toMatchObject({
    completion: "native-confirmed",
    lastSettlement: { stage: "LS-6", stars: 3, batchRuns: 1 },
  });
  expect(e.finish(false, false).lastSettlement).toBeUndefined();
});
it("ignores unrelated and malformed settlement fields; absent batch counts remain unknown", () => {
  const e = new ArknightsTaskEvidence("Fight");
  e.accept(msg(10001));
  const valid = { stage: { stageCode: "LS-6" }, stars: 3, cur_times: 3 };
  e.accept(settlement(valid, 2));
  e.accept(settlement(valid, 1, "Award"));
  e.accept(settlement({ ...valid, stars: 4 }));
  e.accept(settlement({ ...valid, stage: { stageCode: "<bad>" } }));
  expect(e.finish(true, false).lastSettlement).toBeUndefined();
  e.accept(settlement({ stage: { stageCode: "LS-6" }, stars: 2 }));
  expect(e.finish(true, false).lastSettlement).toEqual({
    stage: "LS-6",
    stars: 2,
  });
  const other = new ArknightsTaskEvidence("Award");
  other.accept(msg(10001, "Award"));
  other.accept(settlement(valid, 1, "Award"));
  expect(other.finish(true, false).lastSettlement).toBeUndefined();
});
it("validates persisted settlement evidence without breaking old records", () => {
  const e = new ArknightsTaskEvidence("Fight");
  e.accept(msg(10001));
  const evidence = {
    ...e.finish(true, false),
    lastSettlement: { stage: "LS-6", stars: 3, batchRuns: 3 },
  };
  expect(validArknightsEvidence(evidence)).toBe(true);
  for (const patch of [
    { taskType: "Award" },
    {
      submission: "not-submitted",
      completion: "not-started",
      taskId: undefined,
    },
    { lastSettlement: { stage: "LS-6", stars: 3, batchRuns: 0 } },
    { lastSettlement: { stage: "LS-6", stars: 3, batchRuns: 1.5 } },
    { lastSettlement: { stage: "LS-6", stars: 9 } },
  ])
    expect(validArknightsEvidence({ ...evidence, ...patch })).toBe(false);
});
it("requires matching task start and completion, not the global completed callback alone", () => {
  const evidence = new ArknightsTaskEvidence("Fight");
  evidence.accept("MAA 3: {}");
  expect(evidence.finish(true, true).completion).toBe("unknown");
  evidence.accept(msg(10001));
  evidence.accept(msg(10002));
  expect(evidence.finish(true, true)).toMatchObject({
    submission: "submitted",
    completion: "native-confirmed",
    taskId: 1,
    taskType: "Fight",
  });
});
it("does not accept another task, a completion before start, or error followed by success", () => {
  for (const messages of [
    [msg(10001), msg(10002, "Award")],
    [msg(10002), msg(10001)],
    [msg(10001), msg(10002, "Fight", 2)],
    [msg(10001), msg(10000), msg(10002)],
    [msg(10001), "MAA 10002: broken"],
  ]) {
    const e = new ArknightsTaskEvidence("Fight");
    messages.forEach((m) => e.accept(m));
    expect(e.finish(true, true).completion).toBe("unknown");
  }
});
it("records a pre-submission failure separately and keeps a post-submission failure unknown", () => {
  const e = new ArknightsTaskEvidence("Fight");
  e.accept(msg(10001));
  e.accept(msg(10002));
  expect(e.finish(false, false)).toMatchObject({
    submission: "not-submitted",
    completion: "not-started",
  });
  expect(e.finish(true, false)).toMatchObject({
    submission: "submitted",
    completion: "unknown",
  });
});
it("drops settlement attribution if the native task identity changes", () => {
  const e = new ArknightsTaskEvidence("Fight");
  e.accept(msg(10001));
  e.accept(
    settlement({ stage: { stageCode: "LS-6" }, stars: 3, cur_times: 3 }),
  );
  e.accept(msg(10001, "Fight", 2));
  expect(e.finish(true, false).lastSettlement).toBeUndefined();
});
it("rejects contradictory persisted evidence", () => {
  const e = new ArknightsTaskEvidence("Fight");
  expect(validArknightsEvidence(e.finish(false, false))).toBe(true);
  expect(
    validArknightsEvidence({
      ...e.finish(false, false),
      completion: "native-confirmed",
      taskId: 1,
    }),
  ).toBe(false);
  expect(
    validArknightsEvidence({ ...e.finish(true, true), observedAt: "bad" }),
  ).toBe(false);
});
