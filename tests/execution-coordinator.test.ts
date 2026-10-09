import { afterEach, expect, it } from "vitest";
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
