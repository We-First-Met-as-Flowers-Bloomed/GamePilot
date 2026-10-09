import { expect, it, vi } from "vitest";
import { IncidentAgentService } from "../apps/desktop/main/incident-agent";
import type { PreparedIncident } from "../apps/desktop/main/incident-agent";
import type { IncidentDiagnosis } from "../packages/protocol/incident-agent";
import type { ContinuationInput } from "../packages/protocol/continuation";
const prep = {
  fingerprint: "f",
  automaticAllowed: true,
  screens: [],
  bundle: { incident: {}, screens: [] },
  preview: {
    parentId: "req",
    fingerprint: "fp",
    defaults: [{ gameId: "arknights", skillIds: ["award"] }],
    canContinue: true,
    reasons: [],
    needsAcknowledgement: true,
    steps: [],
  },
} as unknown as PreparedIncident;
function setup(
  overrides: Partial<
    ConstructorParameters<typeof IncidentAgentService>[0]
  > = {},
) {
  const resume = vi.fn(async () => ({ requestId: "child" }));
  const save = vi.fn(async () => {});
  const diagnose = vi.fn(async () => ({
    diagnosis: {
      summary: "网络提示，重新核验后继续",
      basis: ["run-record"],
      action: "retry-remaining" as IncidentDiagnosis["action"],
    },
    model: "test-model",
  }));
  const service = new IncidentAgentService({
    prepare: async () => structuredClone(prep),
    currentFingerprint: async () => "f",
    diagnose,
    resume,
    save,
    available: () => true,
    ...overrides,
  });
  return { service, resume, save, diagnose };
}
it.each(["failed", "unknown", "cancelled", "partial"] as const)(
  "preserves a %s continuation result instead of reporting game success",
  async (outcome) => {
    const result = {
      outcome,
      wholePlanComplete: false,
      summary: "原计划尚未补齐",
      evidenceRefs: ["child:ledger"],
    };
    const { service } = setup({ successorResult: (() => result) as never });
    await service.enqueue("req");
    await service.tick();
    await service.idle();
    await service.tick();
    expect(service.snapshot().sessions[0].events.at(-1)).toMatchObject({
      kind: "result",
      status: outcome,
      result,
    });
  },
);
it("distinguishes a successful partial selection from a completed original plan", async () => {
  let wholePlanComplete = false;
  const { service } = setup({
    successorResult: (() => ({
      outcome: "succeeded",
      wholePlanComplete,
      summary: wholePlanComplete
        ? "原计划已补齐"
        : "已执行所选项，原计划未补齐",
      evidenceRefs: ["child:ledger"],
    })) as never,
  });
  await service.enqueue("req");
  await service.tick();
  await service.idle();
  await service.tick();
  expect(service.snapshot().sessions[0].events.at(-1)?.status).toBe("partial");
  wholePlanComplete = true;
  await service.tick();
  expect(service.snapshot().sessions[0].events.at(-1)?.status).toBe(
    "succeeded",
  );
  expect(
    service
      .snapshot()
      .sessions[0].events.filter(
        (e) => e.kind === "result" && e.status !== "running",
      ),
  ).toHaveLength(1);
});
it("keeps the failed successor outcome separate from coverage completed by a later descendant", async () => {
  const result = {
    outcome: "failed" as const,
    wholePlanComplete: true,
    summary: "后续关联账本已补齐原计划，原失败保留",
    evidenceRefs: ["later-child:ledger"],
  };
  const { service } = setup({ successorResult: () => result });
  await service.enqueue("req");
  await service.tick();
  await service.idle();
  await service.tick();
  expect(service.snapshot().sessions[0].events.at(-1)).toMatchObject({
    status: "failed",
    result,
  });
});
it("projects a legacy successful result from its associated ledger without changing the stored source", async () => {
  const stored = {
    sessions: [
      {
        requestId: "req",
        status: "resumed",
        automatic: true,
        startedAt: "2026-10-03T12:00:00Z",
        updatedAt: "2026-10-03T12:00:00Z",
        successorId: "child",
        events: [
          {
            seq: 1,
            at: "2026-10-03T12:00:00Z",
            kind: "result",
            status: "succeeded",
            text: "续跑结果：后续请求unknown",
          },
        ],
      },
    ],
  };
  const { service, save } = setup({
    load: (async () => stored) as never,
    successorResult: (() => ({
      outcome: "unknown",
      wholePlanComplete: false,
      summary: "账本结果未知",
      evidenceRefs: ["child:ledger"],
    })) as never,
  });
  await service.idle();
  // snapshot projects old records before the next timer tick.
  await new Promise((r) => setTimeout(r, 0));
  expect(service.snapshot().sessions[0].events[0]).toMatchObject({
    status: "unknown",
    text: "续跑结果：账本结果未知",
  });
  expect(stored.sessions[0].events[0].status).toBe("succeeded");
  await service.tick();
  expect(save).toHaveBeenCalled();
});
it("automatically diagnoses once and resumes through the host, preserving queued event history", async () => {
  const { service, resume, diagnose } = setup();
  await service.enqueue("req");
  await service.enqueue("req");
  await service.tick();
  await service.idle();
  expect(diagnose).toHaveBeenCalledTimes(1);
  expect(resume).toHaveBeenCalledTimes(1);
  expect(service.snapshot().sessions[0]).toMatchObject({
    status: "resumed",
    successorId: "child",
  });
  expect(service.snapshot().sessions[0].events.map((e) => e.kind)).toEqual(
    expect.arrayContaining([
      "queue",
      "evidence",
      "model",
      "diagnosis",
      "check",
      "resume",
      "result",
    ]),
  );
});
it("unknown evidence and manual model conclusions do not start game input", async () => {
  const { service, resume } = setup();
  prep.automaticAllowed = false;
  try {
    await service.enqueue("req");
    await service.tick();
    await service.idle();
    expect(resume).not.toHaveBeenCalled();
    expect(service.snapshot().sessions[0].status).toBe("awaiting-user");
  } finally {
    prep.automaticAllowed = true;
  }
});
it("configuration change blocks execution and cancellation does not become failure", async () => {
  const { service, resume } = setup();
  await service.enqueue("req");
  await service.cancel("req");
  await service.tick();
  expect(resume).not.toHaveBeenCalled();
  expect(service.snapshot().sessions[0].status).toBe("cancelled");
});
it("a pending model answer cannot override user cancellation", async () => {
  const { service, resume, diagnose } = setup();
  let resolve!: () => void;
  diagnose.mockImplementationOnce(async () => {
    await new Promise<void>((r) => (resolve = r));
    return {
      diagnosis: {
        summary: "建议继续",
        basis: ["run-record"],
        action: "retry-remaining",
      },
      model: "test",
    };
  });
  await service.enqueue("req");
  await service.tick();
  while (!resolve) await new Promise((r) => setTimeout(r, 0));
  await service.cancel("req");
  resolve();
  await service.idle();
  expect(resume).not.toHaveBeenCalled();
  expect(service.snapshot().sessions[0].status).toBe("cancelled");
});
it("rejects stale fingerprints and does not execute when the model requires manual correction", async () => {
  const resume = vi.fn(async () => ({ requestId: "child" }));
  const service = new IncidentAgentService({
    prepare: async () => structuredClone(prep),
    currentFingerprint: async () => "changed",
    diagnose: async () => ({
      diagnosis: {
        summary: "建议核验后继续",
        basis: ["run-record"],
        action: "retry-remaining",
      },
      model: "test",
    }),
    resume,
    save: async () => {},
    available: () => true,
  });
  await service.enqueue("req");
  await service.tick();
  await service.idle();
  expect(resume).not.toHaveBeenCalled();
  expect(service.snapshot().sessions[0].status).toBe("failed");
});
it("does not replay a queued diagnosis after application restart and blocks corrupt storage", async () => {
  const { service, diagnose } = setup();
  await service.enqueue("req");
  const stored = service.snapshot();
  const restored = new IncidentAgentService({
    prepare: async () => prep,
    currentFingerprint: async () => "f",
    diagnose,
    resume: async () => ({ requestId: "child" }),
    save: async () => {},
    available: () => true,
    load: async () => stored,
  });
  await restored.tick();
  await restored.idle();
  expect(diagnose).not.toHaveBeenCalled();
  expect(restored.snapshot().sessions[0].status).toBe("awaiting-user");
  const broken = new IncidentAgentService({
    prepare: async () => prep,
    currentFingerprint: async () => "f",
    diagnose,
    resume: async () => ({ requestId: "child" }),
    save: async () => {},
    available: () => true,
    load: async () => {
      throw Error("corrupt");
    },
  });
  await expect(broken.enqueue("req")).rejects.toThrow();
  expect(broken.snapshot().error).toBeDefined();
});
it("keeps a new user correction queued when the cancelled older diagnosis returns", async () => {
  const { service, diagnose } = setup();
  let resolve!: () => void;
  diagnose.mockImplementationOnce(async () => {
    await new Promise<void>((r) => (resolve = r));
    return {
      diagnosis: { summary: "旧答复", basis: ["run-record"], action: "manual" },
      model: "test",
    };
  });
  await service.enqueue("req");
  await service.tick();
  while (!resolve) await new Promise((r) => setTimeout(r, 0));
  await service.cancel("req");
  await service.enqueue("req", "当前已经回到主页", false);
  resolve();
  await service.idle();
  expect(service.snapshot().sessions[0].status).toBe("queued");
  await service.tick();
  await service.idle();
  expect(diagnose).toHaveBeenCalledTimes(2);
  expect(service.snapshot().sessions[0].status).toBe("awaiting-user");
});
it("a correction submitted during awaiting-user persistence prevents the old automatic recovery", async () => {
  const resume = vi.fn(async () => ({ requestId: "child" }));
  let release!: () => void;
  let stopped = false;
  const service = new IncidentAgentService({
    prepare: async () => structuredClone(prep),
    currentFingerprint: async () => "f",
    diagnose: async () => ({
      diagnosis: {
        summary: "旧的自动建议",
        basis: ["run-record"],
        action: "retry-remaining",
      },
      model: "test",
    }),
    resume,
    available: () => true,
    save: async (v) => {
      if (!stopped && v.sessions[0]?.status === "awaiting-user") {
        stopped = true;
        await new Promise<void>((r) => (release = r));
      }
    },
  });
  await service.enqueue("req");
  await service.tick();
  while (!release) await new Promise((r) => setTimeout(r, 0));
  const correction = service.enqueue("req", "不要重试，我已切换现场", false);
  release();
  await correction;
  await service.idle();
  expect(resume).not.toHaveBeenCalled();
  expect(service.snapshot().sessions[0].status).toBe("queued");
});
it("allows read-only historical diagnosis while recovery of the target device is unavailable", async () => {
  const { service, diagnose, resume } = setup({
    available: () => false,
    canDiagnose: () => true,
    canRecover: () => false,
  } as never);
  await service.enqueue("req");
  await service.tick();
  await service.idle();
  expect(diagnose).toHaveBeenCalledOnce();
  expect(resume).not.toHaveBeenCalled();
  expect(service.snapshot().sessions[0].status).toBe("awaiting-user");
});
it("performs a proposed bounded navigation before submitting only the original remaining selection", async () => {
  const order: string[] = [];
  const recovery = {
    kind: "return-arknights-home",
    gameId: "arknights",
    runId: "original-run",
    fromPage: "friends-list",
  };
  const recover = vi.fn(async () => {
    order.push("navigate");
    return {
      verified: true,
      observedAt: new Date().toISOString(),
      evidenceRefs: ["navigation-after"],
    };
  });
  const submit = vi.fn(async (input: ContinuationInput) => {
    order.push("continue");
    expect(input.selections).toEqual(prep.preview.defaults);
    return { requestId: "child" };
  });
  const { service } = setup({
    prepare: async () => ({ ...structuredClone(prep), recovery }) as never,
    recover,
    resume: submit,
  } as never);
  await service.enqueue("req");
  await service.tick();
  await service.idle();
  expect(recover).toHaveBeenCalledWith(
    "req",
    recovery,
    expect.any(AbortSignal),
  );
  expect(order).toEqual(["navigate", "continue"]);
  expect(service.snapshot().sessions[0].events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "recovery", status: "succeeded" }),
    ]),
  );
  expect(submit).toHaveBeenCalledOnce();
});
it("does not submit a continuation if navigation lacks verified fresh after-evidence", async () => {
  const { service, resume } = setup({
    prepare: async () =>
      ({
        ...structuredClone(prep),
        recovery: {
          kind: "return-arknights-home",
          gameId: "arknights",
          runId: "original-run",
          fromPage: "friends-list",
        },
      }) as never,
    recover: async () => ({ verified: false, evidenceRefs: [] }),
  } as never);
  await service.enqueue("req");
  await service.tick();
  await service.idle();
  expect(resume).not.toHaveBeenCalled();
  expect(service.snapshot().sessions[0].status).toBe("failed");
});
it.each(["SDK身份输入必须由用户完成", "客户端版本过时，请先更新对应客户端"])(
  "keeps the host blocker manual even when the model recommends retry: %s",
  async (manualReason) => {
    const { service, resume } = setup({
      prepare: async () =>
        ({
          ...structuredClone(prep),
          manualReason,
        }) as never,
    });
    await service.enqueue("req");
    await service.tick();
    await service.idle();
    expect(resume).not.toHaveBeenCalled();
    expect(service.snapshot().sessions[0]).toMatchObject({
      status: "awaiting-user",
      diagnosis: { action: "manual" },
    });
  },
);
it("limits failed navigation attempts across corrections to two for the original request", async () => {
  const recover = vi.fn(async () => {
    throw Error("unverified navigation");
  });
  const { service } = setup({
    prepare: async () =>
      ({
        ...structuredClone(prep),
        recovery: {
          kind: "return-arknights-home",
          gameId: "arknights",
          runId: "original-run",
          fromPage: "friends-list",
        },
      }) as never,
    recover,
  });
  await service.enqueue("req");
  await service.tick();
  await service.idle();
  for (let attempt = 0; attempt < 2; attempt++) {
    await service.enqueue("req", "重新核对现场", false);
    await service.tick();
    await service.idle();
    await service.confirm("req");
  }
  expect(recover).toHaveBeenCalledTimes(2);
  expect(service.snapshot().sessions[0].error).toContain("两次");
});
