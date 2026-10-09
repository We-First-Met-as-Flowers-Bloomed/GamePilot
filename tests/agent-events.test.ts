import { describe, expect, it } from "vitest";
import { AgentEventJournal } from "../apps/desktop/main/agent-events";
import type {
  AgentEvent,
  AgentEventStore,
} from "../packages/protocol/agent-events";

function memory(maxEvents = 3) {
  let stored: AgentEventStore | undefined;
  const archived: AgentEvent[] = [];
  const journal = new AgentEventJournal({
    maxEvents,
    load: async () => stored,
    save: async (v) => {
      stored = structuredClone(v);
    },
    archive: async (events) => {
      archived.push(...structuredClone(events));
    },
    history: async ({ afterSeq, beforeSeq, requestId, limit }) =>
      archived
        .filter(
          (e) =>
            e.seq > afterSeq &&
            e.seq < beforeSeq &&
            (!requestId || e.requestId === requestId),
        )
        .slice(0, limit),
  });
  return { journal, archived, getStored: () => stored };
}
const entry = (requestId = "request-a") => ({
  requestId,
  kind: "tool-started" as const,
  status: "running" as const,
  tool: "get_run",
  callId: "call-a",
  text: "正在读取任务记录",
});
describe("durable Agent event journal", () => {
  it("serializes concurrent events and notifies only committed records", async () => {
    const { journal, getStored } = memory();
    const seen: number[] = [];
    const dispose = journal.subscribe((e) => {
      expect(getStored()?.nextSeq).toBeGreaterThan(e.seq);
      seen.push(e.seq);
    });
    await Promise.all([
      journal.append(entry()),
      journal.append({ ...entry(), kind: "tool-result", status: "succeeded" }),
    ]);
    expect(seen).toEqual([1, 2]);
    dispose();
    await journal.append(entry("request-b"));
    expect(seen).toEqual([1, 2]);
    expect(
      (await journal.page({ afterSeq: 0 })).events.map((e) => e.seq),
    ).toEqual([1, 2, 3]);
  });
  it("archives without losing request history and resumes stable sequence numbers", async () => {
    const m = memory(2);
    await m.journal.append(entry());
    await m.journal.append(entry("request-b"));
    await m.journal.append(entry());
    expect(m.archived.map((e) => e.seq)).toEqual([1, 2]);
    const first = await m.journal.page({
      requestId: "request-a",
      afterSeq: 0,
      limit: 1,
    });
    expect(first.events.map((e) => e.seq)).toEqual([1]);
    expect(first.hasMore).toBe(true);
    const second = await m.journal.page({
      requestId: "request-a",
      afterSeq: first.cursor,
    });
    expect(second.events.map((e) => e.seq)).toEqual([3]);
    const restored = new AgentEventJournal({
      load: async () => m.getStored(),
      save: async () => {},
    });
    expect((await restored.append(entry()))?.seq).toBe(4);
  });
  it("preserves original storage and fails closed after a persistence failure", async () => {
    let writes = 0;
    const journal = new AgentEventJournal({
      save: async () => {
        writes++;
        throw new Error("disk");
      },
    });
    const seen: AgentEvent[] = [];
    journal.subscribe((e) => seen.push(e));
    await expect(journal.append(entry())).rejects.toThrow();
    await expect(journal.append(entry())).rejects.toThrow();
    expect(writes).toBe(1);
    expect(seen).toEqual([]);
    expect((await journal.page({})).error).toBeTruthy();
  });
  it("rejects corrupt sequence, malformed input and oversized payload without notification", async () => {
    const corrupt = new AgentEventJournal({
      load: async () =>
        ({
          version: 1,
          nextSeq: 3,
          events: [{ ...entry(), seq: 2, at: "bad" }],
        }) as AgentEventStore,
      save: async () => {},
    });
    await expect(corrupt.append(entry())).rejects.toThrow();
    const { journal } = memory();
    await expect(
      journal.append({ ...entry(), text: "x".repeat(5000) }),
    ).rejects.toThrow();
    await expect(journal.page({ afterSeq: -1 })).rejects.toThrow();
    expect((await journal.page({})).events).toEqual([]);
  });
  it("persists bounded public call details and removes credentials before saving", async () => {
    const { journal, getStored } = memory();
    const event = await journal.append({
      ...entry(),
      details: {
        arguments: JSON.stringify({
          requestId: "request-a",
          apiKey: "PRIVATE_KEY",
          token: "PRIVATE_TOKEN",
          password: "PRIVATE_PASSWORD",
          uid: "PRIVATE_UID",
          path: "D:/private-profile",
          notes: "free text containing PRIVATE_NOTE",
        }),
        result: JSON.stringify({
          status: "succeeded",
          nested: { secret: "PRIVATE_NESTED" },
          credential: "PRIVATE_CREDENTIAL",
        }),
        durationMs: 12.5,
      },
    } as never);
    expect(event.details).toEqual({
      arguments: '{"requestId":"request-a"}',
      result: '{"status":"succeeded"}',
      durationMs: 12.5,
    });
    expect(JSON.stringify(getStored())).not.toMatch(/PRIVATE_|private-profile/);
  });
  it("keeps legacy events without inventing details and restores safe details", async () => {
    const m = memory();
    const old = await m.journal.append(entry());
    expect(old).not.toHaveProperty("details");
    await m.journal.append({
      ...entry(),
      details: { result: '{"status":"failed"}', durationMs: 0 },
    } as never);
    const restored = new AgentEventJournal({
      load: async () => m.getStored(),
      save: async () => {},
    });
    const page = await restored.page();
    expect(page.events[0]).not.toHaveProperty("details");
    expect(page.events[1].details).toEqual({
      result: '{"status":"failed"}',
      durationMs: 0,
    });
  });
  it("rejects malformed, oversized and nonfinite details before any storage write", async () => {
    const { journal, getStored } = memory();
    for (const details of [
      { arguments: "not JSON" },
      { result: JSON.stringify({ status: "x".repeat(4000) }) },
      { durationMs: -1 },
      { durationMs: Infinity },
      { durationMs: NaN },
      { result: 1 },
      { providerMessage: "private" },
    ])
      await expect(
        journal.append({ ...entry(), details } as never),
      ).rejects.toThrow();
    expect(getStored()).toBeUndefined();
    expect((await journal.page()).events).toEqual([]);
  });
  it("sanitizes restored and archived public details without altering legacy events", async () => {
    const unsafe = {
      ...entry(),
      seq: 1,
      at: "2026-10-04T00:00:00.000Z",
      details: { result: '{"status":"failed","apiKey":"PRIVATE_KEY"}' },
    };
    const journal = new AgentEventJournal({
      load: async () => ({
        version: 1,
        nextSeq: 3,
        events: [{ ...entry(), seq: 2, at: unsafe.at }],
      }),
      history: async () => [unsafe],
      save: async () => {},
    });
    const page = await journal.page();
    expect(page.events[0].details).toEqual({ result: '{"status":"failed"}' });
    expect(page.events[1]).not.toHaveProperty("details");
    expect(JSON.stringify(page)).not.toContain("PRIVATE_KEY");
  });
  it("captures call details before a caller can mutate a queued event", async () => {
    const { journal } = memory();
    const input = {
      ...entry(),
      details: { result: '{"status":"succeeded"}', durationMs: 12.5 },
    };
    const pending = journal.append(input);
    input.details.result = '{"status":"failed","token":"PRIVATE_TOKEN"}';
    input.details.durationMs = -1;
    await expect(pending).resolves.toMatchObject({
      details: { result: '{"status":"succeeded"}', durationMs: 12.5 },
    });
  });
});
