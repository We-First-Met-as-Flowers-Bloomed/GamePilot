import { expect, it } from "vitest";
import {
  ArknightsTaskEvidence,
  validArknightsEvidence,
} from "../games/arknights/evidence";
const msg = (code: number, details: Record<string, unknown>) =>
  `MAA ${code}: ${JSON.stringify(details)}`;
it("persists recognition only for a matching completed native task and redacts credential/image fields", () => {
  const tracker = new ArknightsTaskEvidence("OperBox");
  tracker.accept(msg(10001, { taskchain: "OperBox", taskid: 1 }));
  tracker.accept(
    msg(20003, {
      taskchain: "OperBox",
      taskid: 2,
      what: "OperBoxInfo",
      details: { own_opers: [{ name: "wrong" }] },
    }),
  );
  tracker.accept(
    msg(20003, {
      taskchain: "OperBox",
      taskid: 1,
      what: "OperBoxInfo",
      details: {
        own_opers: [{ name: "先锋", level: 50 }],
        token: "hidden",
        screenshot: "hidden",
      },
    }),
  );
  expect(tracker.finish(true, false).recognition).toBeUndefined();
  tracker.accept(msg(10002, { taskchain: "OperBox", taskid: 1 }));
  const result = tracker.finish(true, true);
  expect(result.recognition?.events).toHaveLength(1);
  expect(JSON.stringify(result.recognition)).not.toContain("hidden");
  expect(validArknightsEvidence(result)).toBe(true);
  expect(
    validArknightsEvidence({
      ...result,
      recognition: { ...result.recognition, taskId: 2 },
    }),
  ).toBe(false);
});
it("bounds raw recognition size without inferring missing quantities", () => {
  const tracker = new ArknightsTaskEvidence("Depot");
  tracker.accept(msg(10001, { taskchain: "Depot", taskid: 1 }));
  tracker.accept(
    msg(20003, {
      taskchain: "Depot",
      taskid: 1,
      what: "DepotInfo",
      details: { items: [{ id: "item", count: 3 }] },
    }),
  );
  tracker.accept(
    msg(20003, {
      taskchain: "Depot",
      taskid: 1,
      what: "DepotInfo",
      details: {
        items: Array.from({ length: 2001 }, () => ({ id: "x", count: 1 })),
      },
    }),
  );
  tracker.accept(msg(10002, { taskchain: "Depot", taskid: 1 }));
  const output = tracker.finish(true, true).recognition!;
  expect(output.truncated).toBe(true);
  expect(output.events).toHaveLength(1);
});

it("rejects recognition attached to an unknown or unsubmitted task even when native IDs and payload match", () => {
  const tracker = new ArknightsTaskEvidence("OperBox");
  tracker.accept(msg(10001, { taskchain: "OperBox", taskid: 1 }));
  tracker.accept(
    msg(20003, {
      taskchain: "OperBox",
      taskid: 1,
      what: "OperBoxInfo",
      details: { own_opers: [{ name: "先锋", level: 50 }] },
    }),
  );
  tracker.accept(msg(10002, { taskchain: "OperBox", taskid: 1 }));
  const result = tracker.finish(true, true);
  expect(validArknightsEvidence(result)).toBe(true);
  expect(validArknightsEvidence({ ...result, completion: "unknown" })).toBe(
    false,
  );
  expect(
    validArknightsEvidence({
      ...result,
      submission: "not-submitted",
      completion: "not-started",
      taskId: undefined,
    }),
  ).toBe(false);
});
