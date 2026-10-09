import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { ExecutionDetailService } from "../apps/desktop/main/execution-detail";
import { ExecutionCoordinator } from "../apps/desktop/main/execution-coordinator";
import { RunLedger } from "../apps/desktop/main/run-ledger";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { TaskRecord } from "../packages/protocol/task-record";
import type { Plan, RunEvent } from "../packages/protocol";
import { summarizeTaskResult } from "../games/task-result-summary";

const uncertain = "缺少可靠记录，是否执行过尚不确定";
const startedAt = "2026-09-30T00:00:00.000Z";
const finishedAt = "2026-09-30T00:01:00.000Z";
const plan: Plan = {
  gameId: "arknights",
  mode: "live",
  skillIds: ["login", "fight"],
};
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    const rel = relative(tmpdir(), root);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
      throw Error("unsafe cleanup");
    await rm(root, { recursive: true, force: true });
  }
});

function request(): ExecutionRecord {
  return {
    version: 1,
    id: "request-a",
    source: "daily",
    resources: ["private-device"],
    fingerprint: "internal-fingerprint",
    laneId: "lane-a",
    batchId: "shared-batch",
    status: "unknown",
    startedAt,
    finishedAt,
    message: "原始结果待核对",
    resolution: { action: "abandoned", at: finishedAt, note: "保留原结果" },
    snapshot: {
      lane: {
        id: "lane-a",
        name: "冻结账号",
        instance: 2,
        managerPath: "private-path",
        arknights: { profileId: "profile-a" },
      },
      profile: { id: "profile-a", name: "冻结档案", expectedUid: "123456789" },
      arknightsPlan: structuredClone(plan),
      agent: { requestId: "agent-request", planHash: "private-hash" },
      settings: { modelEndpoint: "private-endpoint" },
    },
  };
}

function task(): TaskRecord {
  return {
    version: 1,
    executionId: "request-a",
    runId: "run-a",
    laneId: "lane-a",
    laneName: "账本旧名称",
    instance: 2,
    profileId: "profile-a",
    batchId: "shared-batch",
    gameId: plan.gameId,
    plan: structuredClone(plan),
    startedAt,
    updatedAt: finishedAt,
    finishedAt,
    status: "unknown",
    message: "执行器结束但结果未知",
    steps: [
      {
        skillId: "login",
        status: "succeeded",
        message: "原始登录证据",
        startedAt,
        finishedAt,
        evidence: "adapter-result",
        diagnostics: ["MAA diagnostic"],
        result: {
          arknights: {
            version: 1,
            taskType: "StartUp",
            submission: "submitted",
            completion: "native-confirmed",
            taskId: 1,
            observedAt: finishedAt,
          },
        },
      },
      {
        skillId: "fight",
        status: "unknown",
        message: "结果未知",
        startedAt,
        finishedAt,
        evidence: "adapter-return",
        diagnostics: [],
      },
    ],
  };
}

function fixture(original = request(), tasks = [task()]) {
  const executions = {
    assertHealthy: vi.fn(),
    get: vi.fn((id: string) => {
      if (id !== original.id) throw Error("执行请求不存在");
      return original;
    }),
  };
  // Deliberately expose all candidates, exercising the service's own ID checks.
  const ledger = { assertHealthy: vi.fn(), forExecution: vi.fn(() => tasks) };
  return {
    original,
    tasks,
    executions,
    ledger,
    service: new ExecutionDetailService(executions, ledger),
  };
}
it("projects continuation origin and cancelled selections without private snapshot fields", () => {
  const original = request();
  original.snapshot.continuation = {
    parentId: "old-request",
    parentFingerprint: "fingerprint",
    retained: [{ gameId: "arknights", skillIds: ["fight"] }],
    excluded: [{ gameId: "arknights", skillIds: ["friends"] }],
    acknowledgedPartial: true,
    privateToken: "must-not-project",
  };
  const detail = fixture(original).service.get(original.id);
  expect(detail.request.continuation?.excluded).toEqual([
    { gameId: "arknights", skillIds: ["friends"] },
  ]);
  expect(JSON.stringify(detail)).not.toContain("must-not-project");
});

function loginTask(): TaskRecord {
  const record = task();
  const evidence = record.steps[0].result!.arknights!;
  evidence.observedAt = "2026-09-30T00:00:30.000Z";
  evidence.login = {
    expectedUid: "123456789",
    observedUid: "123456789",
    home: true,
    observedAt: "2026-09-30T00:00:40.000Z",
  };
  return record;
}

it.each([
  [
    "stale native observation",
    (r: TaskRecord) => {
      r.steps[0].result!.arknights!.observedAt = "2026-09-29T00:00:30.000Z";
    },
  ],
  [
    "native observation after the step",
    (r: TaskRecord) => {
      r.steps[0].result!.arknights!.observedAt = "2026-09-30T00:01:01.000Z";
    },
  ],
  [
    "different frozen UID",
    (r: TaskRecord) => {
      const login = r.steps[0].result!.arknights!.login!;
      login.expectedUid = login.observedUid = "987654321";
    },
  ],
  [
    "wrong native task type",
    (r: TaskRecord) => {
      const evidence = r.steps[0].result!.arknights!;
      delete evidence.login;
      evidence.taskType = "Fight";
    },
  ],
  [
    "login observation before native completion",
    (r: TaskRecord) => {
      r.steps[0].result!.arknights!.login!.observedAt = startedAt;
    },
  ],
  [
    "login observation after the step",
    (r: TaskRecord) => {
      r.steps[0].result!.arknights!.login!.observedAt =
        "2026-09-30T00:01:01.000Z";
    },
  ],
])("rejects nested native evidence with %s", (_label, edit) => {
  const record = loginTask();
  edit(record);
  expect(fixture(request(), [record]).service.get("request-a").games).toEqual([
    { plan, issue: uncertain },
  ]);
});

it.each([undefined, "", "invalid-uid", 123456789])(
  "does not trust login evidence without a valid frozen UID: %j",
  (expectedUid) => {
    const original = request();
    original.snapshot.profile = {
      id: "profile-a",
      name: "冻结档案",
      expectedUid,
    };
    expect(
      fixture(original, [loginTask()]).service.get(original.id).games,
    ).toEqual([{ plan, issue: uncertain }]);
  },
);

it("retains valid current native evidence using the frozen lane profile UID", () => {
  const original = request();
  original.snapshot.arknights = { expectedUid: "987654321" };
  const record = loginTask();
  const detail = fixture(original, [record]).service.get(original.id);
  expect(detail.games).toEqual([
    { plan, record, summary: summarizeTaskResult(record) },
  ]);
  expect(detail.request.status).toBe("unknown");
  expect(detail.request.resolution).toEqual(original.resolution);
});

it.each(["123456789", "987654321", undefined])(
  "uses the standalone frozen Arknights UID for non-lane requests: %j",
  (expectedUid) => {
    const original = request();
    delete original.laneId;
    delete original.batchId;
    original.source = "single";
    original.snapshot = {
      plan,
      arknights: { expectedUid },
      profile: { expectedUid: "123456789" },
    };
    const record = loginTask();
    delete record.laneId;
    delete record.batchId;
    delete record.instance;
    delete record.profileId;
    const detail = fixture(original, [record]).service.get(original.id);
    expect(detail.games).toEqual(
      expectedUid === "123456789"
        ? [{ plan, record, summary: summarizeTaskResult(record) }]
        : [{ plan, issue: uncertain }],
    );
  },
);

it("retains running records with no native result yet", () => {
  const original = request();
  original.status = "running";
  delete original.finishedAt;
  delete original.resolution;
  const record = task();
  record.status = "running";
  delete record.finishedAt;
  record.steps = record.steps.map((step) => ({
    ...step,
    status: "running",
    result: undefined,
    finishedAt: undefined,
  }));
  expect(fixture(original, [record]).service.get(original.id).games).toEqual([
    { plan, record, summary: summarizeTaskResult(record) },
  ]);
});

it("projects frozen identity and preserves raw status, resolution and adapter evidence", () => {
  const { service, original, tasks, ledger } = fixture();
  const detail = service.get(original.id);
  expect(detail.request).toEqual({
    id: original.id,
    source: "daily",
    status: "unknown",
    startedAt,
    finishedAt,
    message: original.message,
    resolution: original.resolution,
    laneId: "lane-a",
    batchId: "shared-batch",
    laneName: "冻结账号",
    instance: 2,
    profileName: "冻结档案",
    agentRequestId: "agent-request",
  });
  expect(detail.games).toEqual([
    { plan, record: tasks[0], summary: summarizeTaskResult(tasks[0]) },
  ]);
  expect(detail.warnings).toEqual([]);
  expect(ledger.forExecution).toHaveBeenCalledWith(original.id);
  expect(JSON.stringify(detail)).not.toMatch(
    /private-|snapshot|resources|fingerprint|expectedUid|planHash/,
  );
});

it("isolates two accounts sharing a batch and never falls back from explicit request IDs", () => {
  const own = task();
  const other = {
    ...task(),
    executionId: "request-b",
    laneId: "lane-b",
    instance: 3,
    runId: "run-b",
  };
  expect(
    fixture(request(), [own, other]).service.get("request-a").games[0].record
      ?.runId,
  ).toBe("run-a");
  const wrongId = { ...own, executionId: "request-b" };
  const missingId = { ...own, executionId: undefined };
  expect(
    fixture(request(), [wrongId, missingId]).service.get("request-a").games,
  ).toEqual([{ plan, issue: uncertain }]);
});

it.each([
  ["matching plans", {}],
  ["conflicting plans", { plan: { ...plan, mode: "rehearsal" as const } }],
])(
  "does not choose the latest of duplicate game candidates with %s",
  (_label, edit) => {
    const newer = {
      ...task(),
      ...edit,
      runId: "newer",
      startedAt: "2026-09-30T00:00:30.000Z",
    };
    const detail = fixture(request(), [task(), newer]).service.get("request-a");
    expect(detail.games).toEqual([{ plan, issue: uncertain }]);
  },
);

it.each([
  ["lane", { laneId: "lane-b" }],
  ["batch", { batchId: "other-batch" }],
  ["instance", { instance: 3 }],
  ["profile", { profileId: "other-profile" }],
  ["mode", { plan: { ...plan, mode: "rehearsal" as const } }],
  [
    "skill order",
    {
      plan: { ...plan, skillIds: ["fight", "login"] },
      steps: [...task().steps].reverse(),
    },
  ],
  ["before request", { startedAt: "2026-09-29T23:59:59.000Z" }],
  ["after request", { updatedAt: "2026-09-30T00:01:01.000Z" }],
  ["finished after request", { finishedAt: "2026-09-30T00:01:01.000Z" }],
  ["reversed lifecycle", { updatedAt: "2026-09-29T23:59:59.000Z" }],
])("does not associate a task with conflicting %s", (_label, edit) => {
  const detail = fixture(request(), [{ ...task(), ...edit }]).service.get(
    "request-a",
  );
  expect(detail.games).toEqual([{ plan, issue: uncertain }]);
});

it.each([
  [
    "lane id",
    {
      lane: {
        id: "lane-b",
        instance: 2,
        arknights: { profileId: "profile-a" },
      },
    },
  ],
  [
    "instance",
    {
      lane: {
        id: "lane-a",
        instance: "2",
        arknights: { profileId: "profile-a" },
      },
    },
  ],
  [
    "profile binding",
    {
      lane: {
        id: "lane-a",
        instance: 2,
        arknights: { profileId: "profile-b" },
      },
    },
  ],
  ["profile id", { profile: { id: "profile-b", name: "changed" } }],
  ["missing profile", { profile: undefined }],
])("rejects conflicting frozen %s", (_label, edit) => {
  const original = request();
  Object.assign(original.snapshot, edit);
  expect(fixture(original).service.get(original.id).games).toEqual([
    { plan, issue: uncertain },
  ]);
});

it("represents no steps as missing evidence, even for a succeeded request", () => {
  const original = {
    ...request(),
    status: "succeeded" as const,
    resolution: undefined,
  };
  const detail = fixture(original, []).service.get(original.id);
  expect(detail.request.status).toBe("succeeded");
  expect(detail.games).toEqual([{ plan, issue: uncertain }]);
  expect(JSON.stringify(detail)).not.toContain("not-run");
});

it("keeps both frozen games and reports a missing handoff without changing the first game", () => {
  const original = request();
  const onmyoji: Plan = {
    gameId: "onmyoji",
    mode: "live",
    skillIds: ["login", "foster"],
  };
  original.snapshot.onmyojiPlan = onmyoji;
  const detail = fixture(original).service.get(original.id);
  expect(detail.games).toEqual([
    { plan, record: task(), summary: summarizeTaskResult(task()) },
    { plan: onmyoji, issue: uncertain },
  ]);
});

it("preserves single-run rehearsal evidence without requiring a lane or profile", () => {
  const original = request();
  delete original.laneId;
  delete original.batchId;
  original.source = "single";
  original.snapshot = { plan: { ...plan, mode: "rehearsal" } };
  const record = task();
  delete record.laneId;
  delete record.batchId;
  delete record.instance;
  delete record.profileId;
  record.plan.mode = "rehearsal";
  record.steps = record.steps.map((s) => ({ ...s, evidence: "rehearsal" }));
  const detail = fixture(original, [record]).service.get(original.id);
  expect(detail.games[0].record).toEqual(record);
  expect(detail.request.instance).toBeUndefined();
});

it.each([
  {},
  { plan: null },
  { plan: { ...plan, skillIds: ["login", "login"] } },
  { plan: { ...plan, mode: "invalid" } },
])(
  "warns about missing or malformed frozen plans without adopting the ledger plan: %j",
  (snapshot) => {
    const original = { ...request(), snapshot };
    const detail = fixture(original).service.get(original.id);
    expect(detail.games).toEqual([]);
    expect(detail.warnings.length).toBeGreaterThan(0);
  },
);

it("never associates ambiguous frozen game plans", () => {
  const original = request();
  original.snapshot.plan = { ...plan, skillIds: ["fight", "login"] };
  const detail = fixture(original).service.get(original.id);
  expect(detail.games.length).toBeGreaterThan(0);
  expect(detail.games.every((g) => !g.record && g.issue === uncertain)).toBe(
    true,
  );
});

it("validates IDs and propagates unavailable or structurally corrupt records", () => {
  const { service, ledger, executions } = fixture();
  expect(() => service.get("../../request-a")).toThrow("执行请求编号无效");
  expect(executions.get).not.toHaveBeenCalled();
  expect(() => service.get("unknown")).toThrow("执行请求不存在");
  ledger.assertHealthy.mockImplementationOnce(() => {
    throw Error("账本已损坏");
  });
  expect(() => service.get("request-a")).toThrow("账本已损坏");
  executions.assertHealthy.mockImplementationOnce(() => {
    throw Error("请求记录已损坏");
  });
  expect(() => service.get("request-a")).toThrow("请求记录已损坏");
  ledger.forExecution.mockReturnValueOnce([{ ...task(), steps: [] }]);
  expect(() => service.get("request-a")).toThrow("任务记录格式或版本无效");
});

it("returns independent clones and uses only read ports", () => {
  const { service, original, tasks } = fixture();
  const before = structuredClone({ original, tasks });
  const detail = service.get("request-a");
  detail.request.resolution!.note = "tampered";
  detail.games[0].plan.skillIds[0] = "tampered";
  detail.games[0].record!.steps[0].diagnostics.push("tampered");
  expect({ original, tasks }).toEqual(before);
  expect(service.get("request-a").games[0].record).toEqual(before.tasks[0]);
});

it.each([
  ["start outside the request", { startedAt: "2026-09-29T23:59:59.000Z" }],
  ["finish outside the request", { finishedAt: "2026-09-30T00:01:01.000Z" }],
  ["invalid timestamp", { finishedAt: "not-a-date" }],
  ["reversed step lifecycle", { startedAt: finishedAt, finishedAt: startedAt }],
])(
  "does not present step evidence with %s as reliably associated",
  (_label, edit) => {
    const record = task();
    Object.assign(record.steps[0], edit);
    expect(fixture(request(), [record]).service.get("request-a").games).toEqual(
      [{ plan, issue: uncertain }],
    );
  },
);

it("supports maintenance onmyoji plans without an unrelated Arknights profile", () => {
  const original = request();
  original.source = "maintenance";
  const onmyoji: Plan = {
    gameId: "onmyoji",
    mode: "live",
    skillIds: ["foster"],
  };
  original.snapshot = { lane: original.snapshot.lane, onmyojiPlan: onmyoji };
  const record = task();
  record.gameId = onmyoji.gameId;
  record.plan = onmyoji;
  delete record.profileId;
  record.steps = [
    {
      skillId: "foster",
      status: "not-run",
      message: "本轮未执行",
      diagnostics: [],
    },
  ];
  const detail = fixture(original, [record]).service.get(original.id);
  expect(detail.request.source).toBe("maintenance");
  expect(detail.games).toEqual([
    { plan: onmyoji, record, summary: summarizeTaskResult(record) },
  ]);
});

async function diskContents(
  directory: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) Object.assign(result, await diskContents(path));
    else result[path] = await readFile(path, "utf8");
  }
  return result;
}

it("reads exact persisted requests beyond both 100-record display windows without writes", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(startedAt));
  const root = await mkdtemp(join(tmpdir(), "gp-execution-detail-"));
  roots.push(root);
  const executions = new ExecutionCoordinator(join(root, "requests"));
  const ledger = new RunLedger(join(root, "runs"));
  await executions.load();
  await ledger.load();
  for (let index = 0; index <= 100; index++) {
    vi.setSystemTime(new Date(Date.parse(startedAt) + index * 1000));
    const id = `persisted-${index}`;
    const lease = await executions.begin({
      id,
      source: "single",
      resources: ["test-device"],
      snapshot: { plan },
    });
    const event: RunEvent = {
      executionId: id,
      runId: `run-${index}`,
      gameId: plan.gameId,
      plan,
      type: "status",
      status: "queued",
      at: new Date().toISOString(),
      message: "original",
    };
    await ledger.append(event);
    for (const skillId of plan.skillIds)
      await ledger.append({
        ...event,
        type: "step",
        skillId,
        stepStatus: "succeeded",
        stepEvidence: "adapter-return",
      });
    await ledger.append({ ...event, status: "succeeded" });
    await lease.finish("succeeded", "software completed");
  }
  const reloadedExecutions = new ExecutionCoordinator(join(root, "requests"));
  const reloadedLedger = new RunLedger(join(root, "runs"));
  await reloadedExecutions.load();
  await reloadedLedger.load();
  expect(
    reloadedExecutions.snapshot().some((r) => r.id === "persisted-0"),
  ).toBe(false);
  expect(
    reloadedLedger.snapshot().some((r) => r.executionId === "persisted-0"),
  ).toBe(false);
  const before = await diskContents(root);
  const service = new ExecutionDetailService(
    reloadedExecutions,
    reloadedLedger,
  );
  expect(service.get("persisted-0").games[0].record?.runId).toBe("run-0");
  expect(service.get("persisted-0").request.status).toBe("succeeded");
  expect(await diskContents(root)).toEqual(before);
});
