import { describe, expect, it } from "vitest";
import {
  summarizeDailyIdempotency,
  toDailyRunRecord,
  type DailyRunRecord,
} from "../packages/runtime/daily-idempotency";

const SKILLS = [
  "login",
  "recruit",
  "fight",
  "infrastructure",
  "friends",
  "award",
];

function run(
  startedAt: string,
  statuses: Record<string, string>,
): DailyRunRecord {
  return {
    startedAt,
    finishedAt: new Date(Date.parse(startedAt) + 60_000).toISOString(),
    outcomes: SKILLS.map((skill) => ({
      skill,
      status: statuses[skill] ?? "succeeded",
    })),
  };
}

describe("daily idempotency", () => {
  it("同一天两次运行都成功 → 幂等", () => {
    const report = summarizeDailyIdempotency(
      [run("2026-10-22T03:52:00Z", {}), run("2026-10-22T07:58:00Z", {})],
      SKILLS,
    );
    expect(report.idempotent).toBe(true);
    expect(report.runs).toBe(2);
    expect(report.perRun.map((item) => item.succeeded)).toEqual([6, 6]);
    expect(report.reasons).toEqual([]);
  });

  it("第二遍出现 blocked → 判定为不幂等并给出原因", () => {
    const report = summarizeDailyIdempotency(
      [
        run("2026-10-22T03:52:00Z", {}),
        run("2026-10-22T07:58:00Z", { infrastructure: "blocked" }),
      ],
      SKILLS,
    );
    expect(report.idempotent).toBe(false);
    expect(report.perRun[1].failed).toBe(1);
    expect(report.reasons.join()).toMatch(/第 2 次运行有 1 步未成功/);
  });

  it("缺少步骤也算不通过", () => {
    const partial = run("2026-10-22T03:52:00Z", {});
    const withoutAward: DailyRunRecord = {
      ...partial,
      outcomes: partial.outcomes.filter((item) => item.skill !== "award"),
    };
    const report = summarizeDailyIdempotency([withoutAward], SKILLS);
    expect(report.idempotent).toBe(false);
    expect(report.perRun[0].missing).toEqual(["award"]);
  });

  it("空输入不判定为幂等", () => {
    expect(summarizeDailyIdempotency([], SKILLS).idempotent).toBe(false);
  });

  it.each(["cancelled", "running", "pending", "skipped", "unexpected"])(
    "非成功状态 %s 不应被遗漏为幂等成功",
    (status) => {
      const report = summarizeDailyIdempotency(
        [
          run("2026-10-22T03:52:00Z", {}),
          run(
            "2026-10-22T07:58:00Z",
            Object.fromEntries(SKILLS.map((skill) => [skill, status])),
          ),
        ],
        SKILLS,
      );
      expect(report.idempotent).toBe(false);
      expect(report.perRun[1].failed).toBe(6);
    },
  );

  it("一次成功运行不能证明重复执行幂等", () => {
    const report = summarizeDailyIdempotency(
      [run("2026-10-22T03:52:00Z", {})],
      SKILLS,
    );
    expect(report.idempotent).toBe(false);
    expect(report.reasons.join()).toMatch(/至少.*2/);
  });

  it("复制同一次产物不算两次运行", () => {
    const first = run("2026-10-22T03:52:00Z", {});
    expect(summarizeDailyIdempotency([first, first], SKILLS).idempotent).toBe(
      false,
    );
  });

  it("合法跳过需引用较早实成功运行的证据，且不增加成功数", () => {
    const first = run("2026-10-22T03:52:00Z", {});
    const later = {
      ...run("2026-10-22T07:58:00Z", {}),
      outcomes: SKILLS.map((skill) => ({
        skill,
        status: "skipped",
        evidence: { kind: "already-completed", runStartedAt: first.startedAt },
      })),
    };
    const report = summarizeDailyIdempotency([first, later], SKILLS);
    expect(report.idempotent).toBe(true);
    expect(report.perRun[1]).toMatchObject({
      succeeded: 0,
      skipped: 6,
      failed: 0,
    });
  });

  it("跨日运行不能证明同日幂等", () => {
    expect(
      summarizeDailyIdempotency(
        [run("2026-10-22T03:52:00Z", {}), run("2026-10-23T03:52:00Z", {})],
        SKILLS,
      ).idempotent,
    ).toBe(false);
  });

  it("按 startedAt 排序后再编号", () => {
    const late = run("2026-10-22T07:58:00Z", {});
    const early = run("2026-10-22T03:52:00Z", {});
    const report = summarizeDailyIdempotency([late, early], SKILLS);
    expect(report.perRun[0].finishedAt).toBe(early.finishedAt);
  });

  it("toDailyRunRecord 容忍缺字段与脏条目", () => {
    expect(toDailyRunRecord(null)).toBeNull();
    expect(toDailyRunRecord({ startedAt: "x" })).toBeNull();
    const parsed = toDailyRunRecord({
      startedAt: "2026-10-22T03:52:00Z",
      finishedAt: "2026-10-22T04:00:00Z",
      outcomes: [{ skill: "login", status: "succeeded" }, null, { skill: 1 }],
    });
    expect(parsed?.outcomes).toEqual([{ skill: "login", status: "succeeded" }]);
  });
});
