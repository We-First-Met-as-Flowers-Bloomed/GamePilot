import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
vi.mock("../apps/desktop/main/replace-file", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../apps/desktop/main/replace-file")>();
  return { replaceFile: vi.fn(actual.replaceFile) };
});
import { replaceFile } from "../apps/desktop/main/replace-file";
import { HistoryStore } from "../apps/desktop/main/history";
import type { RunEvent } from "../packages/protocol";
import {
  RunObservationStore,
  type RunObservation,
} from "../apps/desktop/main/run-observations";

const dirs: string[] = [];
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "gamepilot-observation-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  vi.clearAllMocks();
  for (const dir of dirs.splice(0)) {
    if (
      !resolve(dir).startsWith(
        resolve(tmpdir()) + sep + "gamepilot-observation-test-",
      )
    )
      throw new Error("Unexpected test directory");
    await rm(dir, { recursive: true, force: true });
  }
});
const sample = (): RunObservation => ({
  version: 1,
  id: "batch_1",
  laneId: "account-a",
  startedAt: "2026-09-24T00:00:00.000Z",
  finishedAt: "2026-09-24T00:30:00.000Z",
  status: "succeeded",
  gameId: "arknights",
  message: "日常完成",
  appVersion: "0.11.3",
  profileId: "default",
  stage: "1-7",
  mail: false,
});
const interrupted = (): RunEvent => ({
  runId: "batch_1",
  batchId: "batch_1",
  laneId: "account-a",
  gameId: "arknights",
  startedAt: sample().startedAt,
  at: sample().finishedAt,
  type: "status",
  status: "failed",
  message: "应用中断，任务结果未知；请检查游戏状态后重新执行。",
});
it("recovers interrupted batch parents with unknown original version and no invented configuration", async () => {
  const dir = await setup(),
    event = interrupted();
  await new RunObservationStore(dir).recoverInterrupted([
    event,
    { ...event, laneId: "account-b", gameId: "onmyoji" },
  ]);
  for (const [laneId, gameId] of [
    ["account-a", "arknights"],
    ["account-b", "onmyoji"],
  ])
    expect(
      JSON.parse(await readFile(join(dir, laneId, "batch_1.json"), "utf8")),
    ).toEqual({
      version: 1,
      id: event.runId,
      laneId,
      gameId,
      startedAt: event.startedAt,
      finishedAt: event.at,
      status: "failed",
      message: event.message,
      appVersion: "unknown",
    });
});
it("recovers once across consecutive restarts and never overwrites an existing final observation", async () => {
  const dir = await setup(),
    event = interrupted();
  await new RunObservationStore(dir).recoverInterrupted([event]);
  const target = join(dir, event.laneId!, event.runId + ".json");
  const original = await readFile(target, "utf8");
  await new RunObservationStore(dir).recoverInterrupted([
    { ...event, at: "2026-09-25T00:00:00Z" },
  ]);
  expect(await readFile(target, "utf8")).toBe(original);
  const store = new RunObservationStore(dir);
  const save = store.save(sample());
  await Promise.all([save, store.recoverInterrupted([event])]);
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual(sample());
});
it("recovery ignores maintenance, child tasks, missing starts, non-terminal and unrelated failures", async () => {
  const dir = await setup(),
    event = interrupted();
  const changes: Partial<RunEvent>[] = [
    { maintenance: true },
    { runId: "child" },
    { batchId: undefined },
    { laneId: undefined },
    { startedAt: undefined },
    { startedAt: "" },
    { gameId: undefined },
    { status: "running" },
    { status: "succeeded" },
    { type: "log" },
    { message: "ordinary task failure" },
  ];
  await new RunObservationStore(dir).recoverInterrupted(
    changes.map((change) => ({ ...event, ...change })),
  );
  expect(await readdir(dir)).toEqual([]);
});
it("recovers pinned active parents from history after more than 500 log events and preserves them on the next restart", async () => {
  const dir = await setup(),
    historyFile = join(dir, "history.json"),
    observations = join(dir, "observations");
  const event: RunEvent = {
    ...interrupted(),
    status: "running",
    message: "started",
    at: sample().startedAt,
  };
  const active = [event, { ...event, laneId: "account-b" }];
  await writeFile(
    historyFile,
    JSON.stringify([
      ...active,
      ...Array.from({ length: 505 }, (_, i) => ({
        ...event,
        type: "log",
        status: undefined,
        message: `log-${i}`,
      })),
    ]),
  );
  const first = new HistoryStore(historyFile);
  await first.load();
  expect(first.snapshot()).toHaveLength(500);
  await new RunObservationStore(observations).recoverInterrupted(
    first.snapshot(),
  );
  const paths = active.map((item) =>
    join(observations, item.laneId!, item.runId + ".json"),
  );
  const originals = await Promise.all(
    paths.map((path) => readFile(path, "utf8")),
  );
  for (const text of originals)
    expect(JSON.parse(text)).toMatchObject({
      status: "failed",
      startedAt: event.startedAt,
      appVersion: "unknown",
    });
  const second = new HistoryStore(historyFile);
  await second.load();
  await new RunObservationStore(observations).recoverInterrupted(
    second.snapshot(),
  );
  expect(
    await Promise.all(paths.map((path) => readFile(path, "utf8"))),
  ).toEqual(originals);
});
it("writes a versioned observation via replaceFile and reads back only allowed fields", async () => {
  const dir = await setup();
  const value = sample();
  await new RunObservationStore(dir).save({
    ...value,
    password: "never-save",
    screenshot: "data:image/png;base64,secret",
  });
  const target = join(dir, value.laneId, value.id + ".json");
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual(value);
  expect(replaceFile).toHaveBeenCalledWith(target + ".tmp", target);
  expect(await readdir(join(dir, value.laneId))).toEqual(["batch_1.json"]);
});
it("keeps two accounts from the same batch in separate files", async () => {
  const dir = await setup(),
    store = new RunObservationStore(dir);
  const a = sample(),
    b = { ...a, laneId: "account-b", status: "failed" as const };
  await Promise.all([store.save(a), store.save(b)]);
  for (const value of [a, b])
    expect(
      JSON.parse(
        await readFile(join(dir, value.laneId, value.id + ".json"), "utf8"),
      ),
    ).toEqual(value);
});
it("serializes concurrent updates and freezes the input at save time", async () => {
  const dir = await setup(),
    store = new RunObservationStore(dir);
  const value = sample();
  const first = store.save(value);
  value.message = "caller-mutated";
  await first;
  expect(
    JSON.parse(await readFile(join(dir, value.laneId, "batch_1.json"), "utf8"))
      .message,
  ).toBe("日常完成");
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      store.save({ ...sample(), message: String(i) }),
    ),
  );
  expect(
    JSON.parse(await readFile(join(dir, value.laneId, "batch_1.json"), "utf8"))
      .message,
  ).toBe("19");
  expect(await readdir(join(dir, value.laneId))).toEqual(["batch_1.json"]);
});
it("keeps observations beyond the 500-entry UI history limit", async () => {
  const dir = await setup(),
    store = new RunObservationStore(dir);
  await Promise.all(
    Array.from({ length: 501 }, (_, i) =>
      store.save({ ...sample(), id: `batch-${i}` }),
    ),
  );
  expect(await readdir(join(dir, "account-a"))).toHaveLength(501);
  expect(
    JSON.parse(await readFile(join(dir, "account-a", "batch-0.json"), "utf8"))
      .status,
  ).toBe("succeeded");
});
it.each([
  { id: "../escape" },
  { laneId: "..\\escape" },
  { id: "C:\\escape" },
  { id: "" },
  { id: "a".repeat(129) },
  { laneId: "NUL" },
  { id: "con" },
  { laneId: "lpt1" },
  { version: 2 },
  { status: "running" },
  { gameId: "other" },
  { message: {} },
  { appVersion: "" },
  { startedAt: "yesterday" },
  { finishedAt: "2026-02-30T00:00:00.000Z" },
  { finishedAt: "2026-09-23T00:00:00.000Z" },
  { mail: "yes" },
  { profileId: [] },
  { stage: 7 },
])("rejects invalid input without creating files: %j", async (invalid) => {
  const dir = await setup();
  await expect(
    new RunObservationStore(dir).save({ ...sample(), ...invalid }),
  ).rejects.toThrow();
  expect(await readdir(dir)).toEqual([]);
});
it.each([null, [], "record"])(
  "rejects a non-object record %j",
  async (invalid) => {
    const dir = await setup();
    await expect(new RunObservationStore(dir).save(invalid)).rejects.toThrow();
  },
);
it("accepts cancelled onmyoji observations without optional fields and with second precision dates", async () => {
  const dir = await setup();
  const { profileId, stage, mail, ...value } = sample();
  const record = {
    ...value,
    gameId: "onmyoji",
    status: "cancelled",
    startedAt: "2026-09-24T00:00:00Z",
    finishedAt: "2026-09-24T00:00:00Z",
  };
  await new RunObservationStore(dir).save(record);
  expect(
    JSON.parse(
      await readFile(join(dir, value.laneId, value.id + ".json"), "utf8"),
    ),
  ).toEqual(record);
});
it("surfaces storage failures and allows a later save after recovery", async () => {
  const dir = await setup(),
    store = new RunObservationStore(dir),
    value = sample();
  const blocker = join(dir, value.laneId);
  await writeFile(blocker, "blocked");
  await expect(store.save(value)).rejects.toThrow();
  await rm(blocker);
  await store.save(value);
  expect(
    JSON.parse(
      await readFile(join(dir, value.laneId, value.id + ".json"), "utf8"),
    ),
  ).toEqual(value);
});
