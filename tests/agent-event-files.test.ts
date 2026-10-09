import { mkdtemp, readFile, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentEventJournal } from "../apps/desktop/main/agent-events";
import { agentEventFiles } from "../apps/desktop/main/agent-event-files";

describe("durable agent event files", () => {
  it("can restore a bounded detail archive larger than the legacy 16 MiB limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gp-agent-events-"));
    try {
      const summary = JSON.stringify({
        skillIds: Array.from(
          { length: 24 },
          (_, i) => `skill-${i}-${"a".repeat(100)}`,
        ),
      });
      const events = Array.from({ length: 2048 }, (_, i) => ({
        seq: i + 1,
        at: "2026-10-04T00:00:00.000Z",
        requestId: "request-a",
        kind: "tool-result" as const,
        status: "succeeded" as const,
        text: "记录".repeat(1000),
        details: { arguments: summary, result: summary, durationMs: 1 },
      }));
      const files = agentEventFiles(directory);
      await files.save({ version: 1, nextSeq: 2049, events });
      expect(
        (await readFile(join(directory, "current.json"))).byteLength,
      ).toBeGreaterThan(16 * 1024 * 1024);
      expect((await files.load())?.events).toHaveLength(2048);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("restarts across archive rotations and does not replay device actions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gp-agent-events-"));
    try {
      const journal = new AgentEventJournal({
        ...agentEventFiles(directory),
        maxEvents: 2,
      });
      for (let i = 0; i < 5; i++)
        await journal.append({
          requestId: "r",
          kind: "tool-result",
          status: "succeeded",
          text: `receipt ${i}`,
        });
      await journal.close();
      const next = new AgentEventJournal({
        ...agentEventFiles(directory),
        maxEvents: 2,
      });
      let calls = 0;
      next.subscribe(() => calls++);
      expect((await next.page({ limit: 3 })).events.map((e) => e.seq)).toEqual([
        1, 2, 3,
      ]);
      expect(
        (await next.page({ afterSeq: 3 })).events.map((e) => e.seq),
      ).toEqual([4, 5]);
      expect(calls).toBe(0);
      expect(
        (
          await next.append({
            requestId: "r",
            kind: "game-result",
            status: "failed",
            text: "game failed",
          })
        ).seq,
      ).toBe(6);
      expect(calls).toBe(1);
      expect(
        JSON.parse(await readFile(join(directory, "current.json"), "utf8"))
          .nextSeq,
      ).toBe(7);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("reports corrupted archives instead of certifying incomplete receipts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gp-agent-events-"));
    try {
      const journal = new AgentEventJournal({
        ...agentEventFiles(directory),
        maxEvents: 1,
      });
      for (let i = 0; i < 2; i++)
        await journal.append({
          requestId: "r",
          kind: "intent",
          status: "running",
          text: "intent",
        });
      await writeFile(
        join(directory, "archive-0000000000000001-0000000000000001.json"),
        "{}",
      );
      expect((await journal.page()).error).toBeTruthy();
      await expect(journal.assertReady()).rejects.toMatchObject({
        code: "AGENT_EVENT_STORE_UNAVAILABLE",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("reports missing global archives even when a filtered request has no matching receipts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gp-agent-events-"));
    try {
      const journal = new AgentEventJournal({
        ...agentEventFiles(directory),
        maxEvents: 1,
      });
      for (let i = 0; i < 3; i++)
        await journal.append({
          requestId: "other",
          kind: "intent",
          status: "running",
          text: "intent",
        });
      await journal.close();
      await unlink(
        join(directory, "archive-0000000000000002-0000000000000002.json"),
      );
      const restored = new AgentEventJournal({
        ...agentEventFiles(directory),
        maxEvents: 1,
      });
      const page = await restored.page({ requestId: "absent", afterSeq: 0 });
      expect(page.events).toEqual([]);
      expect(page.gap).toBe(true);
      expect(page.error).toBeTruthy();
      await expect(restored.assertReady()).rejects.toMatchObject({
        code: "AGENT_EVENT_STORE_UNAVAILABLE",
      });
      await restored.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("finds archived child game events by their parent planner request without replaying execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gp-agent-events-"));
    try {
      const journal = new AgentEventJournal({
        ...agentEventFiles(directory),
        maxEvents: 2,
      });
      await journal.append({
        requestId: "planner",
        kind: "intent",
        status: "running",
        text: "模型规划请求",
      });
      await journal.append({
        requestId: "batch:lane",
        parentRequestId: "planner",
        kind: "game-step",
        status: "running",
        text: "宿主游戏步骤",
      });
      await journal.append({
        requestId: "unrelated",
        kind: "intent",
        status: "running",
        text: "其他请求",
      });
      await journal.append({
        requestId: "batch:lane",
        parentRequestId: "planner",
        kind: "game-result",
        status: "failed",
        text: "宿主执行回执",
      });
      await journal.append({
        requestId: "unrelated",
        kind: "intent",
        status: "running",
        text: "其他请求",
      });
      await journal.close();
      const restored = new AgentEventJournal({
        ...agentEventFiles(directory),
        maxEvents: 2,
      });
      let published = 0;
      restored.subscribe(() => published++);
      const first = await restored.page({ requestId: "planner", limit: 2 });
      expect(first.events.map((event) => event.seq)).toEqual([1, 2]);
      expect(first.hasMore).toBe(true);
      expect(first.gap).toBeUndefined();
      expect(first.error).toBeUndefined();
      const second = await restored.page({
        requestId: "planner",
        afterSeq: first.cursor,
        limit: 2,
      });
      expect(second.events).toMatchObject([
        {
          seq: 4,
          requestId: "batch:lane",
          parentRequestId: "planner",
          kind: "game-result",
          status: "failed",
        },
      ]);
      expect(second.hasMore).toBe(false);
      expect(second.error).toBeUndefined();
      expect(second.gap).toBeUndefined();
      expect(published).toBe(0);
      await restored.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
