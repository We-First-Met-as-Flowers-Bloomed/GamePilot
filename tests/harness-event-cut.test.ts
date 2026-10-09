import { expect, it } from "vitest";
import { AgentEventJournal } from "../apps/desktop/main/agent-events";
import type { AgentEvent } from "../packages/protocol/agent-events";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("holds a stable replay cut when current events rotate while archive history is being read", async () => {
  const archived: AgentEvent[] = [];
  const reading = deferred(),
    release = deferred();
  const journal = new AgentEventJournal({
    maxEvents: 2,
    save: async () => {},
    archive: async (events) => {
      archived.push(...structuredClone(events));
    },
    verifyCoverage: async () => true,
    history: async ({ afterSeq, beforeSeq, limit }) => {
      const cut = archived
        .filter((event) => event.seq > afterSeq && event.seq < beforeSeq)
        .slice(0, limit);
      reading.resolve();
      await release.promise;
      return cut;
    },
  });
  const entry = {
    requestId: "request-a",
    kind: "game-step" as const,
    status: "succeeded" as const,
    text: "completed step",
  };
  for (let i = 0; i < 4; i++) await journal.append(entry);
  const replay = journal.page({
    afterSeq: 0,
    requestId: "request-a",
    limit: 128,
  });
  await reading.promise;
  await journal.append(entry); // Archives the prior current segment, including seq 3 and 4.
  release.resolve();
  const page = await replay;
  expect(page.error).toBeUndefined();
  expect(page.gap).toBeUndefined();
  expect(page.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
  expect(page.latestSeq).toBe(4);
  expect(page.cursor).toBe(4);
  expect(
    (
      await journal.page({ afterSeq: page.cursor, requestId: "request-a" })
    ).events.map((event) => event.seq),
  ).toEqual([5]);
});
