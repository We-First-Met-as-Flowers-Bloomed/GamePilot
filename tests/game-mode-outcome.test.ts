import { describe, expect, it } from "vitest";
import type { SkillResult } from "../packages/protocol";
import type { StepOutcome } from "../scripts/game-mode/report";
import {
  completionState,
  isSettledOutcome,
  stepOutcomeFromResult,
} from "../scripts/game-mode/outcome";

const START = "2026-10-15T01:00:00.000Z";
const OBSERVED = "2026-10-15T01:00:01.000Z";
const FINISH = "2026-10-15T01:00:02.000Z";
const gift = { skill: "daily-gift", label: "每日免费礼包", required: true };
const proof = (fields: Partial<SkillResult> = {}): SkillResult => ({
  status: "succeeded",
  goalSatisfied: true,
  evidenceTimestamp: OBSERVED,
  evidenceReference: "onmyoji:daily-gift:reward-and-cleared-claim",
  ...fields,
});
const row = (fields: Partial<StepOutcome> = {}): StepOutcome => ({
  ...gift,
  status: "succeeded",
  attempts: 1,
  startedAt: START,
  finishedAt: FINISH,
  ...fields,
});
describe("game mode outcome capture", () => {
  it("preserves adapter skip status and all facts for an unconfirmed gift", async () => {
    const result: SkillResult = {
      status: "skipped",
      summary: "每日免费礼包领取状态未确认，本次未点击",
      skipReason: "unavailable",
      goalSatisfied: null,
      evidenceTimestamp: OBSERVED,
      evidenceReference: "onmyoji:daily-gift:free-claim-unavailable",
      outcome: "no-input",
      observedAt: OBSERVED,
      nextRunAt: "2026-10-16T01:00:00.000Z",
      onmyoji: {
        version: 1,
        skillId: "daily-gift",
        phase: "not-submitted",
        observedAt: OBSERVED,
        effects: [],
      },
    };
    const before = structuredClone(result);
    const outcome = stepOutcomeFromResult(gift, result, 1, START, FINISH);
    expect(outcome).toEqual({
      ...gift,
      ...result,
      attempts: 1,
      startedAt: START,
      finishedAt: FINISH,
    });
    expect(completionState(outcome)).toBe("unknown");
    expect(isSettledOutcome(outcome)).toBe(false);
    expect(result).toEqual(before);
  });

  it("keeps a verified already-completed gift as skipped", async () => {
    const result = proof({
      status: "skipped",
      skipReason: "already-completed",
      summary: "已领取",
    });
    const outcome = stepOutcomeFromResult(gift, result, 2, START, FINISH);
    expect(outcome.status).toBe("skipped");
    expect(outcome.attempts).toBe(2);
    expect(completionState(outcome)).toBe("skipped");
    expect(isSettledOutcome(outcome)).toBe(true);
  });

  it("captures only execution metadata from the full plan step", async () => {
    const step = {
      ...gift,
      when: "always",
      guide: "daily-gift",
      expect: "入口消失",
    };
    const outcome = stepOutcomeFromResult(step, proof(), 1, START, FINISH);
    expect(outcome).not.toHaveProperty("when");
    expect(outcome).not.toHaveProperty("guide");
    expect(outcome).not.toHaveProperty("expect");
  });

  it("preserves legacy adapter-return success without adding structured claims", async () => {
    const outcome = stepOutcomeFromResult(
      { skill: "fight", label: "理智作战", required: true },
      undefined,
      1,
      START,
      FINISH,
    );
    expect(outcome.status).toBe("succeeded");
    expect(outcome).not.toHaveProperty("goalSatisfied");
    expect(completionState(outcome)).toBe("succeeded");
  });

  it("keeps legacy Arknights structured receipts without requiring goalSatisfied", async () => {
    const result: SkillResult = {
      summary: "作战完成",
      arknights: {
        version: 1,
        taskType: "Fight",
        submission: "submitted",
        completion: "native-confirmed",
        taskId: 1,
        observedAt: OBSERVED,
      },
    };
    const outcome = stepOutcomeFromResult(
      { skill: "fight", label: "理智作战", required: true },
      result,
      1,
      START,
      FINISH,
    );
    expect(outcome.arknights).toEqual(result.arknights);
    expect(completionState(outcome)).toBe("succeeded");
  });

  it("rejects malformed Arknights evidence before claiming success", () => {
    const outcome = row({
      skill: "fight",
      arknights: {} as SkillResult["arknights"],
    });
    expect(completionState(outcome)).toBe("unknown");
    expect(isSettledOutcome(outcome)).toBe(false);
  });

  it("does not claim success from an Arknights receipt whose completion is unknown", () => {
    const outcome = row({
      skill: "fight",
      arknights: {
        version: 1,
        taskType: "Fight",
        submission: "submitted",
        completion: "unknown",
        taskId: 1,
        observedAt: OBSERVED,
      },
    });
    expect(completionState(outcome)).toBe("unknown");
    expect(outcome.arknights?.completion).toBe("unknown");
  });

  it("keeps a lawful Arknights skip with valid not-started evidence", () => {
    const outcome = row({
      ...proof({
        status: "skipped",
        skipReason: "not-open",
        goalSatisfied: null,
      }),
      skill: "fight",
      arknights: {
        version: 1,
        taskType: "Fight",
        submission: "not-submitted",
        completion: "not-started",
        observedAt: OBSERVED,
      },
    });
    expect(completionState(outcome)).toBe("skipped");
  });

  it.each(["daily-gift", "fight"])(
    "classifies malformed %s summary as unknown without throwing",
    (skill) => {
      const outcome = row({ skill, summary: 42 as unknown as string });
      expect(() => completionState(outcome)).not.toThrow();
      expect(completionState(outcome)).toBe("unknown");
    },
  );

  it.each(["领取状态未确认，本次未点击", "领取状态无法确认；未触碰付费礼包"])(
    "quarantines legacy gift success with %s",
    async (summary) => {
      const outcome = Object.freeze(row({ summary }));
      expect(completionState(outcome)).toBe("unknown");
      expect(isSettledOutcome(outcome)).toBe(false);
      expect(outcome.status).toBe("succeeded");
    },
  );

  it("accepts valid positive structured proof despite old negative summary text", async () => {
    expect(
      completionState(row({ ...proof(), summary: "领取状态未确认" })),
    ).toBe("succeeded");
  });

  it.each([
    { goalSatisfied: true },
    proof({ evidenceTimestamp: "invalid" }),
    proof({ evidenceReference: "" }),
    proof({ skipReason: "unavailable" }),
    proof({
      onmyoji: {
        version: 1,
        skillId: "daily-gift",
        phase: "not-submitted",
        observedAt: OBSERVED,
        effects: [],
      },
    }),
  ])(
    "rejects invalid structured claims before marking complete: %j",
    async (result) => {
      expect(completionState(row(result))).toBe("unknown");
    },
  );

  it.each([
    proof({ goalSatisfied: null }),
    proof({ goalSatisfied: false }),
    proof({
      status: "skipped",
      goalSatisfied: null,
      skipReason: "unavailable",
    }),
    proof({ status: "skipped", goalSatisfied: null, skipReason: "unknown" }),
  ])(
    "does not settle an uncertain or unsatisfied outcome: %j",
    async (result) => {
      expect(completionState(row(result))).toBe("unknown");
      expect(isSettledOutcome(row(result))).toBe(false);
    },
  );

  it.each(["not-open", "user-excluded"] as const)(
    "preserves the lawful %s skip with a null goal",
    async (skipReason) => {
      const outcome = row(
        proof({ status: "skipped", goalSatisfied: null, skipReason }),
      );
      expect(completionState(outcome)).toBe("skipped");
      expect(isSettledOutcome(outcome)).toBe(true);
    },
  );

  it("preserves exhausted optional oboroguruma as a lawful skip", async () => {
    const outcome = row({
      ...proof({
        status: "skipped",
        goalSatisfied: false,
        skipReason: "unavailable",
        evidenceReference: "onmyoji:oboroguruma:no-runs-available",
      }),
      skill: "oboroguruma",
      required: false,
    });
    expect(completionState(outcome)).toBe("skipped");
    expect(isSettledOutcome(outcome)).toBe(true);
  });

  it("preserves legacy game-limit recovery skips", async () => {
    expect(
      completionState(
        row({
          status: "skipped",
          failure: { class: "game-limit", message: "已达上限" },
        }),
      ),
    ).toBe("skipped");
  });

  it.each([
    "2026-10-15T00:59:59.000Z",
    "2026-10-15T01:00:03.000Z",
    "2100-01-01T00:00:00.000Z",
  ])(
    "does not use evidence from outside the attempt: %s",
    async (evidenceTimestamp) => {
      expect(completionState(row(proof({ evidenceTimestamp })))).toBe(
        "unknown",
      );
    },
  );

  it("does not use future proof in a legacy record without attempt bounds", async () => {
    expect(
      completionState(
        row({
          ...proof({ evidenceTimestamp: "2100-01-01T00:00:00.000Z" }),
          startedAt: undefined,
          finishedAt: undefined,
        }),
      ),
    ).toBe("unknown");
  });

  it("checks effect evidence timestamps as well as the top-level timestamp", async () => {
    expect(
      completionState(
        row(
          proof({
            onmyoji: {
              version: 1,
              skillId: "daily-gift",
              phase: "confirmed",
              observedAt: OBSERVED,
              effects: [
                {
                  kind: "free-daily-gift",
                  observedAt: "2026-10-15T00:59:59.000Z",
                  evidenceReference: "onmyoji:daily-gift:effect:1",
                  summary: "已领取",
                },
              ],
            },
          }),
        ),
      ),
    ).toBe("unknown");
  });

  it("does not use another skill's confirmed effects", async () => {
    expect(
      completionState(
        row(
          proof({
            onmyoji: {
              version: 1,
              skillId: "mail",
              phase: "confirmed",
              observedAt: OBSERVED,
              effects: [
                {
                  kind: "mail-claim",
                  observedAt: OBSERVED,
                  evidenceReference: "onmyoji:mail:effect:1",
                  summary: "已领取",
                },
              ],
            },
          }),
        ),
      ),
    ).toBe("unknown");
  });

  it("preserves failed and blocked states", async () => {
    for (const status of ["failed", "blocked", "unknown"] as const) {
      expect(completionState(row({ status }))).toBe(status);
      expect(isSettledOutcome(row({ status }))).toBe(false);
    }
  });

  it.each(["unknown", "failed", "cancelled"])(
    "returns the App %s result without rerunning skills or recovering devices",
    async (status) => {
      const { runGameMode } = await import("../scripts/game-mode.mjs");
      let calls = 0;
      const code = await runGameMode(["--game", "onmyoji"], {
        read: () =>
          JSON.stringify({
            lanes: [
              {
                id: "yys",
                enabled: true,
                instance: 2,
                onmyoji: { enabled: true },
              },
            ],
          }),
        run: async () => {
          calls++;
          return { batchId: "original", status };
        },
        mkdir: () => {},
        write: () => {},
        log: () => {},
      });
      expect(code).toBe(1);
      expect(calls).toBe(1);
    },
  );
});
