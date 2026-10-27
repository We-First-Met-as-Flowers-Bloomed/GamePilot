import { expect, it, vi } from "vitest";
import {
  ChatService,
  summarizeChatSession,
} from "../apps/desktop/main/agent-chat";
import type {
  ChatSession,
  ChatTurn,
  ChatView,
} from "../packages/protocol/agent-chat";
import type { PlannerViewState } from "../packages/protocol/agent-planner";

const at = "2026-10-04T04:00:00.000Z";
function session(n = 1, count = 3): ChatSession {
  return {
    id: `session-${n}`,
    title: `历史${n}`,
    createdAt: at,
    updatedAt: at,
    turns: Array.from({ length: count }, (_, i) => ({
      id: `turn-${n}-${i}`,
      prompt: i === 0 ? "不要使用理智药，只查原请求" : `查询${i}`,
      source: "recorded" as const,
      at,
      createdAt: at,
      planner: {
        revision: 1,
        status: "completed" as const,
        requestId: `model-${n}-${i}`,
        prompt: i === 0 ? "不要使用理智药，只查原请求" : `查询${i}`,
        source: "recorded" as const,
        at,
        result: {
          status: "answer" as const,
          modelText: "模型宣称全部成功，但这不是宿主事实",
          source: "recorded" as const,
          execution: "not-started" as const,
          canExecute: false as const,
          trace: [
            { callId: "result", tool: "get_run" as const, success: true },
          ],
          model: "test",
          codexVersion: "",
          elapsedMs: 1,
          records: [
            {
              requestId: `original-${n}`,
              requestSource: "daily" as const,
              recordedStatus: "unknown",
              recordedConclusion: "unknown",
              complete: false,
              inGameCompletion: "not-verified" as const,
              tasks: [],
              notes: [],
              warnings: ["证据不足"],
            },
          ],
        },
      },
    })),
  };
}
function setup(stored = session()) {
  let state: PlannerViewState = { revision: 0, status: "idle" };
  const planner = {
    snapshot: () => structuredClone(state),
    verifiedSnapshot: async () => structuredClone(state),
    startConversation: vi.fn(),
    cancel: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  };
  const initial: ChatView = {
    revision: 2,
    selectedSessionId: stored.id,
    sessions: [stored],
  };
  const save = vi.fn(async (_view: ChatView) => {});
  const archives = new Map<string, any>();
  const archive = vi.fn(async (record: any) => {
    archives.set(record.id, structuredClone(record));
  });
  const list = vi.fn(async () =>
    [...archives.values()].map(({ session: s, ...entry }) => ({
      ...entry,
      sessionId: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      turnCount: s.turns.length,
      sources: [...new Set(s.turns.map((t: any) => t.source))],
    })),
  );
  const loadArchive = vi.fn(async (id: string) =>
    structuredClone(archives.get(id)),
  );
  const service: any = new ChatService({
    planner,
    save,
    load: async () => structuredClone(initial),
    archive,
    list,
    loadArchive,
  } as any);
  return {
    service,
    planner,
    initial,
    save,
    archives,
    archive,
    list,
    loadArchive,
    setState: (value: PlannerViewState) => {
      state = value;
    },
  };
}

it("archives every original turn and source before removing the active session, without replay", async () => {
  const s = setup();
  await s.service.snapshot();
  const view = await s.service.archive({ sessionId: "session-1" });
  expect(s.archive).toHaveBeenCalledOnce();
  const archived = [...s.archives.values()][0];
  expect(archived).toMatchObject({
    version: 2,
    id: expect.stringMatching(/^archive-[a-f0-9]{64}$/),
    originalSessionId: "session-1",
    session: { turns: s.initial.sessions[0].turns },
  });
  expect(
    view.sessions.some((item: ChatSession) => item.id === "session-1"),
  ).toBe(false);
  expect(view.sessions).toHaveLength(1);
  expect(s.planner.startConversation).not.toHaveBeenCalled();
  const history = await s.service.loadArchived({
    archiveId: archived.id,
    limit: 2,
  });
  expect(history).toMatchObject({
    scope: "historical-only",
    canExecute: false,
    turns: s.initial.sessions[0].turns.slice(0, 2),
  });
  expect(history.nextCursor).toBeTypeOf("string");
  expect(
    (
      await s.service.loadArchived({
        archiveId: archived.id,
        cursor: history.nextCursor,
        limit: 2,
      })
    ).turns,
  ).toEqual(s.initial.sessions[0].turns.slice(2));
});

it("preserves the live session when archive storage fails and permits a later manual retry", async () => {
  const s = setup();
  await s.service.snapshot();
  s.archive.mockRejectedValueOnce(Error("disk full"));
  await expect(
    s.service.archive({ sessionId: "session-1" }),
  ).rejects.toMatchObject({ code: "CHAT_ARCHIVE_UNAVAILABLE" });
  expect((await s.service.snapshot()).sessions[0].turns).toEqual(
    s.initial.sessions[0].turns,
  );
  expect(s.save).not.toHaveBeenCalled();
  expect(s.archives.size).toBe(0);
  await s.service.archive({ sessionId: "session-1" });
  expect(s.archives.size).toBe(1);
});

it("retains both recoverable copies and stops mutation if the active store fails after archive commit", async () => {
  const s = setup();
  await s.service.snapshot();
  s.save.mockRejectedValueOnce(Error("disk failure"));
  await expect(
    s.service.archive({ sessionId: "session-1" }),
  ).rejects.toMatchObject({ code: "CHAT_STORE_UNAVAILABLE" });
  expect(s.archives.size).toBe(1);
  expect((await s.service.snapshot()).sessions[0].id).toBe("session-1");
  await expect(s.service.newChat()).rejects.toMatchObject({
    code: "CHAT_STORE_UNAVAILABLE",
  });
});

it("rejects archiving a model-active or host-active session", async () => {
  const s = setup();
  await s.service.snapshot();
  s.setState({
    ...s.initial.sessions[0].turns[0].planner,
    revision: 3,
    status: "running",
    result: undefined,
  });
  await expect(
    s.service.archive({ sessionId: "session-1" }),
  ).rejects.toMatchObject({ code: "CHAT_SESSION_ACTIVE" });
  expect(s.archive).not.toHaveBeenCalled();
  const service: any = new ChatService({
    planner: setup().planner,
    save: async () => {},
    load: async () => s.initial,
    archive: s.archive,
    list: s.list,
    loadArchive: s.loadArchive,
    canArchive: () => false,
  } as any);
  await expect(
    service.archive({ sessionId: "session-1" }),
  ).rejects.toMatchObject({ code: "CHAT_SESSION_ACTIVE" });
});

it("paginates an immutable archive view without duplicate entries after newer archives arrive", async () => {
  const s = setup(session(99));
  for (let n = 1; n <= 5; n++)
    s.archives.set(`session-${n}`, {
      id: `session-${n}`,
      version: 1,
      archivedAt: `2026-10-04T04:00:0${n}.000Z`,
      session: session(n),
    });
  const first = await s.service.listArchived({ limit: 2 });
  expect(first.entries.map((entry: any) => entry.id)).toEqual([
    "session-5",
    "session-4",
  ]);
  s.archives.set("session-6", {
    id: "session-6",
    version: 1,
    archivedAt: "2026-10-04T04:00:06.000Z",
    session: session(6),
  });
  const second = await s.service.listArchived({
    limit: 2,
    cursor: first.nextCursor,
  });
  const third = await s.service.listArchived({
    limit: 2,
    cursor: second.nextCursor,
  });
  expect(
    [...second.entries, ...third.entries].map((entry: any) => entry.id),
  ).toEqual(["session-3", "session-2", "session-1"]);
  expect(third.nextCursor).toBeUndefined();
  expect(s.planner.startConversation).not.toHaveBeenCalled();
});

it("rejects forged IDs, cursors and corrupt archive payloads before exposing history", async () => {
  const s = setup();
  await expect(
    s.service.loadArchived({ archiveId: "../../agent-chat.json" }),
  ).rejects.toThrow();
  expect(s.loadArchive).not.toHaveBeenCalled();
  await expect(
    s.service.listArchived({ cursor: "bad", limit: 2 }),
  ).rejects.toThrow();
  await s.service.archive({ sessionId: "session-1" });
  const archive = [...s.archives.values()][0];
  archive.session.turns[0].planner.result.modelText = { bad: true };
  await expect(
    s.service.loadArchived({ archiveId: archive.id }),
  ).rejects.toMatchObject({ code: "CHAT_ARCHIVE_UNAVAILABLE" });
});

it("pushes only successfully committed snapshots and maps model request ownership", async () => {
  const s = setup();
  await s.service.snapshot();
  const listener = vi.fn();
  const unsubscribe = s.service.subscribe(listener);
  expect(s.service.requestTarget("model-1-0")).toEqual({
    sessionId: "session-1",
    turnId: "turn-1-0",
  });
  expect(s.service.requestTarget("missing")).toBeUndefined();
  let release!: () => void;
  s.save.mockImplementationOnce(
    async () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const next = s.service.newChat();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(listener).not.toHaveBeenCalled();
  release();
  await next;
  expect(listener).toHaveBeenCalledOnce();
  listener.mock.calls[0][0].sessions.length = 0;
  expect((await s.service.snapshot()).sessions.length).toBe(2);
  unsubscribe();
  await s.service.select("session-1");
  expect(listener).toHaveBeenCalledOnce();
});

it("summarizes user objectives and host records while leaving model assertions outside facts", async () => {
  const s = setup();
  const view = await s.service.snapshot();
  const summary = view.sessions[0].summary;
  expect(summary).toMatchObject({
    version: 1,
    scope: "historical-tools-only",
    currentState: "unknown",
    canAuthorizeExecution: false,
  });
  expect(summary.objectives).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        turnId: "turn-1-0",
        source: "recorded",
        text: "不要使用理智药，只查原请求",
      }),
    ]),
  );
  expect(summary.facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        requestId: "original-1",
        recordedConclusion: "unknown",
        inGameCompletion: "not-verified",
      }),
    ]),
  );
  expect(JSON.stringify(summary.facts)).not.toContain("全部成功");
});

it("invalidates a turn cursor when archived content changes and rejects unavailable history explicitly", async () => {
  const s = setup(session(99));
  s.archives.set("session-1", {
    version: 1,
    id: "session-1",
    archivedAt: at,
    session: session(),
  });
  const first = await s.service.loadArchived({
    archiveId: "session-1",
    limit: 1,
  });
  s.archives.get("session-1").session.title = "归档已变化";
  await expect(
    s.service.loadArchived({
      archiveId: "session-1",
      cursor: first.nextCursor,
    }),
  ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  await expect(
    s.service.loadArchived({ archiveId: "not-found" }),
  ).rejects.toMatchObject({ code: "CHAT_ARCHIVE_NOT_FOUND" });
  s.list.mockRejectedValueOnce(Error("read failure"));
  await expect(s.service.listArchived()).rejects.toMatchObject({
    code: "CHAT_ARCHIVE_UNAVAILABLE",
  });
  s.loadArchive.mockRejectedValueOnce(Error("read failure"));
  await expect(
    s.service.loadArchived({ archiveId: "session-1" }),
  ).rejects.toMatchObject({ code: "CHAT_ARCHIVE_UNAVAILABLE" });
});

it("frees session capacity only after an explicit archive and never truncates old turns", async () => {
  const s = setup();
  const all = Array.from({ length: 32 }, (_, i) => session(i + 1, 64));
  const service: any = new ChatService({
    planner: s.planner,
    save: s.save,
    load: async () => ({
      revision: 1,
      selectedSessionId: all[0].id,
      sessions: all,
    }),
    archive: s.archive,
    list: s.list,
    loadArchive: s.loadArchive,
  } as any);
  await expect(service.newChat()).rejects.toMatchObject({
    code: "CHAT_BUDGET",
  });
  await service.archive({ sessionId: "session-1" });
  const created = await service.newChat();
  expect(created.sessions).toHaveLength(32);
  expect([...s.archives.values()][0].session.turns).toHaveLength(64);
  expect(
    created.sessions.find((item: ChatSession) => item.id === "session-2").turns,
  ).toHaveLength(64);
});

it("counts a new turn summary at the 8 MiB boundary without quarantining an archivable legacy session", async () => {
  const maximum = 8 * 1024 * 1024 - 128;
  const bytes = (value: unknown) =>
    Buffer.byteLength(JSON.stringify(value), "utf8");
  const stored = session(1, 1); // A valid legacy record has no persisted summary.
  const notes = stored.turns[0].planner.result!.records![0].notes;
  const prompt = "p".repeat(1000);
  const nextTurn: ChatTurn = {
    id: "00000000-0000-0000-0000-000000000000",
    prompt,
    source: "recorded",
    at,
    createdAt: at,
    planner: { revision: 0, status: "idle", prompt, source: "recorded", at },
  };
  const projected = (): ChatView => {
    const current = structuredClone(stored);
    current.summary = summarizeChatSession(current);
    return { revision: 2, selectedSessionId: current.id, sessions: [current] };
  };
  const baseline = projected();
  const withTurn = structuredClone(baseline);
  withTurn.sessions[0].turns.push(nextTurn);
  const addedTurnBytes = bytes(withTurn) - bytes(baseline);
  let padding = maximum - bytes(baseline) - addedTurnBytes - 500;
  // Every note remains within the existing 4000-character field limit.
  while (padding >= (notes.length ? 3 : 2)) {
    const overhead = notes.length ? 3 : 2;
    const count = Math.min(4000, padding - overhead);
    notes.push("x".repeat(count));
    padding -= count + overhead;
  }
  const withoutNewSummary = projected();
  withoutNewSummary.sessions[0].turns.push(nextTurn);
  expect(bytes(withoutNewSummary)).toBeLessThanOrEqual(maximum);
  const withNewSummary = structuredClone(withoutNewSummary);
  withNewSummary.sessions[0].summary = summarizeChatSession(
    withNewSummary.sessions[0],
  );
  expect(bytes(withNewSummary)).toBeGreaterThan(maximum);

  const s = setup(stored);
  const before = await s.service.snapshot();
  expect(before.error).toBeUndefined();
  expect(maximum - bytes(before)).toBeLessThan(4000);
  await expect(
    s.service.send({ sessionId: stored.id, prompt, source: "recorded", at }),
  ).rejects.toMatchObject({ code: "CHAT_BUDGET" });
  expect(s.planner.startConversation).not.toHaveBeenCalled();
  expect(s.save).not.toHaveBeenCalled();
  expect(await s.service.snapshot()).toEqual(before);

  const archived = await s.service.archive({ sessionId: stored.id });
  expect(archived.error).toBeUndefined();
  expect(s.archive).toHaveBeenCalledOnce();
  expect([...s.archives.values()][0].session.turns).toEqual(
    before.sessions[0].turns,
  );
  expect(archived.sessions).toHaveLength(1);
  expect(archived.sessions[0].turns).toEqual([]);
});

it("rejects a forged summary and corrupt new draft effect metadata while keeping valid legacy drafts", async () => {
  const stored = session();
  stored.turns[0].planner.result!.draft = {
    status: "valid",
    canExecute: false,
    catalogRevision: "old",
    environmentRevision: "old",
    at,
    lanes: [
      {
        laneId: "lane-a",
        instance: 0,
        games: [
          {
            plan: { gameId: "arknights", mode: "live", skillIds: ["login"] },
            parameters: {},
            excluded: [],
            notes: [],
          },
        ],
      },
    ],
    reasons: [],
    preconditions: [],
  };
  const valid = setup(stored);
  expect((await valid.service.snapshot()).error).toBeUndefined();
  const corrupt = structuredClone(stored);
  corrupt.turns[0].planner.result!.draft!.lanes[0].games[0].effects = [
    {
      id: "login",
      label: "登录",
      boundTo: "login",
      kind: "navigation",
      enabled: { canExecute: true },
    },
  ] as any;
  expect((await setup(corrupt).service.snapshot()).error).toContain("会话");
  const summaryView = await valid.service.snapshot();
  summaryView.sessions[0].summary.canAuthorizeExecution = true;
  const forged: any = new ChatService({
    planner: setup().planner,
    save: async () => {},
    load: async () => summaryView,
  });
  expect((await forged.snapshot()).error).toContain("会话");
});

it("rejects a malformed Copilot review in archived history without exposing a card or changing the original archive", async () => {
  const s = setup();
  await s.service.snapshot();
  const stored = session();
  stored.turns[0].planner.result!.copilot = {} as never;
  const record = { version: 1, id: stored.id, archivedAt: at, session: stored };
  s.archives.set(record.id, record);
  await expect(
    s.service.loadArchived({ archiveId: record.id }),
  ).rejects.toMatchObject({ code: "CHAT_ARCHIVE_UNAVAILABLE" });
  expect(
    s.archives.get(record.id).session.turns[0].planner.result.copilot,
  ).toEqual({});
  expect(s.archive).not.toHaveBeenCalled();
  expect(s.save).not.toHaveBeenCalled();
});
