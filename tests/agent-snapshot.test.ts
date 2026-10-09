import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { readAgentSnapshot } from "../packages/agent/snapshot";
import { createAgentTools } from "../packages/agent/tools";
import { taskRecordKey } from "../packages/protocol/task-record";
import { canonical } from "../packages/acceptance/files";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const path = relative(resolve(tmpdir()), resolve(root));
    expect(path && !path.startsWith("..") && !isAbsolute(path)).toBeTruthy();
    await rm(root, { recursive: true, force: true });
  }
});
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
async function fixtureFiles() {
  const root = await mkdtemp(join(tmpdir(), "gp-agent-read-"));
  roots.push(root);
  const snapshot = createFixtureSnapshot();
  await writeFile(
    join(root, "device-lanes.json"),
    JSON.stringify(snapshot.lanes),
  );
  await writeFile(
    join(root, "arknights.json"),
    JSON.stringify(snapshot.profiles),
  );
  await mkdir(join(root, "execution-requests"));
  await mkdir(join(root, "task-runs"));
  const r = snapshot.requests[0];
  const { startedAt: _ignored, ...body } = r.snapshot;
  r.fingerprint = digest(
    canonical({
      id: r.id,
      source: r.source,
      resources: r.resources,
      snapshot: body,
      laneId: r.laneId,
      batchId: r.batchId,
    }),
  );
  const request = join(root, "execution-requests", digest(r.id) + ".json");
  await writeFile(request, JSON.stringify(r));
  await writeFile(
    join(root, "task-runs", digest(taskRecordKey(snapshot.tasks[0])) + ".json"),
    JSON.stringify(snapshot.tasks[0]),
  );
  return { root, request, snapshot };
}

it("reads complete records without recovering or changing any files", async () => {
  const { root, request } = await fixtureFiles();
  const raw = JSON.parse(await readFile(request, "utf8"));
  raw.status = "running";
  delete raw.finishedAt;
  await writeFile(request, JSON.stringify(raw));
  const before = await readFile(request, "utf8");
  const snapshot = await readAgentSnapshot(root);
  expect(snapshot.source).toBe("disk");
  expect(snapshot.errors).toEqual([]);
  expect(snapshot.requests[0].status).toBe("running");
  expect(await readFile(request, "utf8")).toBe(before);
  expect((await readdir(root)).sort()).toEqual([
    "arknights.json",
    "device-lanes.json",
    "execution-requests",
    "task-runs",
  ]);
  const text = JSON.stringify(
    createAgentTools(snapshot).call("get_environment"),
  );
  expect(text).not.toContain("PRIVATE");
  expect(text).not.toContain("111111111");
});

it("does not create a missing data directory and reports incomplete data", async () => {
  const root = await mkdtemp(join(tmpdir(), "gp-agent-empty-"));
  roots.push(root);
  const snapshot = await readAgentSnapshot(join(root, "missing"));
  expect(snapshot.errors.length).toBeGreaterThan(0);
  expect(createAgentTools(snapshot).call("get_environment").complete).toBe(
    false,
  );
  expect(await readdir(root)).toEqual([]);
});

it("rejects a tampered receipt even when its filename and JSON remain valid", async () => {
  const { root, request } = await fixtureFiles();
  const raw = JSON.parse(await readFile(request, "utf8"));
  raw.snapshot.lane.instance = 99;
  await writeFile(request, JSON.stringify(raw));
  const snapshot = await readAgentSnapshot(root);
  expect(snapshot.errors.length).toBeGreaterThan(0);
  expect(snapshot.requests).toEqual([]);
});

it("reports unreadable configuration and mismatched/invalid ledger files explicitly", async () => {
  const { root } = await fixtureFiles();
  await writeFile(join(root, "arknights.json"), "{");
  await writeFile(join(root, "task-runs", "invalid.json"), "{}");
  const snapshot = await readAgentSnapshot(root);
  expect(snapshot.profiles).toBeUndefined();
  expect(snapshot.errors.length).toBeGreaterThanOrEqual(2);
});
