import { expect, it } from "vitest";
import {
  clearSubmittedDraft,
  processingSession,
  sessionTaskState,
  updateSessionDraft,
} from "../apps/desktop/renderer/chat-workspace-state";
const goal = (
  id: string,
  sessionId: string,
  status = "waiting",
  satisfied: boolean | null = null,
) =>
  ({
    id,
    sessionId,
    status,
    goalSatisfied: satisfied,
    createdAt: "2026-10-07T08:00:00Z",
  }) as any;
it("does not infer session ownership from a shared turn, device or newer other-session goal", () => {
  const result = sessionTaskState("a", [
    goal("other", "b", "completed", true),
    goal("own", "a"),
  ]);
  expect(result.entries.map((g) => g.id)).toEqual(["own"]);
  expect(result.tone).toBe("running");
  expect(sessionTaskState(undefined, result.entries).entries).toEqual([]);
});
it.each(["unknown", "needs-user", "failed", "completed"])(
  "keeps unconfirmed %s goals out of success",
  (status) => {
    const result = sessionTaskState("a", [goal("own", "a", status)]);
    expect(result.attention).toHaveLength(1);
    expect(result.completed).toEqual([]);
    expect(result.tone).toBe("attention");
  },
);
it("does not let a satisfied historical goal mask a current unconfirmed one", () => {
  expect(
    sessionTaskState("a", [
      goal("finished", "a", "completed", true),
      goal("uncertain", "a", "unknown"),
    ]).tone,
  ).toBe("attention");
});
it("marks success only when every current-session goal is verified complete", () => {
  expect(
    sessionTaskState("a", [goal("finished", "a", "completed", true)]).tone,
  ).toBe("success");
  expect(
    sessionTaskState("a", [
      goal("finished", "a", "completed", true),
      goal("stopped", "a", "cancelled"),
    ]).tone,
  ).toBe("idle");
});
it("does not associate one active model ID with an ambiguous pair of sessions", () => {
  const active = { planner: { requestId: "shared", status: "running" } };
  expect(
    processingSession(
      [
        { id: "a", turns: [active] },
        { id: "b", turns: [active] },
      ] as any,
      "shared",
    ),
  ).toBeUndefined();
});
it("restores independent drafts and only clears the original submitted text", () => {
  let drafts = updateSessionDraft({}, "a", "领取邮件");
  drafts = updateSessionDraft(drafts, "b", "只查记录");
  const before = structuredClone(drafts);
  const result = clearSubmittedDraft(drafts, "a", "领取邮件");
  expect(result.a.text).toBe("");
  expect(result.b.text).toBe("只查记录");
  expect(drafts).toEqual(before);
  const changed = updateSessionDraft(drafts, "a", "先不要运行，只查记录");
  expect(clearSubmittedDraft(changed, "a", "领取邮件")).toBe(changed);
});
it("preserves the reference-data mode with its own session draft", () => {
  const drafts = updateSessionDraft(
    { a: { text: "之前的演练", source: "fixture" } },
    "a",
    "新的演练需求",
  );
  expect(drafts.a.source).toBe("fixture");
  expect(updateSessionDraft(drafts, "b", "账号二实况").b.source).toBe(
    "recorded",
  );
});
