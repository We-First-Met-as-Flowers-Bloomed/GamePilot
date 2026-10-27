import { expect, it } from "vitest";
import {
  createChatPerformanceFixture,
  performanceEventPage,
} from "../scripts/chat-ui-smoke/performance-fixture";
import {
  groupTraceEvents,
  toolKinds,
} from "../apps/desktop/renderer/trace-presentation";

it("builds 64 isolated turns with exactly 12 paired tools and 40 lifecycle events each", () => {
  const fixture = createChatPerformanceFixture("2026-10-12T00:00:00.000Z");
  expect(fixture.session.turns).toHaveLength(64);
  const events = [...fixture.events.values()].flat();
  expect(events).toHaveLength(4096);
  expect(new Set(events.map((event) => event.seq)).size).toBe(4096);
  for (const turn of fixture.session.turns) {
    const journal = fixture.events.get(turn.planner.requestId!)!;
    expect(journal).toHaveLength(64);
    expect(
      journal.every(
        (event) =>
          event.requestId === turn.planner.requestId &&
          event.turnId === turn.id &&
          event.sessionId === fixture.session.id,
      ),
    ).toBe(true);
    const groups = groupTraceEvents(journal);
    expect(groups).toHaveLength(52);
    expect(
      groups.filter((group) => toolKinds.includes(group.events[0].kind)),
    ).toHaveLength(12);
    expect(
      journal
        .filter((event) => event.kind === "tool-result")
        .map((event) => event.status),
    ).toContain("unknown");
    expect(turn.planner.result?.canExecute).toBe(false);
    expect(turn.planner.result?.execution).toBe("not-started");
  }
});

it("replays every request in bounded advancing pages without borrowing another turn's events", () => {
  const fixture = createChatPerformanceFixture("2026-10-12T00:00:00.000Z");
  const seen = new Set<number>();
  for (const requestId of fixture.events.keys()) {
    let afterSeq = 0,
      pages = 0;
    for (;;) {
      const page = performanceEventPage(fixture.events, {
        requestId,
        afterSeq,
        limit: 128,
      });
      pages++;
      expect(page.events.length).toBeLessThanOrEqual(32);
      expect(
        page.events.every(
          (event) => event.requestId === requestId && event.seq > afterSeq,
        ),
      ).toBe(true);
      for (const event of page.events) seen.add(event.seq);
      if (!page.hasMore) break;
      expect(page.cursor).toBeGreaterThan(afterSeq);
      afterSeq = page.cursor;
    }
    expect(pages).toBe(2);
  }
  expect(seen.size).toBe(4096);
  expect(
    performanceEventPage(fixture.events, { requestId: "foreign", afterSeq: 10 })
      .events,
  ).toEqual([]);
});
