import { describe, expect, it } from "vitest";
import {
  acceptanceBindingHash,
  evaluateObservationWindow,
  verifyDailyEvidence,
} from "../packages/acceptance/criteria";
import type {
  DailyExpectation,
  DailyInspection,
} from "../packages/acceptance/report";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { TaskRecord } from "../packages/protocol/task-record";
import { createHash } from "node:crypto";
import { canonical } from "../packages/acceptance/files";

const expectation: DailyExpectation = {
  date: "2026-10-04",
  laneId: "lane-a",
  instance: 0,
  slot: "secondary",
  dueTime: "20:00",
  plans: [{ gameId: "arknights", mode: "live", skillIds: ["login"] }],
};
const round: DailyInspection = {
  date: expectation.date,
  laneId: expectation.laneId,
  slot: "secondary",
  state: "flow-ended",
  requestIds: ["r"],
  continuationIds: [],
  interventionRecorded: false,
  notes: [],
  reviewRequired: true,
};
const request: ExecutionRecord = {
  version: 1,
  id: "r",
  laneId: "lane-a",
  batchId: "b",
  source: "daily",
  resources: ["device"],
  fingerprint: "bad",
  status: "succeeded",
  startedAt: "2026-10-04T12:00:01Z",
  finishedAt: "2026-10-04T12:02:00Z",
  message: "ok",
  snapshot: {
    schemaVersion: 1,
    schedule: {
      origin: "scheduler",
      slot: "secondary",
      dueAt: "2026-10-04T12:00:00Z",
    },
    lane: { id: "lane-a", instance: 0 },
  },
};

describe("machine-verifiable acceptance", () => {
  function verifiedRound() {
    const r = structuredClone(request);
    r.snapshot.lane = {
      id: "lane-a",
      instance: 0,
      adbPath: "C:/adb.exe",
      address: "127.0.0.1:16384",
      arknights: { profileId: "p" },
    };
    r.snapshot.profile = {
      id: "p",
      expectedUid: "123456789",
      clientType: "Official",
    };
    r.snapshot.arknightsPlan = expectation.plans[0];
    expectation.bindingHash = acceptanceBindingHash(r.snapshot);
    r.fingerprint = createHash("sha256")
      .update(
        canonical({
          id: r.id,
          source: r.source,
          resources: r.resources,
          snapshot: r.snapshot,
          laneId: r.laneId,
          batchId: r.batchId,
        }),
      )
      .digest("hex");
    const task: TaskRecord = {
      version: 1,
      executionId: r.id,
      laneId: r.laneId,
      batchId: r.batchId,
      runId: "run",
      instance: 0,
      profileId: "p",
      gameId: "arknights",
      plan: expectation.plans[0],
      status: "succeeded",
      startedAt: r.startedAt,
      finishedAt: "2026-10-04T12:01:00Z",
      updatedAt: "2026-10-04T12:01:00Z",
      message: "ok",
      steps: [
        {
          skillId: "login",
          status: "succeeded",
          startedAt: r.startedAt,
          finishedAt: "2026-10-04T12:01:00Z",
          message: "ok",
          diagnostics: [],
          result: {
            arknights: {
              version: 1,
              taskType: "StartUp",
              taskId: 1,
              submission: "submitted",
              completion: "native-confirmed",
              observedAt: "2026-10-04T12:00:40Z",
              login: {
                expectedUid: "123456789",
                observedUid: "123456789",
                observedAt: "2026-10-04T12:00:50Z",
                home: true,
              },
            },
          },
        },
      ],
    };
    r.observations = [
      {
        version: 1,
        kind: "game-exit",
        gameId: "arknights",
        method: "adb-process-check",
        executionId: r.id,
        fingerprint: r.fingerprint,
        laneId: r.laneId,
        batchId: r.batchId,
        device: { adbPath: "C:/adb.exe", address: "127.0.0.1:16384" },
        packageName: "com.hypergryph.arknights",
        firstObservedAt: "2026-10-04T12:01:10Z",
        observedAt: "2026-10-04T12:01:11Z",
        notRunning: [true, true],
      },
    ];
    return { r, task };
  }
  it("accepts uniquely associated, bounded account and exit evidence", () => {
    const { r, task } = verifiedRound();
    expect(verifyDailyEvidence(expectation, round, [r], [task]).status).toBe(
      "passed",
    );
    r.observations![0].packageName = "com.other.game";
    expect(verifyDailyEvidence(expectation, round, [r], [task]).status).toBe(
      "insufficient-evidence",
    );
  });
  it("refuses stale identity, wrong device, duplicate exit and changed frozen parameters", () => {
    for (const change of [
      (r: ExecutionRecord, t: TaskRecord) => {
        t.steps[0].result!.arknights!.login!.observedUid = "987654321";
      },
      (r: ExecutionRecord) => {
        r.observations![0].device.address = "other";
      },
      (r: ExecutionRecord) => {
        r.observations!.push(structuredClone(r.observations![0]));
      },
      (r: ExecutionRecord) => {
        r.snapshot.extra = "changed";
      },
    ]) {
      const { r, task } = verifiedRound();
      change(r, task);
      expect(verifyDailyEvidence(expectation, round, [r], [task]).status).toBe(
        "insufficient-evidence",
      );
    }
  });
  it("keeps legacy flow completion insufficient with explicit missing evidence", () => {
    const proof = verifyDailyEvidence(
      { ...expectation, bindingHash: undefined },
      round,
      [request],
      [],
    );
    expect(proof.status).toBe("insufficient-evidence");
    expect(proof.checks.find((c) => c.id === "immutable-request")?.status).toBe(
      "missing",
    );
    expect(
      proof.checks.some(
        (c) => c.id === "arknights-exit" && c.status === "missing",
      ),
    ).toBe(true);
  });
  it("rejects internally consistent account or physical binding swaps against the baseline", () => {
    for (const field of ["expectedUid", "clientType", "id"]) {
      const { r, task } = verifiedRound();
      (r.snapshot.profile as Record<string, unknown>)[field] = "different";
      r.fingerprint = createHash("sha256")
        .update(
          canonical({
            id: r.id,
            source: r.source,
            resources: r.resources,
            snapshot: r.snapshot,
            laneId: r.laneId,
            batchId: r.batchId,
          }),
        )
        .digest("hex");
      expect(
        verifyDailyEvidence(expectation, round, [r], [task]).checks.find(
          (c) => c.id === "baseline-binding",
        )?.status,
      ).toBe("failed");
    }
    const { r, task } = verifiedRound();
    (r.snapshot.lane as Record<string, unknown>).managerPath =
      "D:/Other/MuMuManager.exe";
    expect(
      verifyDailyEvidence(expectation, round, [r], [task]).checks.find(
        (c) => c.id === "baseline-binding",
      )?.status,
    ).toBe("failed");
  });
  it("accepts actual frozen MuMu lanes and rejects another physical resource or ADB binary", () => {
    const { r, task } = verifiedRound();
    r.snapshot.lane = {
      id: "lane-a",
      managerPath: "C:/MuMu/MuMuManager.exe",
      instance: 0,
      arknights: { profileId: "p" },
    };
    r.resources = ["mumu:c:\\mumu\\mumumanager.exe#0"];
    expectation.bindingHash = acceptanceBindingHash(r.snapshot);
    r.fingerprint = createHash("sha256")
      .update(
        canonical({
          id: r.id,
          source: r.source,
          resources: r.resources,
          snapshot: r.snapshot,
          laneId: r.laneId,
          batchId: r.batchId,
        }),
      )
      .digest("hex");
    const exit = r.observations![0];
    exit.fingerprint = r.fingerprint;
    exit.physicalResource = r.resources[0];
    exit.device.adbPath = "C:/MuMu/adb.exe";
    expect(verifyDailyEvidence(expectation, round, [r], [task]).status).toBe(
      "passed",
    );
    exit.physicalResource = "mumu:c:\\other\\mumumanager.exe#0";
    expect(verifyDailyEvidence(expectation, round, [r], [task]).status).toBe(
      "insufficient-evidence",
    );
    exit.physicalResource = r.resources[0];
    exit.device.adbPath = "C:/Other/adb.exe";
    expect(verifyDailyEvidence(expectation, round, [r], [task]).status).toBe(
      "insufficient-evidence",
    );
  });
  it.each([{}, "bad", null, Array(17).fill(null)])(
    "handles malformed observation fields without crashing",
    (value) => {
      const { r, task } = verifiedRound();
      r.observations = value as typeof r.observations;
      expect(verifyDailyEvidence(expectation, round, [r], [task]).status).toBe(
        "insufficient-evidence",
      );
    },
  );
  it("does not interpret daily source as scheduler provenance", () => {
    const r = structuredClone(request);
    delete (r.snapshot.schedule as Record<string, unknown>).origin;
    const proof = verifyDailyEvidence(expectation, round, [r], []);
    expect(proof.checks.find((c) => c.id === "schedule-origin")?.status).toBe(
      "missing",
    );
  });
  it("rejects explicit failure and intervened rounds", () => {
    expect(
      verifyDailyEvidence(
        expectation,
        { ...round, state: "failed" },
        [request],
        [],
      ).status,
    ).toBe("failed");
    expect(
      verifyDailyEvidence(
        expectation,
        { ...round, interventionRecorded: true },
        [request],
        [],
      ).status,
    ).toBe("failed");
  });
  it("does not parse unsupported snapshot proof even when fields look familiar", () => {
    const r = {
      ...request,
      snapshot: { ...request.snapshot, schemaVersion: 99 },
    };
    const proof = verifyDailyEvidence(expectation, round, [r], []);
    expect(proof.checks.find((c) => c.id === "snapshot-schema")?.status).toBe(
      "missing",
    );
  });
  it("requires elapsed seven days, every frozen slot and no data/config drift", () => {
    const make = () =>
      Array.from({ length: 7 }, (_, day) => ({
        ...round,
        date: `2026-10-${String(day + 4).padStart(2, "0")}`,
        verification: { status: "passed" as const, checks: [] },
      }));
    const options = {
      start: "2026-10-04",
      end: "2026-10-10",
      now: new Date("2026-10-11T00:00:00Z"),
      dataErrors: [] as string[],
      configChanges: [] as string[],
    };
    expect(evaluateObservationWindow(make(), options).status).toBe("passed");
    expect(
      evaluateObservationWindow(make(), {
        ...options,
        now: new Date("2026-10-10T10:00:00Z"),
      }).status,
    ).toBe("observing");
    expect(evaluateObservationWindow(make().slice(0, 6), options).status).toBe(
      "insufficient-evidence",
    );
    expect(
      evaluateObservationWindow([...make(), make()[0]], options).status,
    ).toBe("insufficient-evidence");
    expect(
      evaluateObservationWindow(make(), {
        ...options,
        configChanges: ["device-lanes.json"],
      }).status,
    ).toBe("failed");
    expect(
      evaluateObservationWindow(make(), { ...options, dataErrors: ["corrupt"] })
        .status,
    ).toBe("insufficient-evidence");
  });
});
