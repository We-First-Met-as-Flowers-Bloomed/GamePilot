import { expect, it } from "vitest";
import {
  ArknightsTaskEvidence,
  validArknightsEvidence,
} from "../games/arknights/evidence";

const callback = (
  code: number,
  taskchain: string,
  extra: object = {},
  taskid = 1,
) => `MAA ${code}: ${JSON.stringify({ taskchain, taskid, ...extra })}`;
const extra = (task: string, what: string, details: object, taskid = 1) =>
  callback(20003, task, { what, details }, taskid);
const node = (
  code: number,
  chain: string,
  task: string,
  times = 1,
  taskid = 1,
) =>
  callback(
    code,
    chain,
    { subtask: "ProcessTask", details: { task, exec_times: times } },
    taskid,
  );
const start = (task: string) => {
  const tracker = new ArknightsTaskEvidence(task);
  tracker.accept(callback(10001, task));
  return tracker;
};
const pair = (
  tracker: ArknightsTaskEvidence,
  chain: string,
  task: string,
  times = 1,
) => {
  tracker.accept(node(20001, chain, task, times));
  tracker.accept(node(20002, chain, task, times));
};
const stats = (tracker: ArknightsTaskEvidence, returned = false): any =>
  (tracker.finish(true, returned) as any).statistics;

it("keeps cumulative fight observations separate from the last settlement batch", () => {
  const tracker = start("Fight");
  tracker.accept(extra("Fight", "SanityBeforeStage", { current_sanity: 210 }));
  tracker.accept(
    extra("Fight", "FightTimes", {
      times_finished: 0,
      sanity_cost: 360,
      series: 10,
    }),
  );
  tracker.accept(
    extra("Fight", "StageDrops", {
      stage: { stageCode: "LS-6" },
      stars: 3,
      cur_times: 5,
    }),
  );
  tracker.accept(
    extra("Fight", "FightTimes", {
      times_finished: 5,
      sanity_cost: 36,
      series: 1,
    }),
  );
  tracker.accept(
    extra("Fight", "FightTimes", {
      times_finished: 5,
      sanity_cost: 36,
      series: 1,
    }),
  );
  tracker.accept(extra("Fight", "SanityBeforeStage", { current_sanity: 30 }));
  tracker.accept(
    extra("Fight", "StageDrops", {
      stage: { stageCode: "LS-6" },
      stars: 3,
      cur_times: 1,
    }),
  );
  tracker.accept(callback(10002, "Fight"));
  expect(stats(tracker, true)).toEqual({
    version: 1,
    fight: { completedRunsObserved: 5, firstSanity: 210, latestSanity: 30 },
  });
  expect(tracker.finish(true, true).lastSettlement?.batchRuns).toBe(1);
});

it("keeps zero observations, natural sanity recovery and absent observations distinct", () => {
  const tracker = start("Fight");
  expect(stats(tracker)).toBeUndefined();
  tracker.accept(extra("Fight", "FightTimes", { times_finished: 0 }));
  tracker.accept(extra("Fight", "SanityBeforeStage", { current_sanity: 25 }));
  tracker.accept(extra("Fight", "SanityBeforeStage", { current_sanity: 26 }));
  expect(stats(tracker)).toEqual({
    version: 1,
    fight: { completedRunsObserved: 0, firstSanity: 25, latestSanity: 26 },
  });
});

it("uses the highest native cumulative report without deriving totals from settlement or retry cost", () => {
  const tracker = start("Fight");
  tracker.accept(extra("Fight", "FightTimes", { times_finished: 6 }));
  tracker.accept(
    extra("Fight", "FightTimes", { times_finished: 3, sanity_cost: 999 }),
  );
  expect(stats(tracker)?.fight).toEqual({ completedRunsObserved: 6 });
  const noCount = start("Fight");
  noCount.accept(
    extra("Fight", "StageDrops", {
      stage: { stageCode: "LS-6" },
      stars: 3,
      cur_times: 5,
    }),
  );
  noCount.accept(callback(10002, "Fight"));
  expect(stats(noCount, true)).toBeUndefined();
});

it("isolates another task, malformed values, callback boundaries and identity changes", () => {
  const tracker = new ArknightsTaskEvidence("Fight");
  tracker.accept(extra("Fight", "FightTimes", { times_finished: 99 }));
  tracker.accept(callback(10001, "Fight"));
  tracker.accept(extra("Fight", "FightTimes", { times_finished: 99 }, 2));
  tracker.accept(extra("Mall", "FightTimes", { times_finished: 99 }));
  for (const n of [-1, 0.5, "5", null, Number.MAX_SAFE_INTEGER]) {
    tracker.accept(extra("Fight", "FightTimes", { times_finished: n }));
    tracker.accept(extra("Fight", "SanityBeforeStage", { current_sanity: n }));
  }
  expect(stats(tracker)).toBeUndefined();
  tracker.accept(extra("Fight", "FightTimes", { times_finished: 2 }));
  tracker.accept(callback(10002, "Fight"));
  tracker.accept(extra("Fight", "FightTimes", { times_finished: 99 }));
  expect(stats(tracker, true)?.fight.completedRunsObserved).toBe(2);
  tracker.accept(callback(10001, "Fight", {}, 2));
  expect(stats(tracker)).toBeUndefined();
  expect((tracker.finish(false, false) as any).statistics).toBeUndefined();
});

it("counts five purchases with reset node counters without counting repeated reward dismissal", () => {
  const tracker = start("Mall");
  for (let n = 0; n < 5; n++) {
    pair(tracker, "Mall", "CreditShop-BuyIt");
    pair(tracker, "Mall", "CreditShop-Bought");
    tracker.accept(node(20002, "Mall", "CreditShop-Bought"));
    pair(tracker, "Mall", "CreditShop-Bought", 2);
  }
  pair(tracker, "Mall", "CollectCredit");
  tracker.accept(callback(10002, "Mall"));
  expect(stats(tracker, true)).toEqual({
    version: 1,
    mall: { purchaseConfirmations: 5, creditCollected: true },
  });
});

it("does not count unpaired, mismatched or failed purchase actions", () => {
  const tracker = start("Mall");
  tracker.accept(node(20002, "Mall", "CreditShop-BuyIt"));
  pair(tracker, "Mall", "CreditShop-Bought");
  tracker.accept(node(20001, "Mall", "CreditShop-BuyIt", 1));
  tracker.accept(node(20002, "Mall", "CreditShop-BuyIt", 2));
  pair(tracker, "Mall", "CreditShop-Bought");
  pair(tracker, "Mall", "CreditShop-BuyIt");
  pair(tracker, "Mall", "CreditShop-NoMoney");
  pair(tracker, "Mall", "CreditShop-Bought");
  expect(stats(tracker)?.mall.purchaseConfirmations).toBe(0);
  tracker.accept(node(20001, "Mall", "CreditShop-BuyIt"));
  tracker.accept(callback(20000, "Mall", { subtask: "ProcessTask" }));
  tracker.accept(node(20002, "Mall", "CreditShop-BuyIt"));
  pair(tracker, "Mall", "CreditShop-Bought");
  expect(stats(tracker)?.mall.purchaseConfirmations).toBe(0);
});

it("requires the same task identity and node counter for every confirmation", () => {
  const tracker = start("Mall");
  pair(tracker, "Mall", "CreditShop-BuyIt");
  tracker.accept(node(20001, "Mall", "CreditShop-Bought"));
  tracker.accept(node(20002, "Mall", "CreditShop-Bought", 1, 2));
  tracker.accept(node(20002, "Award", "CreditShop-Bought"));
  expect(stats(tracker)?.mall.purchaseConfirmations).toBe(0);
  tracker.accept(node(20002, "Mall", "CreditShop-Bought"));
  expect(stats(tracker)?.mall.purchaseConfirmations).toBe(1);
  tracker.accept(callback(10002, "Mall"));
  pair(tracker, "Mall", "CreditShop-BuyIt");
  pair(tracker, "Mall", "CreditShop-Bought");
  expect(stats(tracker, true)?.mall.purchaseConfirmations).toBe(1);
});

it("keeps missing unsuccessful Mall/Award observations unknown and permits a completed observation window", () => {
  for (const chain of ["Mall", "Award"]) {
    const tracker = start(chain);
    expect(stats(tracker)).toBeUndefined();
    tracker.accept(callback(10002, chain));
    expect(stats(tracker)).toBeUndefined(); // Native completion alone is not a successful return.
    expect(stats(tracker, true)).toEqual(
      chain === "Mall"
        ? {
            version: 1,
            mall: { purchaseConfirmations: 0, creditCollected: false },
          }
        : { version: 1, award: { claimActions: 0, mail: "unobserved" } },
    );
  }
});

it("records shopping branch errors and discount-only stopping without claiming purchases", () => {
  const tracker = start("Mall");
  tracker.accept(callback(20000, "Mall", { subtask: "CreditShoppingTask" }));
  tracker.accept(extra("Mall", "CreditFullOnlyBuyDiscount", { credit: 893 }));
  tracker.accept(callback(10002, "Mall"));
  expect(stats(tracker, true)?.mall).toEqual({
    purchaseConfirmations: 0,
    creditCollected: false,
    shoppingErrorObserved: true,
    discountOnlyStoppedAtCredit: 893,
  });
});

it("isolates shopping stop observations from other tasks and invalid credit values", () => {
  const tracker = start("Mall");
  tracker.accept(extra("Award", "CreditFullOnlyBuyDiscount", { credit: 999 }));
  tracker.accept(
    extra("Mall", "CreditFullOnlyBuyDiscount", { credit: 999 }, 2),
  );
  tracker.accept(callback(20000, "Mall", { subtask: "VisitTask" }));
  for (const credit of [-1, 1.5, "893", null, Number.MAX_SAFE_INTEGER])
    tracker.accept(extra("Mall", "CreditFullOnlyBuyDiscount", { credit }));
  tracker.accept(callback(10002, "Mall"));
  expect(stats(tracker, true)?.mall).toEqual({
    purchaseConfirmations: 0,
    creditCollected: false,
  });
});

it("validates optional shopping observations while keeping old statistics compatible", () => {
  const tracker = start("Mall");
  tracker.accept(callback(10002, "Mall"));
  const evidence = tracker.finish(true, true);
  const observed = {
    purchaseConfirmations: 0,
    creditCollected: false,
    discountOnlyStoppedAtCredit: 613,
    shoppingErrorObserved: true,
  };
  expect(
    validArknightsEvidence({
      ...evidence,
      statistics: { version: 1, mall: observed },
    }),
  ).toBe(true);
  for (const value of [-1, 1.5, "613", null, Number.MAX_SAFE_INTEGER])
    expect(
      validArknightsEvidence({
        ...evidence,
        statistics: {
          version: 1,
          mall: { ...observed, discountOnlyStoppedAtCredit: value },
        },
      }),
    ).toBe(false);
  for (const value of [false, "true", 1, null])
    expect(
      validArknightsEvidence({
        ...evidence,
        statistics: {
          version: 1,
          mall: { ...observed, shoppingErrorObserved: value },
        },
      }),
    ).toBe(false);
});

it("matches claim actions once and distinguishes a claim click from confirmed or empty mail", () => {
  const tracker = start("Award");
  pair(tracker, "Award", "ReceiveAward", 1);
  tracker.accept(node(20002, "Award", "ReceiveAward", 1));
  tracker.accept(node(20001, "Award", "ReceiveAward", 2));
  tracker.accept(node(20002, "Award", "ReceiveAward", 2));
  pair(tracker, "Award", "ReceiveMail");
  expect(stats(tracker)?.award).toEqual({
    claimActions: 2,
    mail: "unobserved",
  });
  pair(tracker, "Award", "ReceivedAllMail");
  expect(stats(tracker)?.award.mail).toBe("claim-confirmed");
  pair(tracker, "Award", "MailWithoutAward");
  expect(stats(tracker)?.award.mail).toBe("claim-confirmed");
  const empty = start("Award");
  pair(empty, "Award", "MailWithoutAward");
  expect(stats(empty)?.award).toEqual({ claimActions: 0, mail: "empty" });
});

it("does not turn an unmatched mail popup or replayed claim counter into another confirmed claim", () => {
  const tracker = start("Award");
  pair(tracker, "Award", "ReceivedAllMail");
  expect(stats(tracker)?.award.mail).toBe("unobserved");
  pair(tracker, "Award", "ReceiveAward", 1);
  pair(tracker, "Award", "ReceiveAward", 1);
  expect(stats(tracker)?.award.claimActions).toBe(1);
  const snapshot = stats(tracker);
  snapshot.award.claimActions = 99;
  expect(stats(tracker)?.award.claimActions).toBe(1);
});

it("retains bounded partial evidence without making failed or cancelled chains successful", () => {
  for (const code of [10000, 10004]) {
    const tracker = start("Mall");
    pair(tracker, "Mall", "CreditShop-BuyIt");
    pair(tracker, "Mall", "CreditShop-Bought");
    tracker.accept(callback(code, "Mall"));
    pair(tracker, "Mall", "CreditShop-BuyIt");
    pair(tracker, "Mall", "CreditShop-Bought");
    tracker.accept(callback(10002, "Mall"));
    expect(stats(tracker, true)?.mall.purchaseConfirmations).toBe(1);
    expect(tracker.finish(true, true).completion).toBe("unknown");
  }
});

it("accepts compatible old records and rejects malformed or contradictory statistics", () => {
  const tracker = start("Fight");
  tracker.accept(callback(10002, "Fight"));
  const evidence = tracker.finish(true, true);
  expect(validArknightsEvidence(evidence)).toBe(true);
  const statistics = {
    version: 1,
    fight: { completedRunsObserved: 0, firstSanity: 25, latestSanity: 25 },
  };
  expect(validArknightsEvidence({ ...evidence, statistics })).toBe(true);
  const invalid = [
    null,
    [],
    {},
    { ...statistics, version: 2 },
    { version: 1, fight: {} },
    { version: 1, fight: { firstSanity: 25 } },
    { version: 1, fight: { completedRunsObserved: -1 } },
    { version: 1, fight: { completedRunsObserved: 1.5 } },
    { version: 1, fight: { completedRunsObserved: "1" } },
    { version: 1, fight: { firstSanity: 25, latestSanity: -1 } },
    { version: 1, mall: { purchaseConfirmations: 1, creditCollected: true } },
    { ...statistics, award: { claimActions: 1, mail: "empty" } },
  ];
  for (const value of invalid)
    expect(
      validArknightsEvidence({ ...evidence, statistics: value }),
      JSON.stringify(value),
    ).toBe(false);
  expect(
    validArknightsEvidence({
      ...evidence,
      submission: "not-submitted",
      completion: "not-started",
      taskId: undefined,
      statistics,
    }),
  ).toBe(false);
  expect(
    validArknightsEvidence({
      ...evidence,
      taskId: undefined,
      completion: "unknown",
      statistics,
    }),
  ).toBe(false);
  for (const [taskType, branch, value] of [
    ["Mall", "mall", { purchaseConfirmations: 0, creditCollected: false }],
    ["Award", "award", { claimActions: 0, mail: "unobserved" }],
  ] as const) {
    expect(
      validArknightsEvidence({
        ...evidence,
        taskType,
        statistics: { version: 1, [branch]: value },
      }),
    ).toBe(true);
    expect(
      validArknightsEvidence({
        ...evidence,
        taskType,
        statistics: {
          version: 1,
          [branch]: { ...value, claimActions: -1, purchaseConfirmations: -1 },
        },
      }),
    ).toBe(false);
  }
  for (const mail of [["empty"], null, 0, "unverified"])
    expect(
      validArknightsEvidence({
        ...evidence,
        taskType: "Award",
        statistics: {
          version: 1,
          award: { claimActions: 0, mail },
        },
      }),
    ).toBe(false);
});
