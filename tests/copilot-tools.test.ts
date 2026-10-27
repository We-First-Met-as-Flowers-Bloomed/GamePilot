import { expect, it, vi } from "vitest";
import { withCopilotReadTools } from "../packages/agent/copilot-tools";
import { planWithDsh } from "../packages/agent/dsh-planner";
import { createAgentTools } from "../packages/agent/tools";
import { createFixtureSnapshot } from "../packages/agent/fixture";
const review = {
  version: 1 as const,
  preparedId: "12345678-1234-4234-8234-123456789abc",
  planHash: "a".repeat(64),
  revision: "c".repeat(64),
  laneName: "槽位1",
  uidTail: "1234",
  clientType: "Official" as const,
  stage: "1-7",
  count: 2,
  expiresAt: new Date(Date.now() + 600000).toISOString(),
  jobs: [
    { id: 1, title: "fixture", sha256: "b".repeat(64) },
    { id: 1, title: "fixture", sha256: "b".repeat(64) },
  ],
};
function setup() {
  const original = vi.fn(),
    prepare = vi.fn(async () => review),
    search = vi.fn(async () => []),
    assertCurrent = vi.fn(async () => {});
  const binding = withCopilotReadTools(
    { specs: [], call: original, compiled() {}, goalIds: () => [] },
    { assertCurrent, prepare, search },
  );
  return { binding, prepare, search, assertCurrent, original };
}
it.each(["lane-aa", "lane-bl"])("prepares jobs for expanded channel alias %s", async (laneId) => {
  const s = setup();
  await s.binding.call("prepare_copilot", { laneId, stage: "1-7", count: 1 }, { callId: "expanded", signal: new AbortController().signal });
  expect(s.prepare).toHaveBeenCalledWith({ laneId, stage: "1-7", count: 1 }, expect.any(AbortSignal));
});
it("only provides bounded read/preparation ports, deduplicates call IDs and never forwards an execution", async () => {
  const s = setup(),
    context = { callId: "p1", signal: new AbortController().signal },
    input = { laneId: "lane-a", stage: "1-7", count: 2 };
  await Promise.all([
    s.binding.call("prepare_copilot", input, context),
    s.binding.call("prepare_copilot", input, context),
  ]);
  expect(s.prepare).toHaveBeenCalledTimes(1);
  expect(s.original).not.toHaveBeenCalled();
  await expect(
    s.binding.call("prepare_copilot", { ...input, count: 3 }, context),
  ).rejects.toThrow(/不同/);
  await expect(
    s.binding.call(
      "prepare_copilot",
      { ...input, count: 4 },
      { ...context, callId: "p2" },
    ),
  ).rejects.toThrow(/1至3/);
  expect(s.binding.specs.map((s) => s.name)).toEqual([
    "search_copilot",
    "prepare_copilot",
  ]);
});
it("aborted or stale turns cannot prepare jobs", async () => {
  const s = setup(),
    controller = new AbortController();
  controller.abort();
  await expect(
    s.binding.call(
      "prepare_copilot",
      { laneId: "lane-a", stage: "1-7", count: 1 },
      { callId: "p", signal: controller.signal },
    ),
  ).rejects.toThrow();
  expect(s.prepare).not.toHaveBeenCalled();
  s.assertCurrent.mockRejectedValueOnce(Error("stale turn"));
  await expect(
    s.binding.call(
      "search_copilot",
      { stage: "1-7", limit: 1 },
      { callId: "q", signal: new AbortController().signal },
    ),
  ).rejects.toThrow(/stale/);
  expect(s.search).not.toHaveBeenCalled();
});
it("attaches only the host prepared review and replaces optimistic model execution prose", async () => {
  const s = setup(),
    snapshot = createFixtureSnapshot();
  snapshot.source = "configured";
  const result = await planWithDsh(createAgentTools(snapshot), {
    connection: {
      baseUrl: "https://offline.invalid",
      model: "fixture",
      apiKey: "fixture",
    },
    prompt: "账号一1-7打两场作业",
    at: new Date().toISOString(),
    binding: s.binding,
    run: async (options) => {
      await options.callTool(
        "prepare_copilot",
        { laneId: "lane-a", stage: "1-7", count: 2 },
        { callId: "p", signal: new AbortController().signal },
      );
      return {
        finalText: "两场已全部完成",
        sessionId: "fixture",
        events: [],
        model: "fixture",
      };
    },
  });
  expect(result.copilot).toEqual(review);
  expect(result.execution).toBe("not-started");
  expect(result.modelText).toContain("游戏尚未启动");
  expect(result.modelText).not.toContain("已全部完成");
  expect(JSON.stringify(result.copilot)).not.toContain("file");
});

it("rejects malformed host preparation receipts and keeps duplicate calls on the same rejection", async () => {
  const s = setup();
  s.prepare.mockResolvedValue({} as never);
  const args = { laneId: "lane-a", stage: "1-7", count: 2 },
    context = { callId: "invalid", signal: new AbortController().signal };
  await expect(
    s.binding.call("prepare_copilot", args, context),
  ).rejects.toMatchObject({ code: "INVALID_TOOL_RESULT" });
  await expect(
    s.binding.call("prepare_copilot", args, context),
  ).rejects.toMatchObject({ code: "INVALID_TOOL_RESULT" });
  expect(s.prepare).toHaveBeenCalledTimes(1);
});
it("DSH independently rejects an invalid review from a registered binding, exposes a diagnostic and omits the card", async () => {
  const s = setup(),
    snapshot = createFixtureSnapshot(),
    onEvent = vi.fn();
  snapshot.source = "configured";
  const result = await planWithDsh(createAgentTools(snapshot), {
    connection: {
      baseUrl: "https://offline.invalid",
      model: "fixture",
      apiKey: "fixture",
    },
    prompt: "准备账号一1-7两场作业",
    at: new Date().toISOString(),
    binding: { ...s.binding, call: async () => ({}) },
    onEvent,
    run: async (options) => {
      const receipt = await options.callTool(
        "prepare_copilot",
        { laneId: "lane-a", stage: "1-7", count: 2 },
        { callId: "invalid", signal: new AbortController().signal },
      );
      expect(receipt).toMatchObject({ error: { code: "INVALID_TOOL_RESULT" } });
      return {
        finalText: "已准备，已全部完成",
        sessionId: "fixture",
        events: [],
        model: "fixture",
      };
    },
  });
  expect(result.copilot).toBeUndefined();
  expect(result.execution).toBe("not-started");
  expect(result.modelText).toContain("准备记录无效");
  expect(result.modelText).not.toContain("已全部完成");
  expect(onEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "tool-result",
      tool: "prepare_copilot",
      success: false,
      code: "INVALID_TOOL_RESULT",
    }),
  );
});
