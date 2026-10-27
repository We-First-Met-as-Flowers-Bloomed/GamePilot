import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  ChatService,
  summarizeChatSession,
} from "../apps/desktop/main/agent-chat";
import { canonical } from "../packages/acceptance/files";
import type {
  ChatArchivedSession,
  ChatSession,
  ChatView,
} from "../packages/protocol/agent-chat";
import type { PlannerViewState } from "../packages/protocol/agent-planner";

const at = "2026-10-13T04:00:00.000Z";
function session(n = 1, count = 3): ChatSession {
  return {
    id: `session-${n}`,
    title: `历史${n}`,
    createdAt: at,
    updatedAt: at,
    turns: Array.from({ length: count }, (_, i) => ({
      id: `turn-${n}-${i}`,
      prompt: `查询${i}`,
      source: "recorded",
      at,
      createdAt: at,
      planner: {
        revision: 1,
        status: "completed",
        requestId: `model-${n}-${i}`,
        prompt: `查询${i}`,
        source: "recorded",
        at,
        result: {
          status: "answer",
          source: "recorded",
          modelText: "仅历史答复",
          execution: "not-started",
          canExecute: false,
          trace: [],
          model: "test",
          codexVersion: "",
          elapsedMs: 1,
        },
      },
    })),
  };
}
const legacy = (s = session()): ChatArchivedSession => ({
  version: 1,
  id: s.id,
  archivedAt: at,
  session: s,
});
function setup(sessions = [session(2)], canArchive = vi.fn(() => true)) {
  let state: PlannerViewState = { revision: 0, status: "idle" };
  let observer: ((state: PlannerViewState) => void) | undefined;
  let durable: ChatView = {
    revision: 2,
    sessions: structuredClone(sessions),
    selectedSessionId: sessions[0]?.id,
  };
  const planner = {
    snapshot: () => structuredClone(state),
    verifiedSnapshot: async () => structuredClone(state),
    startConversation: vi.fn(),
    cancel: vi.fn(),
    subscribe: vi.fn((listener: (state: PlannerViewState) => void) => {
      observer = listener;
      return () => {
        observer = undefined;
      };
    }),
  };
  const archives = new Map<string, ChatArchivedSession>();
  const archive = vi.fn(async (r: ChatArchivedSession) => {
    const previous = archives.get(r.id);
    if (previous && canonical(previous.session) !== canonical(r.session))
      throw Error("immutable");
    if (!previous) archives.set(r.id, structuredClone(r));
  });
  const loadArchive = vi.fn(async (id: string) =>
    structuredClone(archives.get(id)),
  );
  const list = vi.fn(async () =>
    [...archives.values()].map((r) => ({
      version: r.version,
      id: r.id,
      sessionId: r.session.id,
      title: r.session.title,
      createdAt: r.session.createdAt,
      updatedAt: r.session.updatedAt,
      archivedAt: r.archivedAt,
      turnCount: r.session.turns.length,
      sources: [...new Set(r.session.turns.map((t) => t.source))],
    })),
  );
  const save = vi.fn(async (v: ChatView) => {
    durable = structuredClone(v);
  });
  const service = new ChatService({
    planner,
    save,
    archive,
    loadArchive,
    list,
    canArchive,
    load: async () => structuredClone(durable),
  });
  return {
    service,
    save,
    archives,
    archive,
    loadArchive,
    list,
    planner,
    canArchive,
    durable: () => structuredClone(durable),
    setState: (s: PlannerViewState) => {
      state = s;
    },
    emitState: (s: PlannerViewState) => {
      state = s;
      observer?.(structuredClone(s));
    },
  };
}

it("restores a full legacy archive with original ownership IDs and selects it without replay", async () => {
  const s = setup();
  const record = legacy(session(1, 64));
  s.archives.set(record.id, structuredClone(record));
  const page = await s.service.loadArchived({ archiveId: record.id, limit: 2 });
  expect(page.turns).toHaveLength(2);
  expect(page.nextCursor).toBeTypeOf("string");
  const restored = await s.service.restoreArchived({ archiveId: record.id });
  expect(restored.selectedSessionId).toBe(record.session.id);
  expect(
    restored.sessions.find((item) => item.id === record.session.id),
  ).toEqual({
    ...record.session,
    summary: summarizeChatSession(record.session),
  });
  expect(s.service.requestTarget("model-1-63")).toEqual({
    sessionId: "session-1",
    turnId: "turn-1-63",
  });
  expect(restored.sessions.at(-1)?.summary?.canAuthorizeExecution).toBe(false);
  expect(restored.sessions.at(-1)?.turns[0].planner.result?.canExecute).toBe(
    false,
  );
  expect(s.archives.get(record.id)).toEqual(record);
  expect(s.planner.startConversation).not.toHaveBeenCalled();
  expect(s.planner.cancel).not.toHaveBeenCalled();
  expect((await s.service.listArchived()).entries).toEqual([]);
  const writes = s.save.mock.calls.length;
  expect(await s.service.restoreArchived({ archiveId: record.id })).toEqual(
    restored,
  );
  expect(s.save).toHaveBeenCalledTimes(writes);
});

it("archives restored edits as a deterministic new revision without overwriting legacy history", async () => {
  const s = setup();
  const old = legacy();
  s.archives.set(old.id, structuredClone(old));
  await s.service.restoreArchived({ archiveId: old.id });
  // Simulate an ordinary persisted edit before the next archive.
  const edited = s.durable();
  edited.sessions.find((item) => item.id === old.id)!.title = "恢复后的改动";
  const fresh = new ChatService({
    planner: s.planner,
    save: s.save,
    load: async () => edited,
    archive: s.archive,
    list: s.list,
    loadArchive: s.loadArchive,
  });
  const before = await fresh.snapshot();
  const original = before.sessions.find((item) => item.id === old.id)!;
  await fresh.archive({ sessionId: old.id });
  const expectedId =
    "archive-" + createHash("sha256").update(canonical(original)).digest("hex");
  const revision = s.archives.get(expectedId)!;
  expect(revision).toMatchObject({
    version: 2,
    id: expectedId,
    originalSessionId: old.id,
    session: original,
  });
  expect(s.archives.get(old.id)).toEqual(old);
  expect((await fresh.listArchived()).entries.map((item) => item.id)).toEqual(
    expect.arrayContaining([old.id, expectedId]),
  );
  await fresh.restoreArchived({ archiveId: expectedId });
  expect((await fresh.listArchived()).entries).toEqual([]);
  await fresh.archive({ sessionId: old.id });
  expect(s.archives.size).toBe(2);
  expect(s.archives.get(expectedId)).toEqual(revision);
});

it("selects an existing active copy on repeated restore without replacing newer edits", async () => {
  const current = session();
  current.title = "当前改动";
  const s = setup([session(2), current]);
  s.archives.set("session-1", legacy());
  const result = await s.service.restoreArchived({ archiveId: "session-1" });
  expect(result.sessions).toHaveLength(2);
  expect(result.sessions[1].title).toBe("当前改动");
  expect(result.selectedSessionId).toBe("session-1");
  expect(s.save).toHaveBeenCalledOnce();
});

it("retains both files and original active view when a restore save fails", async () => {
  const s = setup();
  const record = legacy();
  s.archives.set(record.id, structuredClone(record));
  const before = await s.service.snapshot();
  const listener = vi.fn();
  s.service.subscribe(listener);
  s.save.mockRejectedValueOnce(Error("disk failure"));
  await expect(
    s.service.restoreArchived({ archiveId: record.id }),
  ).rejects.toMatchObject({ code: "CHAT_STORE_UNAVAILABLE" });
  const failed = await s.service.snapshot();
  expect(failed.sessions).toEqual(before.sessions);
  expect(failed.selectedSessionId).toBe(before.selectedSessionId);
  expect(s.durable().sessions[0].id).toBe("session-2");
  expect(s.archives.get(record.id)).toEqual(record);
  expect(listener).not.toHaveBeenCalled();
  await expect(
    s.service.restoreArchived({ archiveId: record.id }),
  ).rejects.toMatchObject({ code: "CHAT_STORE_UNAVAILABLE" });
});

it("rejects restore capacity overflow without dropping other sessions or history", async () => {
  const all = Array.from({ length: 32 }, (_, i) => session(i + 2, 0));
  const s = setup(all);
  const record = legacy();
  s.archives.set(record.id, record);
  const before = await s.service.snapshot();
  await expect(
    s.service.restoreArchived({ archiveId: record.id }),
  ).rejects.toMatchObject({ code: "CHAT_BUDGET" });
  expect(await s.service.snapshot()).toEqual(before);
  expect(s.archives.get(record.id)).toEqual(record);
  expect(s.save).not.toHaveBeenCalled();
});

it("counts restored summaries in the byte budget without quarantining current history", async () => {
  const maximum = 8 * 1024 * 1024 - 128;
  const stored = session(2, 1);
  const notes: string[] = [];
  stored.turns[0].planner.result!.records = [
    {
      requestId: "original",
      requestSource: "daily",
      recordedStatus: "unknown",
      recordedConclusion: "unknown",
      complete: false,
      inGameCompletion: "not-verified",
      tasks: [],
      warnings: [],
      notes,
    },
  ];
  const projection = () => ({
    revision: 2,
    selectedSessionId: stored.id,
    sessions: [{ ...stored, summary: summarizeChatSession(stored) }],
  });
  let padding =
    maximum - Buffer.byteLength(JSON.stringify(projection()), "utf8") - 1000;
  while (padding > (notes.length ? 3 : 2)) {
    const overhead = notes.length ? 3 : 2;
    const length = Math.min(4000, padding - overhead);
    notes.push("x".repeat(length));
    padding -= length + overhead;
  }
  const s = setup([stored]);
  const record = legacy();
  s.archives.set(record.id, record);
  const before = await s.service.snapshot();
  expect(before.error).toBeUndefined();
  await expect(
    s.service.restoreArchived({ archiveId: record.id }),
  ).rejects.toMatchObject({ code: "CHAT_BUDGET" });
  expect(await s.service.snapshot()).toEqual(before);
  expect(s.durable().sessions).toEqual([stored]);
  expect(s.archives.get(record.id)).toEqual(record);
  expect(s.save).not.toHaveBeenCalled();
  await s.service.archive({ sessionId: stored.id });
  expect(s.archives.size).toBe(2);
});

it("serializes restoration before another management request and publishes only a committed result", async () => {
  const s = setup();
  s.archives.set("session-1", legacy());
  await s.service.snapshot();
  const listener = vi.fn();
  s.service.subscribe(listener);
  let release!: () => void;
  s.save.mockImplementationOnce(
    async () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const restore = s.service.restoreArchived({ archiveId: "session-1" });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(listener).not.toHaveBeenCalled();
  await expect(
    s.service.delete({ sessionId: "session-2", confirmation: "delete-chat" }),
  ).rejects.toMatchObject({ code: "CHAT_BUSY" });
  release();
  await restore;
  expect(listener).toHaveBeenCalledOnce();
  expect(listener.mock.calls[0][0].selectedSessionId).toBe("session-1");
});

it("rejects unknown, corrupt or mismatched archives without saving active history", async () => {
  const s = setup();
  await s.service.snapshot();
  await expect(
    s.service.restoreArchived({ archiveId: "missing" }),
  ).rejects.toMatchObject({ code: "CHAT_ARCHIVE_NOT_FOUND" });
  s.archives.set("wrong", legacy());
  await expect(
    s.service.restoreArchived({ archiveId: "wrong" }),
  ).rejects.toMatchObject({ code: "CHAT_ARCHIVE_UNAVAILABLE" });
  const corrupt = legacy();
  corrupt.session.turns[0].planner.result!.canExecute = true as never;
  s.archives.set(corrupt.id, corrupt);
  await expect(
    s.service.restoreArchived({ archiveId: corrupt.id }),
  ).rejects.toMatchObject({ code: "CHAT_ARCHIVE_UNAVAILABLE" });
  expect(s.save).not.toHaveBeenCalled();
});

it("requires exact management inputs and local delete confirmation before storage access", async () => {
  const s = setup();
  await s.service.snapshot();
  for (const input of [
    undefined,
    {},
    { archiveId: "../unsafe" },
    { archiveId: "missing", sessionId: "session-2" },
  ])
    await expect(s.service.restoreArchived(input)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  for (const input of [
    undefined,
    {},
    { sessionId: "session-2" },
    { sessionId: "session-2", confirmation: true },
    { sessionId: "session-2", confirmation: "delete-chat", archive: true },
  ])
    await expect(s.service.delete(input)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  await expect(
    s.service.delete({ sessionId: "missing", confirmation: "delete-chat" }),
  ).rejects.toMatchObject({ code: "CHAT_SESSION_MISMATCH" });
  expect(s.loadArchive).not.toHaveBeenCalled();
  expect(s.archive).not.toHaveBeenCalled();
  expect(s.save).not.toHaveBeenCalled();
});

it("deletes only the chosen nonselected active chat without creating an archive", async () => {
  const s = setup([session(1), session(2)]);
  const record = legacy(session(2));
  s.archives.set(record.id, record);
  const deleted = await s.service.delete({
    sessionId: "session-2",
    confirmation: "delete-chat",
  });
  expect(deleted.selectedSessionId).toBe("session-1");
  expect(deleted.sessions.map((item) => item.id)).toEqual(["session-1"]);
  expect(s.archives.get(record.id)).toEqual(record);
  expect(s.archive).not.toHaveBeenCalled();
  expect(s.loadArchive).not.toHaveBeenCalled();
  expect(s.planner.startConversation).not.toHaveBeenCalled();
  expect(s.planner.cancel).not.toHaveBeenCalled();
});

it("selects a survivor after deleting the selected chat and creates a blank after deleting the last", async () => {
  const s = setup([session(1), session(2)]);
  const first = await s.service.delete({
    sessionId: "session-1",
    confirmation: "delete-chat",
  });
  expect(first.selectedSessionId).toBe("session-2");
  const last = await s.service.delete({
    sessionId: "session-2",
    confirmation: "delete-chat",
  });
  expect(last.sessions).toHaveLength(1);
  expect(last.sessions[0].id).not.toBe("session-2");
  expect(last.sessions[0].turns).toEqual([]);
  expect(last.selectedSessionId).toBe(last.sessions[0].id);
  expect(s.archive).not.toHaveBeenCalled();
  expect(s.archives.size).toBe(0);
});

it("rolls back a failed deletion and publishes no uncommitted view", async () => {
  const s = setup();
  const before = await s.service.snapshot();
  const listener = vi.fn();
  s.service.subscribe(listener);
  s.save.mockRejectedValueOnce(Error("disk failure"));
  await expect(
    s.service.delete({ sessionId: "session-2", confirmation: "delete-chat" }),
  ).rejects.toMatchObject({ code: "CHAT_STORE_UNAVAILABLE" });
  expect((await s.service.snapshot()).sessions).toEqual(before.sessions);
  expect(s.durable().sessions[0].id).toBe("session-2");
  expect(listener).not.toHaveBeenCalled();
  expect(s.archive).not.toHaveBeenCalled();
});

it.each(["archive", "restore", "delete"] as const)(
  "preserves a concurrent terminal model event on %s rollback without committing a second change",
  async (operation) => {
    const s = setup([session(1), session(2)]);
    await s.service.snapshot();
    s.archives.set("session-3", legacy(session(3)));
    s.emitState({
      ...session(2).turns[0].planner,
      revision: 2,
      status: "running",
      result: undefined,
    });
    let fail!: (error: Error) => void;
    s.save.mockImplementationOnce(
      async () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const pending =
      operation === "archive"
        ? s.service.archive({ sessionId: "session-1" })
        : operation === "restore"
          ? s.service.restoreArchived({ archiveId: "session-3" })
          : s.service.delete({
              sessionId: "session-1",
              confirmation: "delete-chat",
            });
    await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
    const terminal = { ...session(2).turns[0].planner, revision: 3 };
    terminal.result!.modelText = "保存期间完成的答复";
    s.emitState(terminal);
    fail(Error("disk failure"));
    await expect(pending).rejects.toMatchObject({
      code: "CHAT_STORE_UNAVAILABLE",
    });
    const rolledBack = await s.service.snapshot();
    expect(rolledBack.sessions.map((item) => item.id)).toEqual([
      "session-1",
      "session-2",
    ]);
    expect(rolledBack.sessions[1].turns[0].planner).toEqual(terminal);
    expect(s.durable().sessions.map((item) => item.id)).toEqual([
      "session-1",
      "session-2",
    ]);
    expect(s.save).toHaveBeenCalledOnce();
  },
);

it.each(["archive", "restore", "delete"] as const)(
  "keeps original durable chats when snapshot polls during a failed %s write",
  async (operation) => {
    const s = setup([session(1), session(2)]);
    await s.service.snapshot();
    s.archives.set("session-3", legacy(session(3)));
    s.emitState({
      ...session(2).turns[0].planner,
      revision: 2,
      status: "running",
      result: undefined,
    });
    let fail!: (error: Error) => void;
    s.save.mockImplementationOnce(
      async () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const pending =
      operation === "archive"
        ? s.service.archive({ sessionId: "session-1" })
        : operation === "restore"
          ? s.service.restoreArchived({ archiveId: "session-3" })
          : s.service.delete({
              sessionId: "session-1",
              confirmation: "delete-chat",
            });
    await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
    const terminal = { ...session(2).turns[0].planner, revision: 3 };
    terminal.result!.modelText = "轮询期间完成的答复";
    s.emitState(terminal);
    const poll = vi.spyOn(s.planner, "verifiedSnapshot");
    const concurrent = s.service.snapshot();
    await vi.waitFor(() => expect(poll).toHaveBeenCalledOnce());
    fail(Error("disk failure"));
    await expect(pending).rejects.toMatchObject({
      code: "CHAT_STORE_UNAVAILABLE",
    });
    const observed = await concurrent;
    expect(s.durable().sessions.map((item) => item.id)).toEqual([
      "session-1",
      "session-2",
    ]);
    expect(observed.sessions.map((item) => item.id)).toEqual([
      "session-1",
      "session-2",
    ]);
    expect(observed.sessions[1].turns[0].planner).toEqual(terminal);
    expect(observed.error).toContain("会话");
    expect(s.save).toHaveBeenCalledOnce();
  },
);

it("flushes a concurrent terminal model event after a successful restore commit", async () => {
  const s = setup();
  s.archives.set("session-1", legacy());
  await s.service.snapshot();
  s.emitState({
    ...session(2).turns[0].planner,
    revision: 2,
    status: "running",
    result: undefined,
  });
  let release!: () => void;
  s.save.mockImplementationOnce(
    async () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const restoration = s.service.restoreArchived({ archiveId: "session-1" });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const terminal = { ...session(2).turns[0].planner, revision: 3 };
  terminal.result!.modelText = "恢复期间完成的答复";
  s.emitState(terminal);
  release();
  const restored = await restoration;
  expect(restored.selectedSessionId).toBe("session-1");
  expect(restored.sessions[0].turns[0].planner).toEqual(terminal);
  expect(s.durable().sessions[0].turns[0].planner).toEqual(terminal);
  expect(s.save).toHaveBeenCalledTimes(2);
});

it("rejects managing the session with model or host activity while allowing unrelated sessions", async () => {
  const s = setup([session(1), session(2)]);
  await s.service.snapshot();
  s.setState({
    ...session().turns[0].planner,
    revision: 3,
    status: "running",
    result: undefined,
  });
  s.archives.set("session-1", legacy());
  await expect(
    s.service.delete({ sessionId: "session-1", confirmation: "delete-chat" }),
  ).rejects.toMatchObject({ code: "CHAT_SESSION_ACTIVE" });
  await expect(
    s.service.restoreArchived({ archiveId: "session-1" }),
  ).rejects.toMatchObject({ code: "CHAT_SESSION_ACTIVE" });
  const unrelated = await s.service.delete({
    sessionId: "session-2",
    confirmation: "delete-chat",
  });
  expect(unrelated.sessions[0].turns[0].planner.status).toBe("running");
  const blocked = setup(
    undefined,
    vi.fn(() => false),
  );
  blocked.archives.set("session-1", legacy());
  await expect(
    blocked.service.delete({
      sessionId: "session-2",
      confirmation: "delete-chat",
    }),
  ).rejects.toMatchObject({ code: "CHAT_SESSION_ACTIVE" });
  await expect(
    blocked.service.restoreArchived({ archiveId: "session-1" }),
  ).rejects.toMatchObject({ code: "CHAT_SESSION_ACTIVE" });
  expect(blocked.save).not.toHaveBeenCalled();
});

it("keeps the active chat if a host task becomes active during the archive file write", async () => {
  const canArchive = vi.fn(() => true);
  const s = setup([session()], canArchive);
  const before = await s.service.snapshot();
  s.archive.mockImplementationOnce(async (record) => {
    s.archives.set(record.id, structuredClone(record));
    canArchive.mockReturnValue(false);
  });
  await expect(
    s.service.archive({ sessionId: "session-1" }),
  ).rejects.toMatchObject({ code: "CHAT_SESSION_ACTIVE" });
  expect(await s.service.snapshot()).toEqual(before);
  expect(s.save).not.toHaveBeenCalled();
  expect(s.archives.size).toBe(1);
});

it("omits active sessions before archive pagination so pages stay full", async () => {
  const s = setup([session(2)]);
  for (let n = 1; n <= 5; n++)
    s.archives.set(`session-${n}`, {
      ...legacy(session(n)),
      archivedAt: `2026-10-13T04:00:0${n}.000Z`,
    });
  const first = await s.service.listArchived({ limit: 2 });
  const next = await s.service.listArchived({
    limit: 2,
    cursor: first.nextCursor,
  });
  expect(
    [...first.entries, ...next.entries].map((item) => item.sessionId),
  ).toEqual(["session-5", "session-4", "session-3", "session-1"]);
  expect(next.nextCursor).toBeUndefined();
});
