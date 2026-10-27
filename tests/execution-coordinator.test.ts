import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  StartupFaultError,
  startupFaultFrom,
} from "../packages/protocol/startup-fault";
import {
  ExecutionCoordinator,
  mumuResource,
} from "../apps/desktop/main/execution-coordinator";

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "gp-executions-"));
  dirs.push(dir);
  const service = new ExecutionCoordinator(dir);
  await service.load();
  return { service, dir };
}
it("probes physical resource occupancy without reserving or consuming a request", async () => {
  const { service } = await setup();
  expect(service.canStart(["device-a"])).toBe(true);
  const lease = await service.begin(request("busy-probe"));
  expect(service.canStart(["device-a"])).toBe(false);
  expect(service.canStart(["device-b"])).toBe(true);
  expect(service.snapshot()).toHaveLength(1);
  await lease.finish("succeeded", "probe complete");
  expect(service.canStart(["device-a"])).toBe(true);
});
it("persists independently observed exit proof without changing the frozen fingerprint", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { service, dir } = await setup();
  const input = request("exit-proof");
  input.snapshot.lane = {
    instance: 0,
    adbPath: "C:/adb.exe",
    address: "127.0.0.1:16384",
  } as typeof input.snapshot.lane;
  const lease = await service.begin(input);
  const original = service.get(input.id);
  const firstObservedAt = new Date().toISOString();
  vi.advanceTimersByTime(300);
  const observedAt = new Date().toISOString();
  const proof = {
    version: 1 as const,
    kind: "game-exit" as const,
    gameId: "arknights",
    method: "adb-process-check" as const,
    device: { adbPath: "C:/adb.exe", address: "127.0.0.1:16384" },
    packageName: "com.hypergryph.arknights",
    firstObservedAt,
    observedAt,
    notRunning: [true, true] as [true, true],
  };
  await expect(
    lease.observe!({ ...proof, device: { ...proof.device, address: "other" } }),
  ).rejects.toThrow("退出证据");
  await lease.observe!(proof);
  proof.device.address = "mutated";
  expect(service.get(input.id).fingerprint).toBe(original.fingerprint);
  expect(service.get(input.id).observations?.[0].device.address).toBe(
    "127.0.0.1:16384",
  );
  await expect(
    lease.observe!({
      ...proof,
      device: { adbPath: "C:/adb.exe", address: "127.0.0.1:16384" },
    }),
  ).rejects.toThrow("重复");
  await lease.finish("succeeded", "ok");
  await expect(lease.observe!(proof)).rejects.toThrow("已结束");
  const loaded = new ExecutionCoordinator(dir);
  await loaded.load();
  expect(loaded.error).toBeUndefined();
  expect(loaded.get(input.id).observations).toEqual(
    service.get(input.id).observations,
  );
  const saved = JSON.parse(
    await readFile(
      join(dir, createHash("sha256").update(input.id).digest("hex") + ".json"),
      "utf8",
    ),
  );
  expect(saved.observations).toHaveLength(1);
});
const request = (id: string, device = "device-a") => ({
  id,
  source: "daily" as const,
  resources: [device],
  snapshot: {
    version: "test",
    lane: { instance: 0 },
    plans: ["login", "award"],
  },
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
async function writeReceipt(
  dir: string,
  id: string,
  snapshot: Record<string, unknown>,
  status = "succeeded",
) {
  const input = { ...request(id), snapshot };
  const record = {
    ...input,
    version: 1,
    fingerprint: createHash("sha256").update(canonical(input)).digest("hex"),
    status,
    startedAt: "2026-09-25T00:00:00Z",
    message: "stored",
  };
  const file = join(
    dir,
    createHash("sha256").update(id).digest("hex") + ".json",
  );
  const raw = JSON.stringify(record);
  await writeFile(file, raw);
  return { record, file, raw };
}

it("stamps the current schema only on new requests without changing callers", async () => {
  const { service } = await setup();
  const input = request("schema-current");
  const lease = await service.begin(input);
  expect(service.get(input.id).snapshot.schemaVersion).toBe(1);
  expect(input.snapshot).not.toHaveProperty("schemaVersion");
  await lease.finish("succeeded", "done");
});

it.each([2, 0, "1", null, 1.5, undefined, Number.NaN])(
  "rejects new snapshot schema %s before creating a receipt",
  async (schemaVersion) => {
    const { service, dir } = await setup();
    await expect(
      service.begin({
        ...request("schema-rejected"),
        snapshot: { schemaVersion },
      }),
    ).rejects.toThrow("快照");
    expect(service.snapshot()).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  },
);

it("rejects snapshots whose JSON serialization changes the validated schema", async () => {
  const { service, dir } = await setup();
  await expect(
    service.begin({
      ...request("schema-serialization"),
      snapshot: { schemaVersion: 1, toJSON: () => ({ schemaVersion: 2 }) },
    }),
  ).rejects.toThrow("快照");
  expect(await readdir(dir)).toEqual([]);
});

it("loads legacy snapshots with their original raw data and fingerprint", async () => {
  const { dir } = await setup();
  const stored = await writeReceipt(dir, "legacy-receipt", {
    ...request("x").snapshot,
    future: { kept: true },
  });
  const service = new ExecutionCoordinator(dir);
  await service.load();
  service.assertHealthy();
  expect(service.get("legacy-receipt")).toEqual(stored.record);
  expect(await readFile(stored.file, "utf8")).toBe(stored.raw);
  await expect(
    service.begin({
      ...request("legacy-receipt"),
      snapshot: stored.record.snapshot,
    }),
  ).rejects.toThrow("已受理");
});

it("recovers an interrupted legacy snapshot without migrating its schema or fingerprint", async () => {
  const { dir } = await setup();
  const stored = await writeReceipt(
    dir,
    "legacy-running",
    request("x").snapshot,
    "running",
  );
  const service = new ExecutionCoordinator(dir);
  await service.load();
  expect(service.get("legacy-running")).toMatchObject({
    snapshot: stored.record.snapshot,
    fingerprint: stored.record.fingerprint,
    status: "unknown",
  });
  expect(service.get("legacy-running").snapshot).not.toHaveProperty(
    "schemaVersion",
  );
});

it.each([2, "1", null])(
  "retains schema %s receipts for review while blocking replay and writes",
  async (schemaVersion) => {
    const { dir } = await setup();
    const stored = await writeReceipt(
      dir,
      "future-receipt",
      { schemaVersion, future: { kept: true } },
      "running",
    );
    const service = new ExecutionCoordinator(dir);
    await service.load();
    expect(service.get("future-receipt")).toEqual(stored.record);
    expect(await readFile(stored.file, "utf8")).toBe(stored.raw);
    expect(() => service.assertHealthy()).toThrow("快照");
    await expect(service.begin(request("another"))).rejects.toThrow("快照");
    await expect(
      service.resolve("future-receipt", "reviewed"),
    ).rejects.toThrow();
    await expect(
      service.inspect(["device-a"], async () => true),
    ).rejects.toThrow("快照");
    expect(await readFile(stored.file, "utf8")).toBe(stored.raw);
  },
);

it("persists typed startup failure without changing the frozen request and rejects contradictory evidence", async () => {
  const { service, dir } = await setup();
  const lease = await service.begin(request("startup"));
  const before = service.get("startup");
  const fault = startupFaultFrom(
    new StartupFaultError("mumu-launch-failed", "private diagnostics"),
  )!;
  expect(() => lease.finish("succeeded", "done", fault)).toThrow();
  expect(() =>
    lease.finish("unknown", "failed", {
      ...fault,
      observedAt: "2000-01-01T00:00:00Z",
    }),
  ).toThrow();
  await lease.finish("unknown", "failed", fault);
  fault.code = "mumu-boot-timeout";
  const reloaded = new ExecutionCoordinator(dir);
  await reloaded.load();
  expect(reloaded.get("startup")).toMatchObject({
    status: "unknown",
    fingerprint: before.fingerprint,
    snapshot: before.snapshot,
    startupFault: { code: "mumu-launch-failed" },
  });
  expect(service.active).toBe(false);
});

it("read-only inspection shares resource ownership but creates no execution receipt", async () => {
  const { service } = await setup();
  let release!: () => void;
  const reading = service.inspect(
    ["device-a"],
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  await expect(service.begin(request("busy"))).rejects.toThrow("占用");
  expect(service.snapshot()).toHaveLength(0);
  release();
  await reading;
  expect(service.active).toBe(false);
});

it("resolves unknown without changing its result and retains deduplication after restart", async () => {
  const { service, dir } = await setup();
  const lease = await service.begin(request("unknown"));
  await expect(service.resolve("unknown", "已检查")).rejects.toThrow("结束");
  await lease.finish("unknown", "interrupted");
  await expect(service.resolve("unknown", " ")).rejects.toThrow("说明");
  const resolved = await service.resolve("unknown", "已核对现场，结束此轮处理");
  expect(resolved.status).toBe("unknown");
  expect(resolved.resolution?.note).toContain("已核对现场");
  await expect(service.resolve("unknown", "覆盖说明")).rejects.toThrow(
    "已处理",
  );
  const restarted = new ExecutionCoordinator(dir);
  await restarted.load();
  expect(restarted.get("unknown").resolution).toEqual(resolved.resolution);
  await expect(restarted.begin(request("unknown"))).rejects.toThrow("已受理");
});
it("does not hide unresolved results when saving the review fails", async () => {
  const { service, dir } = await setup();
  const lease = await service.begin(request("unresolved"));
  await lease.finish("unknown", "exit");
  await rm(dir, { recursive: true });
  await writeFile(dir, "not a directory");
  await expect(service.resolve("unresolved", "人工结束")).rejects.toThrow();
  expect(service.get("unresolved").resolution).toBeUndefined();
  expect(service.active).toBe(false);
});

it("reserves before awaiting disk and allows different devices concurrently", async () => {
  const { service } = await setup();
  const first = service.begin(request("first"));
  await expect(service.begin(request("overlap"))).rejects.toThrow("占用");
  const second = await service.begin(request("second", "device-b"));
  expect(service.active).toBe(true);
  await (await first).finish("succeeded", "done");
  const third = await service.begin(request("third"));
  await second.finish("cancelled", "stop");
  await third.finish("succeeded", "done");
  expect(service.active).toBe(false);
});

it("cancels admission during the disk write without granting a lease to the worker", async () => {
  const { service } = await setup();
  const controller = new AbortController();
  const starting = service.begin(
    request("cancel-before-worker"),
    controller.signal,
  );
  controller.abort();
  await expect(starting).rejects.toMatchObject({ name: "AbortError" });
  expect(service.active).toBe(false);
  expect(service.snapshot()[0]?.status).toBe("cancelled");
});

it("serializes the legacy global entry with both lane devices", async () => {
  const { service } = await setup();
  const lane = await service.begin(request("lane"));
  await expect(service.begin(request("legacy", "*"))).rejects.toThrow("占用");
  await lane.finish("succeeded", "done");
  const legacy = await service.begin(request("legacy", "*"));
  await expect(service.begin(request("other", "device-b"))).rejects.toThrow(
    "占用",
  );
  await legacy.finish("cancelled", "stop");
});

it("normalizes physical MuMu identity, not the editable lane name", () => {
  expect(mumuResource("D:/MuMu/nx_main/../nx_main/MuMuManager.exe", 0)).toBe(
    mumuResource("d:\\mumu\\nx_main\\MuMuManager.exe", 0),
  );
  expect(mumuResource("D:/MuMu/MuMuManager.exe", 0)).not.toBe(
    mumuResource("D:/MuMu/MuMuManager.exe", 1),
  );
  expect(mumuResource("", 0)).toBe("*");
});

it("persists an immutable snapshot before granting execution", async () => {
  const { service, dir } = await setup();
  const input = request("frozen");
  const waiting = service.begin(input);
  input.snapshot.lane.instance = 9;
  input.resources[0] = "changed";
  const lease = await waiting;
  const file = (await readdir(dir)).find((name) => name.endsWith(".json"))!;
  const record = JSON.parse(await readFile(join(dir, file), "utf8"));
  expect(record.snapshot.lane.instance).toBe(0);
  expect(record.resources).toEqual(["device-a"]);
  service.snapshot()[0]!.snapshot.lane = "tampered";
  expect(service.snapshot()[0]!.snapshot.lane).toEqual({ instance: 0 });
  await lease.finish("succeeded", "done");
});

it("rejects duplicate request ids while running and after terminal/restart", async () => {
  const { service, dir } = await setup();
  const first = service.begin(request("same"));
  await expect(service.begin(request("same"))).rejects.toThrow("已受理");
  await (await first).finish("succeeded", "done");
  await expect(service.begin(request("same"))).rejects.toThrow("已受理");
  await expect(
    service.begin({ ...request("same"), snapshot: { changed: true } }),
  ).rejects.toThrow("参数不一致");
  const restarted = new ExecutionCoordinator(dir);
  await restarted.load();
  await expect(restarted.begin(request("same"))).rejects.toThrow("已受理");
  expect(restarted.snapshot()[0]!.status).toBe("succeeded");
});

it("does not treat the generated admission time as a new request parameter", async () => {
  const { service } = await setup();
  const first = request("stable");
  const lease = await service.begin({
    ...first,
    snapshot: { ...first.snapshot, startedAt: "2026-09-25T00:00:00Z" },
  });
  await lease.finish("succeeded", "done");
  await expect(
    service.begin({
      ...first,
      snapshot: { ...first.snapshot, startedAt: "2026-09-25T00:01:00Z" },
    }),
  ).rejects.toThrow("已受理");
});

it("marks interrupted requests unknown without executing or replaying them", async () => {
  const { service, dir } = await setup();
  await service.begin(request("interrupted"));
  const restarted = new ExecutionCoordinator(dir);
  await restarted.load();
  expect(restarted.active).toBe(false);
  expect(restarted.snapshot()[0]!.status).toBe("unknown");
  await expect(restarted.begin(request("interrupted"))).rejects.toThrow(
    "已受理",
  );
  const again = new ExecutionCoordinator(dir);
  await again.load();
  expect(again.snapshot()[0]!.status).toBe("unknown");
});

it("keeps corrupt files and blocks new actions", async () => {
  const { dir } = await setup();
  await writeFile(join(dir, "corrupt.json"), "broken");
  const service = new ExecutionCoordinator(dir);
  await service.load();
  await expect(service.begin(request("new"))).rejects.toThrow("请求记录");
  expect(await readFile(join(dir, "corrupt.json"), "utf8")).toBe("broken");
});

it("fails closed if storage cannot save a start", async () => {
  const { service, dir } = await setup();
  await rm(dir, { recursive: true });
  await writeFile(dir, "not a directory");
  await expect(service.begin(request("first"))).rejects.toThrow();
  expect(service.active).toBe(false);
  await rm(dir);
  await mkdir(dir);
  await expect(service.begin(request("second"))).rejects.toThrow("请求记录");
});

it("a failed terminal write releases the device but prevents another start", async () => {
  const { service, dir } = await setup();
  const lease = await service.begin(request("first"));
  await rm(dir, { recursive: true });
  await writeFile(dir, "not a directory");
  await expect(lease.finish("succeeded", "done")).rejects.toThrow();
  expect(service.active).toBe(false);
  await expect(service.begin(request("new"))).rejects.toThrow("请求记录");
});
