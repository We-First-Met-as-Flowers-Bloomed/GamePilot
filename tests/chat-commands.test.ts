import { describe, expect, it, vi } from "vitest";
import {
  ChatCommandService,
  type PreparedChatCommand,
} from "../apps/desktop/main/chat-commands";
import type {
  ChatCommandStore,
  ChatCommandView,
} from "../packages/protocol/chat-commands";

describe("chat commands use the original host admission", () => {
  const fixture = () => {
    let fingerprint = "a";
    let stored: ChatCommandStore | undefined;
    let sessionContext = "s:turn-1";
    let needsAcknowledgement = false;
    const prepared = (): PreparedChatCommand => ({
      fingerprint,
      summary: [
        {
          laneName: "账号一",
          games: [
            { gameId: "arknights", title: "明日方舟", steps: ["登录核验"] },
          ],
        },
      ],
      payload: { frozen: "host-plan", acknowledgePartial: false },
      needsAcknowledgement,
    });
    const launch = vi.fn(
      async (_prepared: PreparedChatCommand, _view: ChatCommandView) => ({
        batchId: "batch",
        requestIds: ["batch:lane"],
      }),
    );
    const deps = {
      prepare: vi.fn(async () => prepared()),
      launch,
      validateSession: vi.fn(async () => sessionContext),
      save: vi.fn(async (value: ChatCommandStore) => {
        stored = structuredClone(value);
      }),
      load: async () => stored,
    };
    return {
      deps,
      launch,
      prepared,
      change: () => (fingerprint = "b"),
      changeContext: () => (sessionContext = "s:turn-2"),
      requireAcknowledgement: () => (needsAcknowledgement = true),
    };
  };
  it("checks a fresh exact review and does not resubmit duplicate or restored confirmations", async () => {
    const f = fixture(),
      host = new ChatCommandService(f.deps);
    const review = await host.review({
      sessionId: "s",
      text: "运行保存的日常",
    });
    expect(f.launch).not.toHaveBeenCalled();
    const input = {
      sessionId: "s",
      reviewId: review.reviewId,
      revision: review.revision,
    };
    const receipt = await host.confirm(input);
    expect(receipt.status).toBe("submitted");
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect((await host.confirm(input)).receipt).toEqual(receipt.receipt);
    const restored = new ChatCommandService(f.deps);
    expect((await restored.confirm(input)).receipt).toEqual(receipt.receipt);
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
  it("rejects changed configuration and cross session versions before calling games", async () => {
    const f = fixture(),
      host = new ChatCommandService(f.deps);
    const review = await host.review({
      sessionId: "s",
      text: "运行保存的日常",
    });
    await expect(
      host.confirm({
        sessionId: "other",
        reviewId: review.reviewId,
        revision: review.revision,
      }),
    ).rejects.toThrow();
    f.change();
    await expect(
      host.confirm({
        sessionId: "s",
        reviewId: review.reviewId,
        revision: review.revision,
      }),
    ).rejects.toMatchObject({ code: "COMMAND_CHANGED" });
    expect(f.launch).not.toHaveBeenCalled();
  });
  it("will not launch when intent storage fails, or resend an unknown admission", async () => {
    const f = fixture(),
      host = new ChatCommandService(f.deps);
    const review = await host.review({
      sessionId: "s",
      text: "运行保存的日常",
    });
    f.deps.save.mockRejectedValueOnce(Error("disk"));
    await expect(
      host.confirm({
        sessionId: "s",
        reviewId: review.reviewId,
        revision: review.revision,
      }),
    ).rejects.toThrow();
    expect(f.launch).not.toHaveBeenCalled();
    const g = fixture();
    g.launch.mockRejectedValueOnce(Error("receipt lost"));
    const next = new ChatCommandService(g.deps),
      r = await next.review({ sessionId: "s", text: "运行保存的日常" });
    const input = {
      sessionId: "s",
      reviewId: r.reviewId,
      revision: r.revision,
    };
    expect((await next.confirm(input)).status).toBe("unknown");
    expect((await next.confirm(input)).status).toBe("unknown");
    const restarted = new ChatCommandService(g.deps);
    expect((await restarted.confirm(input)).status).toBe("unknown");
    expect(g.launch).toHaveBeenCalledTimes(1);
  });
  it("blocks admission if the session changes during the final preparation after intent was saved", async () => {
    const f = fixture(),
      host = new ChatCommandService(f.deps);
    const review = await host.review({
      sessionId: "s",
      text: "运行保存的日常",
    });
    f.deps.prepare
      .mockImplementationOnce(async () => f.prepared())
      .mockImplementationOnce(async () => {
        expect(f.deps.save.mock.calls.at(-1)?.[0].entries[0].status).toBe(
          "unknown",
        );
        f.changeContext();
        return f.prepared();
      });
    const input = {
      sessionId: "s",
      reviewId: review.reviewId,
      revision: review.revision,
    };
    const result = await host.confirm(input);
    expect(result.status).toBe("blocked");
    expect(result).not.toHaveProperty("receipt");
    expect(f.launch).not.toHaveBeenCalled();
    const restarted = new ChatCommandService(f.deps);
    expect((await restarted.confirm(input)).status).toBe("blocked");
    expect(f.launch).not.toHaveBeenCalled();
  });
  it("requires explicit acknowledgement for a partial continuation and passes it to the frozen host payload", async () => {
    const f = fixture();
    f.requireAcknowledgement();
    const host = new ChatCommandService(f.deps);
    const review = await host.review({
      sessionId: "s",
      text: "继续任务",
      requestId: "original:lane",
    });
    expect(review.needsAcknowledgement).toBe(true);
    const input = {
      sessionId: "s",
      reviewId: review.reviewId,
      revision: review.revision,
    };
    for (const acknowledgePartial of [undefined, false]) {
      await expect(
        host.confirm({ ...input, acknowledgePartial }),
      ).rejects.toMatchObject({ code: "PARTIAL_ACK_REQUIRED" });
    }
    expect(f.launch).not.toHaveBeenCalled();
    expect(
      (await host.confirm({ ...input, acknowledgePartial: true })).status,
    ).toBe("submitted");
    expect(f.launch).toHaveBeenCalledTimes(1);
    expect(f.launch.mock.calls[0][0].payload).toEqual({
      frozen: "host-plan",
      acknowledgePartial: true,
    });
    expect(f.launch.mock.calls[0][1]).toMatchObject({
      kind: "continue",
      parentId: "original:lane",
      needsAcknowledgement: true,
    });
  });
});
