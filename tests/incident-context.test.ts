import { expect, it, vi } from "vitest";
import { IncidentContext } from "../apps/desktop/main/incident-context";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import type { ConfiguredSnapshot } from "../packages/agent/configured";
import { defaultArknightsConfig } from "../games/arknights/config";
import type { IncidentScreen } from "../packages/protocol/incident-agent";
import type { DeviceInspection } from "../packages/protocol/recovery";
import { gamePlugins } from "../games/registry";
function recoveryHarness(page: IncidentScreen) {
  const snapshot = createFixtureSnapshot();
  snapshot.source = "recorded";
  snapshot.historyAvailable = true;
  const request = {
    ...snapshot.requests[0],
    id: "PRIVATE-origin",
    status: "failed",
    snapshot: {
      ...snapshot.requests[0].snapshot,
      profile: {
        ...defaultArknightsConfig,
        expectedUid: "111111111",
        id: "default",
        name: "fixture",
      },
    },
  };
  const task = {
    ...structuredClone(snapshot.tasks[0]),
    runId: "PRIVATE-run",
    status: "failed",
    plan: {
      gameId: "arknights",
      mode: "live",
      skillIds: ["login", "friends", "award"],
    },
    fault: { skillId: "friends", code: "skill-exception", source: "runner" },
    steps: [
      {
        skillId: "login",
        status: "succeeded",
        result: {
          arknights: {
            version: 1,
            taskType: "StartUp",
            taskId: 1,
            submission: "submitted",
            completion: "native-confirmed",
            observedAt: snapshot.requests[0].startedAt,
          },
        },
      },
      {
        skillId: "friends",
        status: "failed",
        startedAt: snapshot.requests[0].startedAt,
        finishedAt: snapshot.requests[0].finishedAt,
        result: {
          arknights: {
            version: 1,
            taskType: "Mall",
            taskId: 2,
            submission: "submitted",
            completion: "native-confirmed",
            observedAt: snapshot.requests[0].startedAt,
            statistics: {
              version: 1,
              mall: {
                purchaseConfirmations: 1,
                creditCollected: true,
                finalCredit: 120,
              },
            },
          },
        },
      },
      { skillId: "award", status: "not-run" },
    ],
  };
  const preview = {
    parentId: "PRIVATE-origin",
    fingerprint: "preview-fp",
    canContinue: true,
    reasons: [],
    defaults: [{ gameId: "arknights", skillIds: ["friends", "award"] }],
    steps: [
      {
        gameId: "arknights",
        skillId: "friends",
        status: "retry",
        message: "返回未确认",
      },
      {
        gameId: "arknights",
        skillId: "award",
        status: "pending",
        message: "未开始",
      },
    ],
    needsAcknowledgement: true,
  };
  const deps = {
    executions: { get: () => request },
    details: {
      get: () => ({
        request,
        games: [{ plan: task.plan, record: task }],
        warnings: [],
      }),
    },
    evidence: {
      list: async () => [
        {
          runId: task.runId,
          gameId: "arknights",
          observedAt: request.startedAt,
        },
      ],
      read: async () => ({ status: "available", image: "PRIVATE-png" }),
    },
    continuations: { preview: async () => structuredClone(preview) },
    readConfigured: async () => ({
      snapshot,
      fingerprint: "global-fp",
      bindings: [
        { requestId: "PRIVATE-origin", alias: snapshot.requests[0].id },
      ],
    }),
    readAdmissionFingerprint: async () => "target-fp",
    recognize: async () => page,
  };
  return { context: new IncidentContext(deps as never), deps, task, request };
}
it("proposes bounded navigation and retains confirmed shopping without repeating the purchase", async () => {
  const { context } = recoveryHarness("friends-list");
  const prepared = await context.prepare(
    "PRIVATE-origin",
    new AbortController().signal,
  );
  expect(prepared).toMatchObject({
    fingerprint: "target-fp",
    recovery: {
      kind: "return-arknights-home",
      gameId: "arknights",
      runId: "PRIVATE-run",
      fromPage: "friends-list",
    },
  });
  expect(prepared.preview.defaults).toEqual([
    { gameId: "arknights", skillIds: ["award"] },
  ]);
  expect(
    prepared.preview.steps.find((s) => s.skillId === "friends")?.status,
  ).toBe("excluded");
});
it("uses the registered plugin replay guard before proposing host recovery", async () => {
  const { context } = recoveryHarness("friends-list");
  const guard = vi
    .spyOn(gamePlugins.get("arknights").recovery, "replayBlockers")
    .mockReturnValue(["插件禁止重放未确认效果"]);
  try {
    const prepared = await context.prepare(
      "PRIVATE-origin",
      new AbortController().signal,
    );
    expect(guard).toHaveBeenCalledOnce();
    expect(prepared.preview.canContinue).toBe(false);
    expect(prepared.manualReason).toContain("插件禁止");
    expect(prepared.recovery).toBeUndefined();
  } finally {
    guard.mockRestore();
  }
});
it("keeps confirmed Onmyoji effects excluded and requires role verification rather than registering replay", async () => {
  const { context, task, deps } = recoveryHarness("onmyoji-gift-house");
  const at = task.steps[1].startedAt!;
  task.gameId = "onmyoji";
  task.plan = {
    gameId: "onmyoji",
    mode: "live",
    skillIds: ["login", "daily-gift", "mail"],
  };
  task.steps = [
    { skillId: "login", status: "succeeded" },
    {
      skillId: "daily-gift",
      status: "failed",
      startedAt: at,
      finishedAt: task.steps[1].finishedAt,
      result: {
        onmyoji: {
          version: 1,
          skillId: "daily-gift",
          phase: "confirmed",
          observedAt: at,
          effects: [
            {
              kind: "free-daily-gift",
              observedAt: at,
              evidenceReference: "onmyoji:daily-gift:effect:1",
              summary: "已确认效果",
            },
          ],
        },
      },
    },
    { skillId: "mail", status: "not-run" },
  ] as never;
  deps.evidence.list = async () => [
    { runId: task.runId, gameId: "onmyoji", observedAt: at },
  ];
  deps.continuations.preview = async () => ({
    parentId: "PRIVATE-origin",
    fingerprint: "preview-fp",
    canContinue: true,
    reasons: [],
    defaults: [{ gameId: "onmyoji", skillIds: ["daily-gift", "mail"] }],
    steps: [
      {
        gameId: "onmyoji",
        skillId: "daily-gift",
        status: "retry",
        message: "返回失败",
      },
      {
        gameId: "onmyoji",
        skillId: "mail",
        status: "pending",
        message: "未开始",
      },
    ],
    needsAcknowledgement: true,
  });
  const prepared = await context.prepare(
    "PRIVATE-origin",
    new AbortController().signal,
  );
  expect(prepared.screens[0].page).toBe("onmyoji-gift-house");
  expect(prepared.automaticAllowed).toBe(false);
  expect(prepared.recovery).toBeUndefined();
  expect(prepared.manualReason).toContain("角色身份");
  expect(
    prepared.preview.steps.find((step) => step.skillId === "daily-gift")
      ?.status,
  ).toBe("excluded");
  expect(prepared.preview.defaults).toEqual([
    { gameId: "onmyoji", skillIds: ["mail"] },
  ]);
});
it.each(["sdk-login", "phone-login", "verification-code"] as const)(
  "requires manual handling of %s even with a continuation preview",
  async (page) => {
    const { context } = recoveryHarness(page as never);
    const prepared = await context.prepare(
      "PRIVATE-origin",
      new AbortController().signal,
    );
    expect(prepared.manualReason).toContain("身份");
    expect(prepared.automaticAllowed).toBe(false);
    expect(prepared.recovery).toBeUndefined();
  },
);
it("blocks native submitted unknown shopping rather than planning a second purchase", async () => {
  const { context, task } = recoveryHarness("friends-list");
  task.steps[1].result!.arknights!.completion = "unknown";
  const prepared = await context.prepare(
    "PRIVATE-origin",
    new AbortController().signal,
  );
  expect(prepared.preview.canContinue).toBe(false);
  expect(prepared.manualReason).toContain("结果");
  expect(prepared.recovery).toBeUndefined();
});

it("requires a client update without recovering or rewriting the unknown native result", async () => {
  const { context, task, request } = recoveryHarness("client-update-required");
  task.steps[1].result!.arknights!.completion = "unknown";
  const original = structuredClone({ request, task });
  const prepared = await context.prepare(
    "PRIVATE-origin",
    new AbortController().signal,
  );
  expect(prepared.manualReason).toContain("客户端版本过时");
  expect(prepared.manualReason).toContain("更新");
  expect(prepared.automaticAllowed).toBe(false);
  expect(prepared.recovery).toBeUndefined();
  expect(prepared.preview.canContinue).toBe(false);
  expect({ request, task }).toEqual(original);
});
it("does not retain shopping facts whose observation falls outside the associated step", async () => {
  const { context, task } = recoveryHarness("friends-list");
  task.steps[1].result!.arknights!.observedAt = "2000-01-01T00:00:00Z";
  const prepared = await context.prepare(
    "PRIVATE-origin",
    new AbortController().signal,
  );
  expect(prepared.preview.canContinue).toBe(false);
  expect(prepared.recovery).toBeUndefined();
});
function navigationCapture(
  page: "home" | "friends-list" | "profile",
): DeviceInspection {
  return {
    address: "fixture-device",
    foregroundPackage: "com.hypergryph.arknights",
    observedAt: new Date().toISOString(),
    image: "local-only",
    pageVerified: true,
    accountVerified: false,
    arknights: {
      page,
      pageVerified: true,
      accountVerified: false,
      account: "unknown",
      expectedUid: "111111111",
      message: "fixture",
      frames: [0, 1].map(() => ({
        page,
        anchors: [],
        ...(page === "profile" ? { uid: "111111111" } : {}),
      })),
    },
  };
}
function navigationHarness(
  varyBefore?: (capture: DeviceInspection) => void,
  varyAfter?: (capture: DeviceInspection) => void,
) {
  const base = recoveryHarness("friends-list");
  const operations: string[] = [];
  const navigation = {
    withLease: vi.fn(
      async (
        _id: string,
        _signal: AbortSignal,
        work: (address: string) => Promise<unknown>,
      ) => {
        operations.push("lease");
        try {
          return await work("fixture-device");
        } finally {
          operations.push("release");
        }
      },
    ),
    inspect: vi.fn(async () => {
      operations.push("before");
      const capture = navigationCapture("friends-list");
      varyBefore?.(capture);
      return capture;
    }),
    returnHome: vi.fn(async () => {
      operations.push("navigate");
      const capture = navigationCapture("home");
      varyAfter?.(capture);
      return capture;
    }),
  };
  const context = new IncidentContext({ ...base.deps, navigation } as never);
  return { ...base, context, navigation, operations };
}
it("verifies fresh observation before and after bounded navigation within the original device lease", async () => {
  const { context, navigation, operations } = navigationHarness();
  expect(context).toHaveProperty("recover", expect.any(Function));
  const p = await context.prepare(
    "PRIVATE-origin",
    new AbortController().signal,
  );
  const result = await context.recover(
    "PRIVATE-origin",
    p.recovery!,
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    verified: true,
    evidenceRefs: [
      "PRIVATE-run:navigation-before",
      "PRIVATE-run:navigation-after",
    ],
  });
  expect(operations).toEqual(["lease", "before", "navigate", "release"]);
  expect(navigation.withLease).toHaveBeenCalledOnce();
});
it.each([
  (c: DeviceInspection) => {
    c.observedAt = "2000-01-01T00:00:00Z";
  },
  (c: DeviceInspection) => {
    c.address = "another-device";
  },
  (c: DeviceInspection) => {
    c.foregroundPackage = "com.other.app";
  },
  (c: DeviceInspection) => {
    c.arknights!.page = "unknown";
  },
  (c: DeviceInspection) => {
    c.arknights!.frames[1].page = "home";
  },
  (c: DeviceInspection) => {
    c.arknights!.frames[0].uid = "222222222";
  },
])(
  "refuses stale or mismatched before-evidence without device input",
  async (vary) => {
    const { context, navigation } = navigationHarness(vary);
    expect(context).toHaveProperty("recover", expect.any(Function));
    const p = await context.prepare(
      "PRIVATE-origin",
      new AbortController().signal,
    );
    await expect(
      context.recover(
        "PRIVATE-origin",
        p.recovery!,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "RECOVERY_UNVERIFIED" });
    expect(navigation.returnHome).not.toHaveBeenCalled();
  },
);
it("refuses a navigation reply that has no fresh matching home proof", async () => {
  const { context } = navigationHarness(undefined, (c) => {
    c.arknights!.page = "friends-list";
  });
  expect(context).toHaveProperty("recover", expect.any(Function));
  const p = await context.prepare(
    "PRIVATE-origin",
    new AbortController().signal,
  );
  await expect(
    context.recover(
      "PRIVATE-origin",
      p.recovery!,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "RECOVERY_UNVERIFIED" });
});
it("rejects a different run or arbitrary navigation fields before taking the lease", async () => {
  const { context, navigation } = navigationHarness();
  expect(context).toHaveProperty("recover", expect.any(Function));
  const p = await context.prepare(
    "PRIVATE-origin",
    new AbortController().signal,
  );
  await expect(
    context.recover(
      "PRIVATE-origin",
      { ...p.recovery!, runId: "different-run" },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "RECOVERY_CHANGED" });
  await expect(
    context.recover(
      "PRIVATE-origin",
      { ...p.recovery!, x: 123 } as never,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "RECOVERY_CHANGED" });
  expect(navigation.withLease).not.toHaveBeenCalled();
});
it("reads the screenshot by original request/run and exports only derived screen aliases to the model", async () => {
  const snapshot = createFixtureSnapshot();
  snapshot.source = "recorded";
  snapshot.historyAvailable = true;
  const request = {
    ...snapshot.requests[0],
    id: "PRIVATE-origin",
    status: "unknown",
    snapshot: { ...snapshot.requests[0].snapshot },
  };
  const read = vi.fn(async () => ({
    status: "available",
    image: "PRIVATE-local-png",
  }));
  const recognize = vi.fn(async () => "unknown" as const);
  const context = new IncidentContext({
    executions: { get: () => request },
    details: { get: () => ({ request, games: [], warnings: [] }) },
    evidence: {
      list: async () => [
        {
          runId: "PRIVATE-run",
          gameId: "arknights",
          observedAt: request.startedAt,
        },
      ],
      read,
    },
    continuations: {
      preview: async () => ({
        parentId: "PRIVATE-origin",
        canContinue: false,
        defaults: [],
        reasons: ["旧日期"],
        steps: [],
        fingerprint: "fp",
        needsAcknowledgement: true,
      }),
    },
    readConfigured: async () =>
      ({
        snapshot,
        fingerprint: "fingerprint",
        bindings: [
          { requestId: "PRIVATE-origin", alias: snapshot.requests[0].id },
        ],
      }) as ConfiguredSnapshot,
    recognize,
  } as never);
  const p = await context.prepare(
    "PRIVATE-origin",
    new AbortController().signal,
  );
  expect(read).toHaveBeenCalledWith({
    requestId: "PRIVATE-origin",
    runId: "PRIVATE-run",
  });
  expect(recognize).toHaveBeenCalledWith(
    "PRIVATE-local-png",
    expect.any(AbortSignal),
    "arknights",
  );
  expect(p.screens[0].runId).toBe("PRIVATE-run");
  expect(p.bundle.screens[0].runId).toBe("screen-run-1");
  expect(JSON.stringify(p.bundle)).not.toContain("PRIVATE-local-png");
  expect(p.automaticAllowed).toBe(false);
});
it("refuses evidence from an unassociated account before opening a screenshot", async () => {
  const read = vi.fn();
  const context = new IncidentContext({
    executions: { get: () => ({ status: "unknown", snapshot: {} }) },
    details: { get: () => ({ games: [] }) },
    evidence: { read },
    readConfigured: async () => ({
      snapshot: createFixtureSnapshot(),
      fingerprint: "f",
      bindings: [],
    }),
  } as never);
  await expect(
    context.prepare("req", new AbortController().signal),
  ).rejects.toMatchObject({ code: "INCIDENT_UNASSOCIATED" });
  expect(read).not.toHaveBeenCalled();
});
