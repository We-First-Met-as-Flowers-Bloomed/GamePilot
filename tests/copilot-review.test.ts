import { expect, it } from "vitest";
import {
  validateCopilotReview,
  isCopilotReview,
  copilotReviewFromPlan,
  type CopilotReview,
} from "../packages/protocol/copilot-review";
import { validatePreparedCopilotPlan } from "../packages/protocol/copilot";
const review: CopilotReview = {
  version: 1,
  preparedId: "12345678-1234-4234-8234-123456789abc",
  planHash: "a".repeat(64),
  revision: "c".repeat(64),
  laneName: "槽位 1",
  uidTail: "1234",
  clientType: "Official",
  stage: "1-7",
  count: 2,
  expiresAt: "2026-10-12T04:10:00.000Z",
  jobs: [
    { id: 1, title: "fixture", sha256: "b".repeat(64) },
    { id: 1, title: "fixture", sha256: "b".repeat(64) },
  ],
};
it("accepts bounded reviews including expired inert history and returns independent job objects", () => {
  const copy = validateCopilotReview(review);
  expect(copy).toEqual(review);
  copy.jobs[0].title = "changed";
  expect(review.jobs[0].title).toBe("fixture");
  for (const count of [1, 2, 3])
    expect(
      isCopilotReview({
        ...review,
        count,
        jobs: Array.from({ length: count }, () => ({
          ...review.jobs[0],
          title: "",
        })),
      }),
    ).toBe(true);
});
it.each([
  ["empty", {}],
  ["version", { ...review, version: 2 }],
  ["prepared UUID", { ...review, preparedId: "prepared-A" }],
  ["hash", { ...review, planHash: "f".repeat(63) }],
  ["revision", { ...review, revision: "revision-A" }],
  ["lane name", { ...review, laneName: "" }],
  ["lane length", { ...review, laneName: "x".repeat(161) }],
  ["control text", { ...review, laneName: "槽位\n1" }],
  ["UID tail", { ...review, uidTail: "12345" }],
  ["client", { ...review, clientType: "Unknown" }],
  ["stage", { ...review, stage: "1-7#f" }],
  ["count zero", { ...review, count: 0 }],
  ["count excess", { ...review, count: 4 }],
  ["fractional count", { ...review, count: 1.5 }],
  ["jobs count", { ...review, jobs: [review.jobs[0]] }],
  ["jobs container", { ...review, jobs: {} }],
  ["sparse jobs", { ...review, jobs: Array(2) }],
  ["missing job", { ...review, jobs: [null, review.jobs[0]] }],
  [
    "job ID",
    { ...review, jobs: [{ ...review.jobs[0], id: 0 }, review.jobs[1]] },
  ],
  [
    "job title",
    {
      ...review,
      jobs: [{ ...review.jobs[0], title: "x".repeat(257) }, review.jobs[1]],
    },
  ],
  [
    "job control",
    {
      ...review,
      jobs: [{ ...review.jobs[0], title: "title\u0000" }, review.jobs[1]],
    },
  ],
  [
    "job hash",
    { ...review, jobs: [{ ...review.jobs[0], sha256: "b" }, review.jobs[1]] },
  ],
  [
    "job extra path",
    {
      ...review,
      jobs: [
        { ...review.jobs[0], file: "D:/private/job.json" },
        review.jobs[1],
      ],
    },
  ],
  ["invalid date", { ...review, expiresAt: "2026-02-30T04:10:00.000Z" }],
  ["loose date", { ...review, expiresAt: "2026-10-12" }],
  ["extra authority", { ...review, canExecute: true }],
])("rejects malformed %s review before rendering", (_name, value) => {
  expect(() => validateCopilotReview(value)).toThrow();
  expect(isCopilotReview(value)).toBe(false);
});
it("host projection freezes only reviewed fields and omits account UID and content paths", () => {
  const plan = validatePreparedCopilotPlan({
    version: 1,
    preparedId: review.preparedId,
    planHash: review.planHash,
    revision: review.revision,
    createdAt: "2026-10-12T04:00:00.000Z",
    expiresAt: review.expiresAt,
    account: {
      profileId: "profile-private",
      expectedUid: "99881234",
      clientType: review.clientType,
      revision: review.revision,
    },
    stage: { id: "main_01-07", code: review.stage, aliases: ["main_01-07"] },
    count: 2,
    jobs: review.jobs.map((j) => ({
      ...j,
      stageName: "main_01-07",
      file: "D:/private/job.json",
    })),
    budget: { maxBattles: 2, sanityPotions: 0, originite: 0 },
    skipStory: true,
    precheck: { status: "pending-live", unknown: [] },
  });
  const projected = copilotReviewFromPlan(plan, review.laneName);
  expect(projected).toEqual(review);
  const serialized = JSON.stringify(projected);
  expect(serialized).not.toContain("99881234");
  expect(serialized).not.toContain("profile-private");
  expect(serialized).not.toContain("D:/private");
  expect(() =>
    copilotReviewFromPlan({ ...plan, revision: "invalid" }, review.laneName),
  ).toThrow();
});
