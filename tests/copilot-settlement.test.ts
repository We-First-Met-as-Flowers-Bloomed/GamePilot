import { describe, expect, it } from "vitest";
import {
  CopilotTaskEvidence,
  validArknightsEvidence,
} from "../games/arknights/evidence";
const job = {
  id: 1001,
  sha256: "a".repeat(64),
  file: "D:/fixture/copilot-library/1001.json",
  stageName: "stage_go_8",
  title: "fixture",
};
const node = "Copilot@StageDrops-Stars-3";
const callback = (code: number, what?: string, details?: unknown) =>
  `MAA ${code}: ${JSON.stringify({ taskchain: "Copilot", taskid: 7, ...(what ? { what, details } : {}) })}`;
const load = (index = 0, override = {}) =>
  callback(20003, "CopilotListLoadTaskFileSuccess", {
    id: index,
    file_name: job.file,
    stage_name: job.stageName,
    ...override,
  });
const process = (code: number, task = node, exec_times = 1) =>
  callback(code, "ProcessTask", {
    task,
    exec_times,
    max_times: 999999999,
    action: "DoNothing",
    algorithm: "MatchTemplate",
    result: { score: 0.99 },
  });
function tracker(count = 1) {
  const t = new CopilotTaskEvidence(
    "b".repeat(64),
    "stage_go_8",
    Array.from({ length: count }, () => ({ ...job })),
  );
  t.accept(callback(10001));
  return t;
}
function verified() {
  const t = tracker();
  t.accept(load());
  t.accept(process(20000));
  t.accept(process(20002));
  t.accept(callback(10002));
  const e = t.finish(true, true),
    base = Date.parse("2026-10-12T01:00:00.000Z"),
    at = (ms: number) => new Date(base + ms).toISOString();
  const before = {
    taskId: 1,
    expectedUid: "12345678",
    observedUid: "12345678",
    method: "profile" as const,
    home: true as const,
    observedAt: at(0),
    homeObservedAt: at(100),
  };
  e.observedAt = at(1250);
  e.copilot!.verification = {
    planHash: e.copilot!.planHash,
    expectedUid: before.expectedUid,
    before,
    submittedAt: at(200),
    completedAt: at(1000),
    after: {
      ...before,
      taskId: 2,
      observedAt: at(1100),
      homeObservedAt: at(1200),
    },
  };
  return e;
}
describe("fixed engine Copilot settlement evidence", () => {
  it("requires a loaded matching job and paired native three-star callbacks, never chain completion alone", () => {
    const t = tracker();
    t.accept(load());
    t.accept(process(20000));
    t.accept(process(20002));
    t.accept(callback(10002));
    const e = t.finish(true, true);
    expect(e).toMatchObject({
      taskType: "Copilot",
      completion: "native-confirmed",
      copilot: {
        planHash: "b".repeat(64),
        stageId: "stage_go_8",
        plannedRuns: 1,
        settlements: [
          {
            index: 0,
            jobId: 1001,
            sha256: job.sha256,
            stage: "stage_go_8",
            stars: 3,
            node,
          },
        ],
      },
    });
    // Native callback completion has no persisted account/home verification yet.
    expect(validArknightsEvidence(e)).toBe(false);
    expect(validArknightsEvidence(t.finish(true, false))).toBe(true);
    const empty = tracker();
    empty.accept(callback(10002));
    expect(empty.finish(true, true).completion).toBe("unknown");
  });
  it("accepts native completion only with linked, ordered pre/post profile UID and home proofs", () => {
    expect(validArknightsEvidence(verified())).toBe(true);
    const pending = verified();
    pending.completion = "unknown";
    delete pending.copilot!.verification!.after;
    delete pending.copilot!.verification!.completedAt;
    expect(validArknightsEvidence(pending)).toBe(true);
    pending.completion = "native-confirmed";
    expect(validArknightsEvidence(pending)).toBe(false);
  });
  it.each([
    "no-verification",
    "no-copilot",
    "no-before",
    "no-after",
    "no-submission",
    "no-completion",
    "hash",
    "uid",
    "method",
    "task-id",
    "stale-before",
    "stale-after",
    "profile-after-home",
    "before-after-submission",
    "after-before-completion",
    "completion-before-submission",
    "future-home",
    "future-submission",
  ])("rejects persisted %s identity/home evidence", (kind) => {
    const e = verified(),
      v = e.copilot!.verification!;
    if (kind === "no-verification") delete e.copilot!.verification;
    if (kind === "no-copilot") delete e.copilot;
    if (kind === "no-before") v.before = undefined as never;
    if (kind === "no-after") delete v.after;
    if (kind === "no-submission") delete v.submittedAt;
    if (kind === "no-completion") delete v.completedAt;
    if (kind === "hash") v.planHash = "c".repeat(64);
    if (kind === "uid") v.after!.observedUid = "99999999";
    if (kind === "method") v.after!.method = "home" as never;
    if (kind === "task-id") v.before.taskId = 0;
    if (kind === "stale-before") {
      v.before.observedAt = "2026-10-12T00:59:00.000Z";
      v.before.homeObservedAt = v.before.observedAt;
    }
    if (kind === "stale-after") e.observedAt = "2026-10-12T01:01:00.000Z";
    if (kind === "profile-after-home")
      v.before.observedAt = "2026-10-12T01:00:00.150Z";
    if (kind === "before-after-submission")
      v.before.homeObservedAt = "2026-10-12T01:00:00.300Z";
    if (kind === "after-before-completion")
      v.after!.observedAt = "2026-10-12T01:00:00.900Z";
    if (kind === "completion-before-submission")
      v.completedAt = "2026-10-12T01:00:00.100Z";
    if (kind === "future-home")
      v.after!.homeObservedAt = "2026-10-12T01:00:02.000Z";
    if (kind === "future-submission") {
      e.completion = "unknown";
      delete v.after;
      delete v.completedAt;
      v.submittedAt = "2026-10-12T01:00:02.000Z";
    }
    expect(validArknightsEvidence(e)).toBe(false);
  });
  it("rejects a stored settlement whose stage differs from the frozen normal stage ID", () => {
    const evidence = verified();
    evidence.copilot!.settlements[0].stage = "different_stage";
    expect(validArknightsEvidence(evidence)).toBe(false);
  });
  it.each([
    "wrong-stage",
    "wrong-file",
    "wrong-id",
    "unpaired",
    "mismatched-pair",
    "failure",
    "forged-extra",
    "wrong-task",
  ])("refuses %s settlement evidence", (kind) => {
    const t = tracker();
    t.accept(
      load(
        0,
        kind === "wrong-stage"
          ? { stage_name: "go-9" }
          : kind === "wrong-file"
            ? { file_name: "D:/other.json" }
            : kind === "wrong-id"
              ? { id: 2 }
              : {},
      ),
    );
    if (kind !== "unpaired") t.accept(process(20000));
    if (kind === "failure") t.accept(callback(20001, "ProcessTask", {}));
    t.accept(
      kind === "forged-extra"
        ? callback(20003, "StageDrops", {
            stage: { stageCode: "go-8" },
            stars: 3,
          })
        : process(
            20002,
            kind === "wrong-task" ? "Copilot@StageDrops-Stars-2" : node,
            kind === "mismatched-pair" ? 2 : 1,
          ),
    );
    t.accept(callback(10002));
    expect(t.finish(true, true).completion).toBe("unknown");
  });
  it("records exactly the explicit list entries and refuses duplicate callback inflation", () => {
    const t = tracker(2);
    t.accept(load());
    t.accept(process(20000));
    t.accept(process(20002));
    t.accept(process(20002));
    t.accept(callback(10002));
    expect(t.finish(true, true).copilot?.settlements).toHaveLength(1);
    expect(t.finish(true, true).completion).toBe("unknown");
    const complete = tracker(2);
    for (let i = 0; i < 2; i++) {
      complete.accept(load(i));
      complete.accept(process(20000, node, i + 1));
      complete.accept(process(20002, node, i + 1));
    }
    complete.accept(callback(10002));
    expect(complete.finish(true, true).completion).toBe("native-confirmed");
  });
  it("accepts the exact adverse three-star node but not invented aliases", () => {
    const t = tracker();
    t.accept(load());
    t.accept(process(20000, "Copilot@StageDrops-Stars-Adverse"));
    t.accept(process(20002, "Copilot@StageDrops-Stars-Adverse"));
    t.accept(callback(10002));
    expect(t.finish(true, true).completion).toBe("native-confirmed");
  });
});
