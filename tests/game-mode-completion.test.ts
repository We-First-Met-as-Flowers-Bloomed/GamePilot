import { describe, expect, it } from "vitest";
import { onmyojiMode } from "../scripts/game-mode/plans";
import { mergeRunOutcomes, renderReport, type LaneRun } from "../scripts/game-mode/report";
import { mergeStatus, renderDailyReport, renderStatus } from "../scripts/game-mode/status";
import { planCatchup, renderCatchup } from "../scripts/game-mode/catchup";

const t1 = "2026-10-15T04:00:00.000Z";
const t2 = "2026-10-15T05:00:00.000Z";
const t3 = "2026-10-15T06:00:00.000Z";
const giftUnknown = "每日礼包入口显示数字，疑似付费入口；领取状态未确认，本次未点击";
const plan = (skill: string) => ({ ...onmyojiMode, steps: onmyojiMode.steps.filter(s => s.skill === skill) });
const lanes = [{ id: "lane-a", name: "账号一", enabled: { onmyoji: true, arknights: false } }];
const run = (skill: string, status: "succeeded" | "skipped" | "failed", finishedAt = t1): LaneRun => ({
  lane: "lane-a", laneName: "账号一", game: "onmyoji", address: "127.0.0.1:16384",
  startedAt: finishedAt, finishedAt,
  outcomes: [{ skill, label: skill, required: true, status, summary: "完成", attempts: 1 }],
});

describe("game-mode completion evidence", () => {
  it("shows both legacy unconfirmed gifts as unknown without rewriting their histories", () => {
    const runs = [run("daily-gift", "succeeded"), { ...run("daily-gift", "succeeded"), lane: "lane-b", laneName: "账号二" }];
    for (const r of runs) r.outcomes[0]!.summary = giftUnknown;
    const before = JSON.stringify(runs);
    const statuses = mergeStatus({ plans: [plan("daily-gift")], lanes: [...lanes, { ...lanes[0]!, id: "lane-b", name: "账号二" }], requests: [], runs });
    expect(statuses.map(s => s.items[0]!.state)).toEqual(["unknown", "unknown"]);
    expect(statuses.every(s => s.missing.includes("每日免费礼包"))).toBe(true);
    expect(planCatchup(statuses)).toEqual([]);
    expect(renderStatus("2026-10-15", statuses)).toContain("待核对");
    expect(renderStatus("2026-10-15", statuses)).not.toContain("**必做项全部完成**");
    expect(renderReport("2026-10-15", runs)).not.toContain("| ✅ | daily-gift");
    expect(renderCatchup([], statuses)).toContain("待核对");
    expect(JSON.stringify(runs)).toBe(before);
  });

  it("settles an already-completed skip without relabeling it as an execution", () => {
    const r = run("daily-gift", "skipped");
    Object.assign(r.outcomes[0]!, { skipReason: "already-completed", goalSatisfied: true, evidenceTimestamp: t1, evidenceReference: "gift:completed" });
    const statuses = mergeStatus({ plans: [plan("daily-gift")], lanes, requests: [], runs: [r] });
    expect(statuses[0]!.items[0]!.state).toBe("skipped");
    expect(statuses[0]!.done).toBe(0);
    expect(statuses[0]!.missing).toEqual([]);
    expect(planCatchup(statuses)).toEqual([]);
    expect(renderStatus("2026-10-15", statuses)).not.toContain("必做欠账");
  });

  it("uses the same lawful not-open skip decision for status, report and catchup", () => {
    const r = run("daily-gift", "skipped");
    Object.assign(r.outcomes[0]!, { skipReason: "not-open", goalSatisfied: null, evidenceTimestamp: t1, evidenceReference: "game:calendar" });
    const statuses = mergeStatus({ plans: [plan("daily-gift")], lanes, requests: [], runs: [r] });
    expect(statuses[0]!.items[0]!.state).toBe("skipped");
    expect(statuses[0]!.missing).toEqual([]);
    expect(planCatchup(statuses)).toEqual([]);
    expect(renderReport("2026-10-15", [r])).toContain("必做欠账 0 项");
  });

  it("does not turn an unknown App step into an automatically retryable failure", () => {
    const statuses = mergeStatus({ plans: [plan("mail")], lanes, requests: [{ requestId: "uncertain", laneId: "lane-a", finishedAt: t2, games: { onmyoji: { steps: [{ stepId: "mail", status: "unknown", text: "提交结果未知", at: t2 }] } } }], runs: [] });
    expect(statuses[0]!.items[0]!.state).toBe("unknown");
    expect(planCatchup(statuses)).toEqual([]);
    expect(renderDailyReport({ day: "2026-10-15", statuses, runs: [] })).toContain("不自动补跑");
  });

  it("keeps absent steps under an unknown or unreadable App request out of catchup", () => {
    for (const request of [
      { requestId: "uncertain", status: "unknown", eventsRead: true },
      { requestId: "unreadable", status: "failed", eventsRead: false },
    ]) {
      const statuses = mergeStatus({ plans: [plan("daily-gift")], lanes,
        requests: [{ ...request, laneId: "lane-a", finishedAt: t2, games: {} }], runs: [] });
      expect(statuses[0]!.items[0]!.state).toBe("unknown");
      expect(planCatchup(statuses)).toEqual([]);
    }
  });

  it("blocks automatic catchup when any evidence source could not be read", () => {
    const statuses = mergeStatus({ plans: [plan("daily-gift")], lanes, requests: [], runs: [], evidenceReadError: "历史JSON无法读取" });
    expect(statuses[0]!.items[0]!.state).toBe("unknown");
    expect(planCatchup(statuses)).toEqual([]);
    expect(renderStatus("2026-10-15", statuses)).toContain("历史JSON无法读取");
  });

  it("does not catch up failed rows from incomplete events or an active request", () => {
    for (const context of [{ status: "failed", eventsRead: false }, { status: "running", eventsRead: true }]) {
      const statuses = mergeStatus({ plans: [plan("mail")], lanes,
        requests: [{ requestId: "busy", laneId: "lane-a", ...context, finishedAt: t2, games: { onmyoji: { steps: [{ stepId: "mail", status: "failed", at: t2 }] } } }], runs: [] });
      expect(statuses[0]!.items[0]!.state).toBe("unknown");
      expect(planCatchup(statuses)).toEqual([]);
    }
  });

  it("keeps the other game on an uncertain device out of automatic catchup", () => {
    const both = [{ ...lanes[0]!, enabled: { onmyoji: true, arknights: true } }];
    const ark = { ...plan("mail"), game: "arknights" as const };
    const statuses = mergeStatus({ plans: [ark], lanes: both,
      requests: [{ requestId: "other-game-running", laneId: "lane-a", status: "running", startedAt: t2, games: { onmyoji: { steps: [{ stepId: "login", status: "running", at: t2 }] } } }], runs: [] });
    expect(statuses[0]!.items[0]!.state).toBe("unknown");
    expect(planCatchup(statuses)).toEqual([]);
  });

  it("keeps the original observation time when a partial later run retains an earlier success", () => {
    const previous = run("mail", "succeeded", t1);
    const later = run("login", "succeeded", t3);
    const merged = mergeRunOutcomes(previous, later);
    expect(merged.outcomes.find(x => x.skill === "mail")!.finishedAt).toBe(t1);
    const statuses = mergeStatus({ plans: [plan("mail")], lanes, requests: [{ requestId: "newer-mail", laneId: "lane-a", finishedAt: t2, games: { onmyoji: { steps: [{ stepId: "mail", status: "failed", text: "后续真实失败", at: t2 }] } } }], runs: [merged] });
    expect(statuses[0]!.items[0]!.source).toBe("app");
    expect(statuses[0]!.items[0]!.state).toBe("failed");
    expect(previous.outcomes[0]!.finishedAt).toBeUndefined();
  });

  it("does not let an unresolved later request turn an earlier success into a review item", () => {
    // 2026-10-15 的真实回归：早上跑完的 6/6，被 20:00 次槽那次「被打断、结果未确认」的请求
    // 改写成「待核对」，状态一度显示 1/6，差一点让监督去重跑一个已经完成的日常。
    // 未确认只是"没读到"，不能覆盖明确的成功；同级的失败仍然按时间覆盖（上一条用例）。
    const statuses = mergeStatus({
      plans: [plan("mail")],
      lanes,
      requests: [
        {
          requestId: "earlier-success",
          laneId: "lane-a",
          finishedAt: t1,
          games: {
            onmyoji: { steps: [{ stepId: "mail", status: "succeeded", text: "邮件附件已领取", at: t1 }] },
          },
        },
        {
          requestId: "later-unresolved",
          laneId: "lane-a",
          startedAt: t3,
          status: "unknown",
          games: { onmyoji: { steps: [] } },
        },
      ],
      runs: [],
    });
    expect(statuses[0]!.items[0]!.state).toBe("succeeded");
    expect(statuses[0]!.items[0]!.source).toBe("app");
    expect(planCatchup(statuses)).toEqual([]);
  });

  it("stops treating a disposed request as unresolved", () => {
    // 2026-10-16：处置过的记录必须不再是"未确认"，否则监督层会天天被它挡着，
    // 既不敢补跑、也判不出今天做完了没有。
    const statuses = mergeStatus({
      plans: [plan("mail")],
      lanes,
      requests: [
        {
          requestId: "disposed",
          laneId: "lane-a",
          status: "unknown",
          startedAt: t1,
          resolution: { action: "abandoned", at: t2 },
          games: { onmyoji: { steps: [] } },
        },
      ],
      runs: [],
    });
    expect(statuses[0]!.items[0]!.state).toBe("pending");
    expect(planCatchup(statuses).length).toBe(1);
  });

  it("does not let an old coerced success outrank the actual unknown skill result", () => {
    const previous = run("daily-gift", "succeeded", t1);
    previous.outcomes[0]!.summary = giftUnknown;
    const later = run("daily-gift", "skipped", t2);
    Object.assign(later.outcomes[0]!, { skipReason: "unavailable", goalSatisfied: null, evidenceTimestamp: t2, evidenceReference: "gift:no-free-entry", summary: giftUnknown });
    const merged = mergeRunOutcomes(previous, later);
    expect(merged.outcomes[0]!.status).toBe("skipped");
    expect(merged.outcomes[0]!.evidenceReference).toBe("gift:no-free-entry");
    const statuses = mergeStatus({ plans: [plan("daily-gift")], lanes, requests: [], runs: [merged] });
    expect(statuses[0]!.items[0]!.state).toBe("unknown");
    expect(planCatchup(statuses)).toEqual([]);
  });
});
