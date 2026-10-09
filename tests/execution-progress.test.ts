import { expect, it } from "vitest";
import { mergeExecutionProgress } from "../games/execution-progress";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { ExecutionDetail } from "../packages/protocol/execution-detail";
import type { TaskRecord, StepStatus } from "../packages/protocol/task-record";
import { defaultArknightsConfig } from "../games/arknights/config";

function fixture() {
  const lane = {
    id: "a",
    instance: 0,
    managerPath: "D:\\MuMu\\MuMuManager.exe",
    arknights: { profileId: "p" },
  };
  const profile = {
    ...defaultArknightsConfig,
    recruit: false,
    id: "p",
    name: "test",
    expectedUid: "753108577",
    clientType: "Official",
  };
  const root: ExecutionRecord = {
    version: 1,
    id: "root",
    source: "daily",
    laneId: "a",
    batchId: "r",
    resources: ["mumu:a"],
    fingerprint: "root-fingerprint",
    status: "unknown",
    startedAt: "2026-10-03T03:00:00Z",
    finishedAt: "2026-10-03T03:01:00Z",
    message: "original failure",
    snapshot: {
      lane,
      profile,
      arknightsPlan: {
        gameId: "arknights",
        mode: "live",
        skillIds: ["login", "fight", "award"],
      },
    },
  };
  const child: ExecutionRecord = {
    ...structuredClone(root),
    id: "child",
    batchId: "c",
    fingerprint: "child-fingerprint",
    status: "succeeded",
    startedAt: "2026-10-03T03:02:00Z",
    finishedAt: "2026-10-03T03:03:00Z",
    snapshot: {
      lane: structuredClone(lane),
      profile: structuredClone(profile),
      arknightsPlan: {
        gameId: "arknights",
        mode: "live",
        skillIds: ["login", "award"],
      },
      continuation: {
        parentId: root.id,
        parentFingerprint: root.fingerprint,
        retained: [{ gameId: "arknights", skillIds: ["fight"] }],
        excluded: [],
        acknowledgedPartial: true,
      },
    },
  };
  function detail(r: ExecutionRecord, statuses: StepStatus[]): ExecutionDetail {
    const plan = r.snapshot.arknightsPlan as TaskRecord["plan"];
    return {
      request: { ...r },
      warnings: [],
      games: [
        {
          plan,
          record: {
            version: 1,
            runId: "run-" + r.id,
            executionId: r.id,
            laneId: "a",
            batchId: r.batchId,
            instance: 0,
            profileId: "p",
            gameId: "arknights",
            plan,
            startedAt: r.startedAt,
            updatedAt: r.finishedAt!,
            finishedAt: r.finishedAt,
            status: r.status === "succeeded" ? "succeeded" : "failed",
            message: "record",
            steps: plan.skillIds.map((skillId, i) => ({
              skillId,
              status: statuses[i],
              message: "fact",
              diagnostics: [],
            })),
          },
        },
      ],
    };
  }
  const requests = [root, child],
    details = new Map([
      [root.id, detail(root, ["succeeded", "succeeded", "failed"])],
      [child.id, detail(child, ["succeeded", "succeeded"])],
    ]);
  return {
    root,
    child,
    requests,
    details,
    detail,
    run: (id = "root") => mergeExecutionProgress(id, requests, details),
  };
}
it("merges a completed continuation without rewriting the original failure", () => {
  const s = fixture(),
    before = structuredClone(s.requests),
    p = s.run();
  expect(p.outcome).toBe("recovered");
  expect(p.wholePlanComplete).toBe(true);
  expect(p.originalStatus).toBe("unknown");
  expect(p.counts).toEqual({
    total: 2,
    completed: 2,
    skipped: 0,
    excluded: 0,
    remaining: 0,
  });
  expect(p.steps.find((s) => s.skillId === "fight")?.sourceId).toBe("root");
  expect(p.steps.find((s) => s.skillId === "award")?.sourceId).toBe("child");
  expect(s.requests).toEqual(before);
  expect(s.run("child")).toEqual({ ...p, requestId: "child" });
});
it("does not count an explicitly cancelled step as whole plan completion", () => {
  const s = fixture();
  s.root.snapshot.arknightsPlan = {
    gameId: "arknights",
    mode: "live",
    skillIds: ["login", "fight", "friends", "award"],
  };
  s.details.set(
    "root",
    s.detail(s.root, ["succeeded", "succeeded", "failed", "not-run"]),
  );
  (s.child.snapshot.continuation as any).excluded = [
    { gameId: "arknights", skillIds: ["friends"] },
  ];
  const p = s.run();
  expect(p.outcome).toBe("partial");
  expect(p.wholePlanComplete).toBe(false);
  expect(p.counts.excluded).toBe(1);
  expect(p.steps.find((s) => s.skillId === "friends")?.status).toBe("excluded");
});
it.each([
  "fingerprint",
  "uid",
  "instance",
  "resources",
  "day",
  "selection",
  "retained",
  "excluded",
  "source",
  "time",
])("refuses to merge a child with invalid %s", (what) => {
  const s = fixture(),
    link = s.child.snapshot.continuation as any;
  if (what === "fingerprint") link.parentFingerprint = "other";
  if (what === "uid")
    (s.child.snapshot.profile as any).expectedUid = "123456789";
  if (what === "instance") (s.child.snapshot.lane as any).instance = 1;
  if (what === "resources") s.child.resources = ["other-device"];
  if (what === "day") s.child.startedAt = "2026-10-04T03:02:00Z";
  if (what === "selection")
    (s.child.snapshot.arknightsPlan as any).skillIds = [
      "login",
      "fight",
      "award",
    ];
  if (what === "retained") link.retained = [];
  if (what === "excluded")
    link.excluded = [{ gameId: "arknights", skillIds: ["award"] }];
  if (what === "source") s.child.source = "maintenance";
  if (what === "time") s.child.startedAt = "2026-10-03T02:58:00Z";
  const p = s.run();
  expect(p.outcome).toBe("unconfirmed");
  expect(p.wholePlanComplete).toBe(false);
  expect(p.warnings.length).toBeGreaterThan(0);
});
it("refuses ambiguous sibling continuations", () => {
  const s = fixture();
  s.requests.push({ ...structuredClone(s.child), id: "sibling" });
  expect(s.run().outcome).toBe("unconfirmed");
});
it("refuses missing parents and cyclic links", () => {
  const s = fixture();
  s.requests.splice(0, 1);
  expect(s.run("child").outcome).toBe("unconfirmed");
  s.requests.unshift(s.root);
  s.root.snapshot.continuation = { parentId: "child" };
  expect(s.run("child").outcome).toBe("unconfirmed");
});
it("does not infer completion from succeeded requests with missing task evidence", () => {
  const s = fixture();
  s.details.get("child")!.games[0].record = undefined;
  expect(s.run().wholePlanComplete).toBe(false);
});
it("keeps the latest continuation live while preserving already completed original steps", () => {
  const s = fixture();
  s.child.status = "running";
  s.child.finishedAt = undefined;
  const d = s.details.get("child")!,
    task = d.games[0].record!;
  task.status = "running";
  task.finishedAt = undefined;
  task.steps[1].status = "running";
  expect(s.run().outcome).toBe("running");
  expect(s.run().counts.completed).toBe(1);
  expect(s.run().wholePlanComplete).toBe(false);
});
it("requires latest request success even when steps ended before a close failure", () => {
  const s = fixture();
  s.child.status = "unknown";
  expect(s.run().wholePlanComplete).toBe(false);
});
it("requires a successful terminal task as well as successful steps", () => {
  const s = fixture();
  s.details.get("child")!.games[0].record!.status = "failed";
  expect(s.run().wholePlanComplete).toBe(false);
});
it("refuses a continuation that changes the frozen task settings", () => {
  const s = fixture();
  (s.child.snapshot.profile as any).stage = "CE-6";
  expect(s.run().wholePlanComplete).toBe(false);
});
it("does not use maintenance records to prove daily completion", () => {
  const s = fixture();
  s.details.get("child")!.games[0].record!.maintenance = true;
  expect(s.run().wholePlanComplete).toBe(false);
});
it.each(["root", "child"])(
  "does not confirm a terminal %s missing its finish timestamp",
  (id) => {
    const s = fixture();
    if (id === "root") {
      s.root.status = "succeeded";
      s.root.finishedAt = undefined;
      s.requests.splice(1, 1);
      s.details.set(
        "root",
        s.detail(s.root, ["succeeded", "succeeded", "succeeded"]),
      );
      // A complete task cannot substitute for the missing request lifecycle evidence.
      s.details.get("root")!.games[0].record!.finishedAt =
        "2026-10-03T03:01:00Z";
    } else s.child.finishedAt = undefined;
    expect(s.run().wholePlanComplete).toBe(false);
  },
);
it("handles multiple valid successive continuations", () => {
  const s = fixture();
  s.child.status = "unknown";
  s.details.set("child", s.detail(s.child, ["succeeded", "failed"]));
  const grand = {
    ...structuredClone(s.child),
    id: "grand",
    batchId: "g",
    status: "succeeded" as const,
    fingerprint: "grand",
    startedAt: "2026-10-03T03:04:00Z",
    finishedAt: "2026-10-03T03:05:00Z",
  };
  grand.snapshot.continuation = {
    parentId: "child",
    parentFingerprint: s.child.fingerprint,
    retained: [],
    excluded: [],
    acknowledgedPartial: true,
  };
  s.requests.push(grand);
  s.details.set("grand", s.detail(grand, ["succeeded", "succeeded"]));
  expect(s.run().outcome).toBe("recovered");
  expect(s.run().latestId).toBe("grand");
});
it("keeps a single task result scoped as single instead of turning it into a daily result", () => {
  const s = fixture();
  s.root.source = "single";
  expect(s.run().source).toBe("single");
  expect(s.run().outcome).toBe("recovered");
});
it("keeps verified recovery facts after the original issue was closed later", () => {
  const s = fixture();
  s.root.resolution = {
    action: "abandoned",
    at: "2026-10-03T03:04:00Z",
    note: "reviewed after completion",
  };
  expect(s.run().outcome).toBe("recovered");
  s.root.resolution.at = "2026-10-03T03:01:30Z";
  expect(s.run().wholePlanComplete).toBe(false);
});
it("refuses to treat malformed continuation metadata as an independent complete plan", () => {
  const s = fixture();
  s.child.snapshot.continuation = "invalid";
  s.requests = [s.child];
  expect(
    mergeExecutionProgress("child", s.requests, s.details).wholePlanComplete,
  ).toBe(false);
});
