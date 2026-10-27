import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunLedger } from "../apps/desktop/main/run-ledger";
import { reduceTaskRecords } from "../packages/protocol/task-record";
import { Runner } from "../packages/runtime/runner";
import type { RunEvent } from "../packages/protocol";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const start = (
  laneId = "a",
  runId = "ark",
  gameId = "arknights",
): RunEvent => ({
  laneId,
  runId,
  batchId: "batch",
  gameId,
  type: "status",
  status: "queued",
  message: "start",
  at: "2026-09-25T00:00:00.000Z",
  plan: { gameId, skillIds: ["login", "award"], mode: "live" },
});
const step = (id: string, status: RunEvent["stepStatus"]): RunEvent => ({
  ...start(),
  plan: undefined,
  status: undefined,
  type: "step",
  skillId: id,
  stepStatus: status,
  at: "2026-09-25T00:01:00.000Z",
  message: status!,
});
async function store() {
  const dir = await mkdtemp(join(tmpdir(), "gp-ledger-"));
  dirs.push(dir);
  const ledger = new RunLedger(dir);
  await ledger.load();
  return { dir, ledger };
}
describe("durable task records", () => {
  it.each(["corrupt", "unsupported", "wrong-name"])(
    "loads valid records beside %s evidence while blocking starts",
    async (kind) => {
      const { ledger, dir } = await store();
      await ledger.append(start());
      const validFile = (await readdir(dir))[0];
      const validRaw = await readFile(join(dir, validFile), "utf8");
      const badRaw =
        kind === "corrupt"
          ? "broken private diagnostics"
          : kind === "unsupported"
            ? JSON.stringify({ ...JSON.parse(validRaw), version: 99 })
            : validRaw;
      const badFile = join(dir, "unidentified.json");
      await writeFile(badFile, badRaw);
      const restarted = new RunLedger(dir);
      await restarted.load();
      expect(restarted.snapshot()).toHaveLength(1);
      expect(() => restarted.assertHealthy()).toThrow("记录");
      await expect(restarted.append(start("b"))).rejects.toThrow("记录");
      expect(await readFile(badFile, "utf8")).toBe(badRaw);
      expect(restarted.error).not.toContain("private diagnostics");
    },
  );

  it("reports unavailable directories while retaining a usable review API", async () => {
    const { dir } = await store();
    await rm(dir, { recursive: true });
    await writeFile(dir, "occupied");
    const restarted = new RunLedger(dir);
    await restarted.load();
    expect(restarted.snapshot()).toEqual([]);
    expect(() => restarted.assertHealthy()).toThrow("记录");
  });
  it("keeps device and game runs separate, preserving success before later failure", async () => {
    const { ledger, dir } = await store();
    for (const e of [
      start(),
      step("login", "running"),
      step("login", "succeeded"),
      step("award", "running"),
      step("award", "failed"),
      { ...start(), plan: undefined, status: "failed" as const },
      start("b"),
      start("a", "yys", "onmyoji"),
    ])
      await ledger.append(e);
    const reopened = new RunLedger(dir);
    await reopened.load();
    const records = reopened.snapshot();
    expect(records).toHaveLength(3);
    const arkA = records.find(
      (r) => r.laneId === "a" && r.gameId === "arknights",
    )!;
    expect(arkA.steps.map((s) => s.status)).toEqual(["succeeded", "failed"]);
    expect(records.find((r) => r.laneId === "b")?.status).toBe("unknown");
  });
  it("marks only interrupted work unknown, leaves unstarted steps unexecuted", async () => {
    const { ledger, dir } = await store();
    await ledger.append(start());
    await ledger.append(step("login", "running"));
    const restarted = new RunLedger(dir);
    await restarted.load();
    expect(restarted.snapshot()[0].steps.map((s) => s.status)).toEqual([
      "unknown",
      "not-run",
    ]);
    expect(restarted.snapshot()[0].status).toBe("unknown");
    const again = new RunLedger(dir);
    await again.load();
    expect(again.snapshot()).toEqual(restarted.snapshot());
  });
  it("persists results beyond the display log limit and owns snapshots", async () => {
    const { ledger, dir } = await store();
    await ledger.append(start());
    await ledger.append(step("login", "running"));
    await ledger.append(step("login", "skipped"));
    for (let i = 0; i < 510; i++)
      await ledger.append({
        ...step("award", undefined),
        type: "log",
        message: `trace ${i}`,
      });
    const copied = ledger.snapshot();
    copied[0].steps[0].status = "failed";
    expect(ledger.snapshot()[0].steps[0].status).toBe("skipped");
    const restarted = new RunLedger(dir);
    await restarted.load();
    expect(restarted.snapshot()[0].steps[0].status).toBe("skipped");
  });
  it("does not invent task records from legacy free text or regress completed steps", () => {
    expect(
      reduceTaskRecords([], {
        ...start(),
        plan: undefined,
        message: "all done",
      }),
    ).toEqual([]);
    let records = reduceTaskRecords([], start());
    records = reduceTaskRecords(records, step("login", "running"));
    records = reduceTaskRecords(records, step("login", "skipped"));
    records = reduceTaskRecords(records, step("login", "running"));
    expect(records[0].steps[0].status).toBe("skipped");
    records = reduceTaskRecords(records, {
      ...start(),
      plan: undefined,
      status: "succeeded",
    });
    expect(records[0].status).toBe("unknown");
    expect(records[0].steps[1].status).toBe("not-run");
  });
  it("retains malformed files and reports unhealthy storage instead of clearing evidence", async () => {
    const { ledger, dir } = await store();
    await ledger.append(start());
    const file = (await readdir(dir))[0];
    await writeFile(join(dir, file), "broken");
    const restarted = new RunLedger(dir);
    await restarted.load();
    expect(restarted.error).toContain("记录");
    expect(() => restarted.assertHealthy()).toThrow();
    expect(await readdir(dir)).toContain(file);
  });
  it("records a real Runner chain including explicit skip and next-game failure", async () => {
    const { ledger } = await store();
    const make = (gameId: string, fail: boolean) =>
      new Runner(
        [
          {
            id: gameId,
            name: gameId,
            subtitle: "",
            skills: ["login", "award"].map((id) => ({
              id,
              title: id,
              description: "",
              ready: true,
            })),
          },
        ],
        (e) => {
          void ledger.append({ ...e, laneId: "a", batchId: "batch" });
        },
        async (id) => {
          if (fail && id === "award") throw Error("unknown page");
          return { status: "skipped", summary: "nothing to claim" };
        },
      );
    await make("arknights", false).start(start().plan!).finished;
    await make("onmyoji", true).start(start("a", "yys", "onmyoji").plan!)
      .finished;
    await ledger.flush();
    expect(
      ledger
        .snapshot()
        .map((r) => r.status)
        .sort(),
    ).toEqual(["failed", "succeeded"]);
    expect(
      ledger.snapshot().find((r) => r.gameId === "onmyoji")!.steps[0].status,
    ).toBe("skipped");
  });
  it("marks worker death unknown without changing prior confirmed steps", () => {
    let records = reduceTaskRecords([], start());
    records = reduceTaskRecords(records, step("login", "running"));
    records = reduceTaskRecords(records, step("login", "succeeded"));
    records = reduceTaskRecords(records, step("award", "running"));
    records = reduceTaskRecords(records, {
      ...start(),
      plan: undefined,
      status: "failed",
      resultUncertain: true,
    });
    expect(records[0].status).toBe("unknown");
    expect(records[0].steps.map((s) => s.status)).toEqual([
      "succeeded",
      "unknown",
    ]);
  });
  it("reports failed persistence and blocks new work", async () => {
    const { ledger, dir } = await store();
    await rm(dir, { recursive: true, force: true });
    await writeFile(dir, "occupied");
    await expect(ledger.append(start())).rejects.toThrow();
    await expect(ledger.flush()).rejects.toThrow("保存失败");
    expect(() => ledger.assertHealthy()).toThrow("保存失败");
  });
});
it("persists and reloads structured failure evidence without changing a failed step to success", async () => {
  const { ledger, dir } = await store();
  const evidence = {
    version: 1 as const,
    taskType: "StartUp",
    submission: "not-submitted" as const,
    completion: "not-started" as const,
    observedAt: new Date().toISOString(),
  };
  const runner = new Runner(
    [
      {
        id: "arknights",
        name: "Arknights",
        subtitle: "test",
        skills: [
          { id: "login", title: "Login", description: "test", ready: true },
        ],
      },
    ],
    (event) => {
      void ledger.append(event);
    },
    async (_id, _signal, log) => {
      log("未提交", { arknights: evidence });
      throw Error("connection failed");
    },
  );
  await runner.start({ gameId: "arknights", skillIds: ["login"], mode: "live" })
    .finished;
  await ledger.flush();
  const reopened = new RunLedger(dir);
  await reopened.load();
  const records = reopened.snapshot();
  expect(records[0].status).toBe("failed");
  expect(records[0].steps[0].result?.arknights).toEqual(evidence);
});
