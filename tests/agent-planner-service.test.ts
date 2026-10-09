import { expect, it, vi } from "vitest";
import { PlannerService } from "../apps/desktop/main/agent-planner";
import { AgentToolError } from "../packages/protocol/agent";
import type {
  PlannerResult,
  PlannerStreamEvent,
} from "../packages/protocol/agent-planner";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { createAgentTools } from "../packages/agent/tools";
import { AgentEventJournal } from "../apps/desktop/main/agent-events";
import { modelEventReceipt } from "../apps/desktop/main/agent-event-presentation";
import type { AgentEventStore } from "../packages/protocol/agent-events";

const input = { prompt: "两个演练账号做日常", at: "2026-09-26T08:00:00+08:00" };
const result: PlannerResult = {
  status: "answer",
  modelText: "合成环境",
  source: "fixture",
  execution: "not-started",
  canExecute: false,
  trace: [],
  model: "test",
  codexVersion: "test",
  elapsedMs: 1,
};
it("passes only the host-owned current turn to runtime and retains goals when their own ledger changes", async () => {
  let changed = false;
  let principal: unknown;
  const snapshot = createFixtureSnapshot();
  snapshot.source = "recorded";
  const service = new PlannerService({
    modelConnection: {
      read: async () => ({ revision: "one" }),
      resolve: async () => ({
        provider: "compatible" as const,
        revision: "one",
        baseUrl: "https://example.com",
        model: "test",
        apiKey: "private",
      }),
    },
    readConfigured: async () => ({
      snapshot,
      fingerprint: changed ? "after-admission" : "before-admission",
    }),
    compatibleRun: async () => ({ ...result, source: "recorded" }),
    runtimeRun: async (options) => {
      principal = options.principal;
      changed = true;
      return {
        ...result,
        source: "recorded",
        execution: "managed-by-goal",
        goalIds: ["goal-a"],
        transport: "dsh",
      };
    },
  });
  service.startConversation(
    { ...input, source: "recorded" },
    [{ prompt: "历史中运行日常", answer: "历史回执" }],
    { sessionId: "chat-a", turnId: "turn-a", prompt: input.prompt },
  );
  await vi.waitFor(() => expect(service.snapshot().status).toBe("completed"));
  expect(principal).toEqual({
    sessionId: "chat-a",
    turnId: "turn-a",
    prompt: input.prompt,
  });
  expect((await service.verifiedSnapshot()).result?.goalIds).toEqual([
    "goal-a",
  ]);
});
it("uses configured API without discovering Codex and invalidates result after model revision changes", async () => {
  let revision = "one";
  const find = vi.fn(async () => "codex.exe");
  const compatibleRun = vi.fn(async () => result);
  const modelConnection = {
    read: async () => ({ revision }),
    resolve: async () => ({
      provider: "compatible" as const,
      revision,
      baseUrl: "https://api.deepseek.com",
      model: "test",
      apiKey: "test-secret",
    }),
  };
  const service = new PlannerService({ find, compatibleRun, modelConnection });
  service.start(input);
  await vi.waitFor(() => expect(service.snapshot().status).toBe("completed"));
  expect(find).not.toHaveBeenCalled();
  expect(compatibleRun).toHaveBeenCalledOnce();
  expect(JSON.stringify(service.snapshot())).not.toContain("test-secret");
  revision = "two";
  expect((await service.verifiedSnapshot()).error?.code).toBe(
    "MODEL_CONFIG_CHANGED",
  );
});
it("rejects a model result if connection settings changed during planning", async () => {
  let revision = "one";
  const service = new PlannerService({
    modelConnection: {
      read: async () => ({ revision }),
      resolve: async () => ({
        provider: "compatible" as const,
        revision,
        baseUrl: "https://example.com",
        model: "test",
        apiKey: "test-secret",
      }),
    },
    compatibleRun: async () => {
      revision = "two";
      return result;
    },
  });
  service.start(input);
  await vi.waitFor(() => expect(service.snapshot().status).toBe("failed"));
  expect(service.snapshot().error?.code).toBe("MODEL_CONFIG_CHANGED");
  expect(service.snapshot().result).toBeUndefined();
});
it("keeps Codex route selected explicitly with no API request", async () => {
  const compatibleRun = vi.fn(async () => result);
  const run = vi.fn(async () => result);
  const service = new PlannerService({
    find: async () => "codex.exe",
    run,
    compatibleRun,
    modelConnection: {
      read: async () => ({ revision: "one" }),
      resolve: async () => ({
        provider: "codex" as const,
        revision: "one",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-flash",
      }),
    },
  });
  service.start(input);
  await vi.waitFor(() => expect(service.snapshot().status).toBe("completed"));
  expect(compatibleRun).not.toHaveBeenCalled();
  expect(run).toHaveBeenCalledOnce();
});
it("checks configured data before/after planning and invalidates private changes on refresh", async () => {
  let fingerprint = "first";
  const snapshot = {
    ...createFixtureSnapshot(),
    source: "configured" as const,
  };
  const run = vi.fn(async (_options: { snapshot: { source: string } }) => ({
    ...result,
    source: "configured" as const,
  }));
  const service = new PlannerService({
    find: async () => "codex.exe",
    run,
    readConfigured: async () => ({ snapshot, fingerprint }),
  });
  service.start({ ...input, source: "configured" });
  await vi.waitFor(() => expect(service.snapshot().status).toBe("completed"));
  expect(run.mock.calls[0][0].snapshot.source).toBe("configured");
  expect(JSON.stringify(service.snapshot())).not.toContain("fingerprint");
  fingerprint = "changed-private-field";
  expect((await service.verifiedSnapshot()).error?.code).toBe(
    "CONFIGURATION_CHANGED",
  );
  expect(service.snapshot().result).toBeUndefined();
  await service.close();
});
it("loads recorded mode explicitly and invalidates answers when the ledger changes", async () => {
  let fingerprint = "original";
  const readConfigured = vi.fn(async (history: boolean) => ({
    snapshot: {
      ...createFixtureSnapshot(),
      source: history ? ("recorded" as const) : ("configured" as const),
    },
    fingerprint,
  }));
  const service = new PlannerService({
    find: async () => "codex.exe",
    readConfigured,
    run: async () => ({ ...result, source: "recorded" }),
  });
  service.start({ ...input, source: "recorded" });
  await vi.waitFor(() => expect(service.snapshot().status).toBe("completed"));
  expect(readConfigured.mock.calls.every(([history]) => history === true)).toBe(
    true,
  );
  fingerprint = "new-ledger";
  const state = await service.verifiedSnapshot();
  expect(state.result).toBeUndefined();
  expect(state.error?.code).toBe("CONFIGURATION_CHANGED");
  await service.close();
});
function recordedProgressSetup() {
  let history = 1;
  let configuration = 1;
  const readConfigured = vi.fn(async (includeHistory: boolean) => ({
    snapshot: {
      ...createFixtureSnapshot(),
      source: includeHistory ? ("recorded" as const) : ("configured" as const),
    },
    fingerprint: `configuration-${configuration}/history-${includeHistory ? history : "absent"}`,
    configurationFingerprint: `configuration-${configuration}`,
  }));
  return {
    readConfigured,
    advanceHistory: () => {
      history++;
    },
    editConfiguration: () => {
      configuration++;
    },
  };
}
it.each(["answer", "question", "blocked"] as const)(
  "keeps a readonly %s based on its original recorded snapshot when progress changes before and during the model",
  async (status) => {
    const x = recordedProgressSetup();
    let capturedAt = "";
    const run = vi.fn(async (options) => {
      capturedAt = options.snapshot.capturedAt;
      x.advanceHistory();
      return { ...result, status, source: "recorded" as const };
    });
    const service = new PlannerService({
      readConfigured: x.readConfigured,
      find: async () => {
        x.advanceHistory();
        return "codex.exe";
      },
      run,
    });
    service.start({ ...input, source: "recorded" });
    await vi.waitFor(() =>
      expect(["completed", "failed"]).toContain(service.snapshot().status),
    );
    expect(service.snapshot().status).toBe("completed");
    expect(run).toHaveBeenCalledOnce();
    expect(capturedAt).toBe(createFixtureSnapshot().capturedAt);
    expect(service.snapshot().result?.modelText).toContain(
      "2026-09-25 09:00:00",
    );
    expect(service.snapshot().result?.modelText).toContain("新进度");
    x.advanceHistory();
    expect((await service.verifiedSnapshot()).status).toBe("completed");
    expect(service.snapshot().result?.status).toBe(status);
    expect(
      x.readConfigured.mock.calls.filter(([includeHistory]) => includeHistory),
    ).toHaveLength(1);
    await service.close();
  },
);
it.each(["before", "during", "refresh"] as const)(
  "still rejects a private configuration change %s a readonly model reply",
  async (phase) => {
    const x = recordedProgressSetup();
    const run = vi.fn(async () => {
      if (phase === "during") x.editConfiguration();
      return { ...result, source: "recorded" as const };
    });
    const service = new PlannerService({
      readConfigured: x.readConfigured,
      find: async () => {
        if (phase === "before") x.editConfiguration();
        return "codex.exe";
      },
      run,
    });
    service.start({ ...input, source: "recorded" });
    await vi.waitFor(() =>
      expect(["completed", "failed"]).toContain(service.snapshot().status),
    );
    if (phase === "refresh") {
      expect(service.snapshot().status).toBe("completed");
      x.editConfiguration();
    }
    const state = await service.verifiedSnapshot();
    expect(state.status).toBe("failed");
    expect(state.error?.code).toBe("CONFIGURATION_CHANGED");
    expect(state.result).toBeUndefined();
    if (phase === "before") expect(run).not.toHaveBeenCalled();
    await service.close();
  },
);
it("keeps the readonly snapshot note inside the persisted answer length bound", async () => {
  const x = recordedProgressSetup();
  const service = new PlannerService({
    readConfigured: x.readConfigured,
    find: async () => "codex.exe",
    run: async () => ({
      ...result,
      source: "recorded",
      modelText: "答".repeat(8000),
    }),
  });
  service.start({ ...input, source: "recorded" });
  await vi.waitFor(() => expect(service.snapshot().status).toBe("completed"));
  expect(service.snapshot().result!.modelText.length).toBeLessThanOrEqual(8000);
  expect(service.snapshot().result!.modelText).toContain("新进度");
  await service.close();
});
it("rechecks a newer configured reply after an older recorded verification completes", async () => {
  const x = recordedProgressSetup();
  const delayed = deferred<Awaited<ReturnType<typeof x.readConfigured>>>();
  let delayNext = false;
  const service = new PlannerService({
    readConfigured: async (history) => {
      if (delayNext) {
        delayNext = false;
        return delayed.promise;
      }
      return x.readConfigured(history);
    },
    find: async () => "codex.exe",
    run: async (options) => ({
      ...result,
      source: options.snapshot.source as "recorded" | "configured",
    }),
  });
  service.start({ ...input, source: "recorded" });
  await vi.waitFor(() => expect(service.snapshot().status).toBe("completed"));
  const previous = await x.readConfigured(false);
  delayNext = true;
  const old = service.verifiedSnapshot();
  const current = service.start({ ...input, source: "configured" });
  await vi.waitFor(() => expect(service.snapshot().status).toBe("completed"));
  x.editConfiguration();
  const latest = service.verifiedSnapshot();
  delayed.resolve(previous);
  for (const state of await Promise.all([old, latest])) {
    expect(state.requestId).toBe(current.requestId);
    expect(state.status).toBe("failed");
    expect(state.error?.code).toBe("CONFIGURATION_CHANGED");
    expect(state.result).toBeUndefined();
  }
  await service.close();
});
it.each([
  "draft",
  "answer-with-draft",
  "compiled-proof",
  "saved-daily",
  "saved-both-games",
  "can-execute",
] as const)(
  "retains the full history freeze for %s even when account configuration is stable",
  async (kind) => {
    const x = recordedProgressSetup();
    const tools = createAgentTools(createFixtureSnapshot());
    const draft = tools.call("compile_plan", {
      catalogRevision: tools.call("list_capabilities").revision,
      environmentRevision: tools.call("get_environment").revision,
      at: input.at,
      lanes: [
        {
          laneId: "lane-a",
          games: [{ gameId: "arknights", skillIds: ["login"] }],
        },
      ],
    });
    expect(draft.status).toBe("valid");
    const generated = {
      ...result,
      source: "recorded" as const,
      ...(kind === "draft" ? { status: "draft" as const, draft } : {}),
      ...(kind === "answer-with-draft" ? { draft } : {}),
      ...(kind === "compiled-proof"
        ? {
            trace: [
              {
                callId: "compile-a",
                tool: "compile_plan" as const,
                success: true,
                planHash: draft.planHash,
              },
            ],
          }
        : {}),
      ...(kind === "saved-daily" || kind === "saved-both-games"
        ? { status: kind }
        : {}),
      ...(kind === "can-execute" ? { canExecute: true } : {}),
    } as PlannerResult;
    const service = new PlannerService({
      readConfigured: x.readConfigured,
      find: async () => "codex.exe",
      run: async () => {
        x.advanceHistory();
        return generated;
      },
    });
    service.start({ ...input, source: "recorded" });
    await vi.waitFor(() =>
      expect(["completed", "failed"]).toContain(service.snapshot().status),
    );
    expect(service.snapshot().status).toBe("failed");
    expect(service.snapshot().error?.code).toBe("CONFIGURATION_CHANGED");
    expect(service.snapshot().result).toBeUndefined();
    await service.close();
  },
);
it("discards the model result when config changes during generation", async () => {
  let fingerprint = "first";
  const service = new PlannerService({
    find: async () => "codex.exe",
    readConfigured: async () => ({
      snapshot: { ...createFixtureSnapshot(), source: "configured" },
      fingerprint,
    }),
    run: async () => {
      fingerprint = "second";
      return { ...result, source: "configured" };
    },
  });
  service.start({ ...input, source: "configured" });
  await vi.waitFor(() => expect(service.snapshot().status).toBe("failed"));
  expect(service.snapshot().error?.code).toBe("CONFIGURATION_CHANGED");
  expect(service.snapshot().result).toBeUndefined();
  await service.close();
});
it("fails before discovery if configured input cannot be read; rejects source/path injection", async () => {
  const find = vi.fn();
  const service = new PlannerService({
    find,
    run: vi.fn(),
    readConfigured: async () => {
      throw Error("private-path");
    },
  });
  for (const extra of [{ source: "disk" }, { directory: "C:/private" }])
    expect(() => service.start({ ...input, ...extra })).toThrow();
  service.start({ ...input, source: "configured" });
  await vi.waitFor(() => expect(service.snapshot().status).toBe("failed"));
  expect(find).not.toHaveBeenCalled();
  expect(JSON.stringify(service.snapshot())).not.toContain("private-path");
  await service.close();
});
it.each(["SHUTDOWN_FAILED", "DSH_REAP_FAILED"])(
  "keeps %s visible and blocks further planning after cancellation",
  async (code) => {
    const pending = deferred<PlannerResult>();
    const run = vi.fn(async () => {
      await pending.promise;
      throw new AgentToolError(code, "未能确认进程退出");
    });
    const service = new PlannerService({ find: async () => "codex.exe", run });
    const accepted = service.start(input);
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    service.cancel(accepted.requestId!);
    pending.resolve(result);
    await vi.waitFor(() => expect(service.snapshot().status).toBe("failed"));
    expect(service.snapshot().error?.code).toBe(code);
    expect(() => service.start(input)).toThrow();
    await service.close();
  },
);
it("blocks subsequent planning when DSH exit remains unconfirmed without cancellation", async () => {
  const run = vi.fn(async () => {
    throw new AgentToolError("DSH_REAP_FAILED", "未能确认进程退出");
  });
  const service = new PlannerService({ find: async () => "offline-stub", run });
  service.start(input);
  await vi.waitFor(() => expect(service.snapshot().status).toBe("failed"));
  expect(service.snapshot().error?.code).toBe("DSH_REAP_FAILED");
  expect(() => service.start(input)).toThrow();
  expect(run).toHaveBeenCalledTimes(1);
  await service.close();
  await service.close();
});
it("allows a clean subsequent request after an ordinary confirmed model failure", async () => {
  const run = vi
    .fn(async () => result)
    .mockRejectedValueOnce(
      new AgentToolError("MODEL_FAILED", "模型未完成回复"),
    );
  const service = new PlannerService({ find: async () => "offline-stub", run });
  service.start(input);
  await vi.waitFor(() => expect(service.snapshot().status).toBe("failed"));
  expect(service.snapshot().error?.code).toBe("MODEL_FAILED");
  service.start(input);
  await vi.waitFor(() => expect(service.snapshot().status).toBe("completed"));
  expect(run).toHaveBeenCalledTimes(2);
  await service.close();
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
it("does not call Codex if cancelled during configured collection", async () => {
  const loaded = deferred<{
    snapshot: ReturnType<typeof createFixtureSnapshot>;
    fingerprint: string;
  }>();
  const find = vi.fn();
  const service = new PlannerService({
    find,
    run: vi.fn(),
    readConfigured: () => loaded.promise,
  });
  const accepted = service.start({ ...input, source: "configured" });
  service.cancel(accepted.requestId!);
  loaded.resolve({ snapshot: createFixtureSnapshot(), fingerprint: "x" });
  await service.close();
  expect(service.snapshot().status).toBe("cancelled");
  expect(find).not.toHaveBeenCalled();
});
it("rejects edits made during discovery before a model can read obsolete settings", async () => {
  let fingerprint = "before";
  const run = vi.fn();
  const service = new PlannerService({
    readConfigured: async () => ({
      snapshot: { ...createFixtureSnapshot(), source: "configured" },
      fingerprint,
    }),
    find: async () => {
      fingerprint = "after";
      return "codex.exe";
    },
    run,
  });
  service.start({ ...input, source: "configured" });
  await vi.waitFor(() => expect(service.snapshot().status).toBe("failed"));
  expect(run).not.toHaveBeenCalled();
  expect(service.snapshot().error?.code).toBe("CONFIGURATION_CHANGED");
  await service.close();
});
it("a late failed refresh cannot invalidate a newer planning request", async () => {
  const snapshot = {
    ...createFixtureSnapshot(),
    source: "configured" as const,
  };
  const late = deferred<void>();
  let refresh = false;
  const service = new PlannerService({
    readConfigured: async () => {
      if (refresh) {
        await late.promise;
        throw Error("missing");
      }
      return { snapshot, fingerprint: "one" };
    },
    find: async () => "codex.exe",
    run: async (options) => ({
      ...result,
      source: options.snapshot.source as "fixture" | "configured",
    }),
  });
  service.start({ ...input, source: "configured" });
  await vi.waitFor(() => expect(service.snapshot().status).toBe("completed"));
  refresh = true;
  const old = service.verifiedSnapshot();
  const current = service.start(input);
  await vi.waitFor(() => expect(service.snapshot().status).toBe("completed"));
  late.resolve();
  expect((await old).requestId).toBe(current.requestId);
  expect(service.snapshot().result?.source).toBe("fixture");
  expect(service.snapshot().error).toBeUndefined();
  await service.close();
});
it("hides a completed result if its configuration becomes unreadable", async () => {
  let fail = false;
  const service = new PlannerService({
    readConfigured: async () => {
      if (fail) throw Error("private-location");
      return {
        snapshot: { ...createFixtureSnapshot(), source: "configured" },
        fingerprint: "one",
      };
    },
    find: async () => "codex.exe",
    run: async () => ({ ...result, source: "configured" }),
  });
  service.start({ ...input, source: "configured" });
  await vi.waitFor(() => expect(service.snapshot().status).toBe("completed"));
  fail = true;
  const state = await service.verifiedSnapshot();
  expect(state.result).toBeUndefined();
  expect(state.error?.code).toBe("CONFIGURATION_CHANGED");
  expect(JSON.stringify(state)).not.toContain("private-location");
  await service.close();
});
it("revalidates the new request when an old verification finishes after it", async () => {
  const snapshot = {
    ...createFixtureSnapshot(),
    source: "configured" as const,
  };
  const delayed = deferred<{
    snapshot: typeof snapshot;
    fingerprint: string;
  }>();
  let fingerprint = "a";
  let delayNext = false;
  const service = new PlannerService({
    readConfigured: async () => {
      if (delayNext) {
        delayNext = false;
        return delayed.promise;
      }
      return { snapshot, fingerprint };
    },
    find: async () => "codex.exe",
    run: async () => ({ ...result, source: "configured" }),
  });
  service.start({ ...input, source: "configured" });
  await vi.waitFor(() => expect(service.snapshot().status).toBe("completed"));
  delayNext = true;
  const old = service.verifiedSnapshot();
  fingerprint = "b";
  service.start({ ...input, source: "configured" });
  await vi.waitFor(() => expect(service.snapshot().status).toBe("completed"));
  fingerprint = "c";
  const current = service.verifiedSnapshot();
  delayed.resolve({ snapshot, fingerprint: "a" });
  for (const state of await Promise.all([old, current])) {
    expect(state.result).toBeUndefined();
    expect(state.error?.code).toBe("CONFIGURATION_CHANGED");
  }
  await service.close();
});
it("admits only one planning job and owns immutable snapshots", async () => {
  const pending = deferred<PlannerResult>();
  const run = vi.fn(async (_options) => pending.promise);
  const service = new PlannerService({ find: async () => "codex.exe", run });
  const accepted = service.start(input);
  expect(() => service.start(input)).toThrow(/规划/);
  accepted.prompt = "modified";
  expect(service.snapshot().prompt).toBe(input.prompt);
  await vi.waitFor(() => expect(run).toHaveBeenCalled());
  pending.resolve(result);
  await vi.waitFor(() => expect(service.snapshot().status).toBe("completed"));
  expect(service.snapshot().result).toEqual(result);
  await service.close();
});
it("cancellation stays pending until the planner exits and discards a late result", async () => {
  const pending = deferred<PlannerResult>();
  const run = vi.fn(async (_options) => pending.promise);
  const service = new PlannerService({ find: async () => "codex.exe", run });
  const accepted = service.start(input);
  await vi.waitFor(() => expect(run).toHaveBeenCalled());
  expect(() => service.cancel("other")).toThrow(/编号/);
  expect(service.cancel(accepted.requestId!).status).toBe("cancelling");
  expect(() => service.start(input)).toThrow();
  pending.resolve(result);
  await vi.waitFor(() => expect(service.snapshot().status).toBe("cancelled"));
  expect(service.snapshot().result).toBeUndefined();
  await service.close();
});
it("archives an already-started tool receipt after cancellation, but drops late prose and new calls", async () => {
  const pending = deferred<PlannerResult>();
  let emit!: (event: PlannerStreamEvent) => void;
  const service = new PlannerService({
    find: async () => "codex.exe",
    run: async (options) => {
      emit = options.onEvent!;
      return pending.promise;
    },
  });
  const events: { requestId: string; event: PlannerStreamEvent }[] = [];
  const order: string[] = [];
  service.subscribeStream((requestId, event) => {
    events.push({ requestId, event });
    order.push(event.kind);
  });
  service.subscribe((state) => {
    if (state.status === "cancelled") order.push("cancelled");
  });
  const accepted = service.start(input);
  await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
  emit({ kind: "tool-started", callId: "call-original", tool: "run_plan" });
  service.cancel(accepted.requestId!);
  emit({ kind: "answer-delta", text: "游戏已经全部停止" });
  emit({ kind: "tool-started", callId: "call-late", tool: "cancel_goal" });
  emit({
    kind: "tool-result",
    callId: "call-original",
    tool: "cancel_goal",
    success: true,
  });
  const receipt: PlannerStreamEvent = {
    kind: "tool-result",
    callId: "call-original",
    tool: "run_plan",
    success: true,
    details: { result: '{"goalId":"goal-original","status":"accepted"}' },
  };
  emit(receipt);
  emit(receipt);
  pending.resolve({ ...result, modelText: "迟到的完成声明" });
  await vi.waitFor(() => expect(service.snapshot().status).toBe("cancelled"));
  expect(events).toEqual([
    {
      requestId: accepted.requestId,
      event: {
        kind: "tool-started",
        callId: "call-original",
        tool: "run_plan",
      },
    },
    { requestId: accepted.requestId, event: receipt },
  ]);
  expect(order.indexOf("tool-result")).toBeLessThan(order.indexOf("cancelled"));
  expect(service.snapshot().result).toBeUndefined();
  await service.close();
});
it("closes a missing tool response with an unknown fact, never a game cancellation receipt", async () => {
  const pending = deferred<PlannerResult>();
  let emit!: (event: PlannerStreamEvent) => void;
  const service = new PlannerService({
    find: async () => "codex.exe",
    run: async (options) => {
      emit = options.onEvent!;
      return pending.promise;
    },
  });
  const events: PlannerStreamEvent[] = [];
  let stored: AgentEventStore | undefined;
  const journal = new AgentEventJournal({
    save: async (value) => {
      stored = structuredClone(value);
    },
  });
  const writes: Promise<unknown>[] = [];
  service.subscribeStream((_requestId, event) => events.push(event));
  service.subscribeStream((requestId, event) => {
    const receipt = modelEventReceipt(requestId, event);
    if (receipt) writes.push(journal.append(receipt));
  });
  const first = service.start(input);
  await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
  const oldEmit = emit;
  emit({ kind: "tool-started", callId: "missing", tool: "run_plan" });
  service.cancel(first.requestId!);
  pending.resolve(result);
  await vi.waitFor(() => expect(service.snapshot().status).toBe("cancelled"));
  expect(events.at(-1)).toEqual({
    kind: "tool-result",
    callId: "missing",
    tool: "run_plan",
    success: false,
    code: "TOOL_RESPONSE_UNCONFIRMED",
  });
  await Promise.all(writes);
  const restored = new AgentEventJournal({
    load: async () => stored,
    save: async () => {},
  });
  expect(
    (await restored.page({ requestId: first.requestId })).events.map(
      ({ kind, status, callId }) => ({ kind, status, callId }),
    ),
  ).toEqual([
    { kind: "tool-started", status: "running", callId: "missing" },
    { kind: "tool-result", status: "unknown", callId: "missing" },
  ]);
  const count = events.length;
  service.start(input);
  await vi.waitFor(() => expect(service.snapshot().status).toBe("completed"));
  oldEmit({
    kind: "tool-result",
    callId: "missing",
    tool: "run_plan",
    success: true,
  });
  oldEmit({ kind: "answer-delta", text: "迟到内容" });
  expect(events).toHaveLength(count);
  await service.close();
});
it("cancels during discovery without calling the model", async () => {
  const find = deferred<string>();
  const run = vi.fn();
  const service = new PlannerService({ find: async () => find.promise, run });
  const accepted = service.start(input);
  service.cancel(accepted.requestId!);
  find.resolve("codex.exe");
  await service.close();
  expect(run).not.toHaveBeenCalled();
  expect(service.snapshot().status).toBe("cancelled");
  expect(() => service.start(input)).toThrow(/关闭/);
});
it("reports safe failure codes and clears previous results for a new request", async () => {
  let fail = false;
  const service = new PlannerService({
    find: async () => "codex.exe",
    run: async () => {
      if (fail) throw new Error("C:/PRIVATE/token");
      return result;
    },
  });
  service.start(input);
  await vi.waitFor(() => expect(service.snapshot().status).toBe("completed"));
  fail = true;
  expect(service.start(input).result).toBeUndefined();
  await vi.waitFor(() => expect(service.snapshot().status).toBe("failed"));
  expect(JSON.stringify(service.snapshot())).not.toContain("PRIVATE");
  expect(service.snapshot().error?.code).toBe("PLANNER_FAILED");
  await service.close();
});
it("validates IPC fields before discovery or model calls", () => {
  const find = vi.fn();
  const service = new PlannerService({ find, run: vi.fn() });
  for (const bad of [
    { ...input, executable: "evil.exe" },
    { ...input, prompt: " " },
    { ...input, at: "tomorrow" },
    { ...input, prompt: "x".repeat(12001) },
  ])
    expect(() => service.start(bad)).toThrow();
  expect(find).not.toHaveBeenCalled();
});
it("preserves controlled errors and progress but ignores progress after cancellation", async () => {
  const pending = deferred<string>();
  const service = new PlannerService({
    find: async () => "codex.exe",
    run: async (options) => {
      options.onProgress?.({ phase: "tool", tool: "get_environment" });
      await pending.promise;
      options.onProgress?.({ phase: "thinking" });
      throw new AgentToolError("TIMEOUT", "规划超时");
    },
  });
  const accepted = service.start(input);
  await vi.waitFor(() =>
    expect(service.snapshot().progress?.tool).toBe("get_environment"),
  );
  service.cancel(accepted.requestId!);
  pending.resolve("");
  await service.close();
  expect(service.snapshot().status).toBe("cancelled");
});
