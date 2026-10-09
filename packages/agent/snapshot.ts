import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { canonical, readEvidence } from "../acceptance/files";
import { validateDeviceLanes } from "../protocol";
import { validateArknightsProfiles } from "../../games/arknights/config";
import type { AgentSnapshot } from "../protocol/agent";
import type { ExecutionRecord } from "../protocol/execution";
import { validStartupFaultAssociation } from "../protocol/startup-fault";

export function validReceipt(r: ExecutionRecord) {
  if (
    !validStartupFaultAssociation(r) ||
    !Array.isArray(r.resources) ||
    r.resources.length < 1 ||
    r.resources.length > 16 ||
    r.resources.some((s) => typeof s !== "string" || !s || s.length > 1024) ||
    (r.laneId !== undefined && typeof r.laneId !== "string") ||
    (r.batchId !== undefined && typeof r.batchId !== "string") ||
    typeof r.fingerprint !== "string" ||
    typeof r.message !== "string" ||
    (r.finishedAt && Date.parse(r.finishedAt) < Date.parse(r.startedAt))
  )
    return false;
  const { startedAt: _admissionTime, ...snapshot } = r.snapshot;
  const value = {
    id: r.id,
    source: r.source,
    resources: [...new Set(r.resources)].sort(),
    snapshot,
    ...(r.laneId ? { laneId: r.laneId } : {}),
    ...(r.batchId ? { batchId: r.batchId } : {}),
  };
  return (
    createHash("sha256").update(canonical(value)).digest("hex") ===
    r.fingerprint
  );
}

/** Only fs reads. No store.load, recovery, mkdir, device discovery or native imports. */
export async function readAgentSnapshot(
  directory: string,
): Promise<AgentSnapshot> {
  const snapshot: AgentSnapshot = {
    source: "disk",
    capturedAt: new Date().toISOString(),
    requests: [],
    tasks: [],
    errors: [],
  };
  const originals = new Map<string, string>();
  async function config<T>(name: string, validate: (v: unknown) => T) {
    try {
      const file = join(directory, name);
      if ((await stat(file)).size > 1024 * 1024) throw Error("oversized");
      const raw = await readFile(file, "utf8");
      originals.set(name, raw);
      return validate(JSON.parse(raw));
    } catch {
      snapshot.errors.push(`${name} 读取或校验失败`);
      return undefined;
    }
  }
  [snapshot.lanes, snapshot.profiles] = await Promise.all([
    config("device-lanes.json", validateDeviceLanes),
    config("arknights.json", validateArknightsProfiles),
  ]);
  for (const name of ["execution-requests", "task-runs"]) {
    try {
      if (!(await stat(join(directory, name))).isDirectory())
        throw Error("not-directory");
    } catch {
      snapshot.errors.push(`${name} 目录缺失或不可读取`);
    }
  }
  const evidence = await readEvidence(directory);
  snapshot.tasks = evidence.tasks;
  snapshot.errors.push(...evidence.errors);
  snapshot.requests = evidence.requests.filter((r) => {
    if (validReceipt(r)) return true;
    snapshot.errors.push("执行请求字段或指纹不一致");
    return false;
  });
  // Detect config changes while collecting. This is a read observation, not an atomic live snapshot.
  for (const [name, before] of originals) {
    try {
      if ((await readFile(join(directory, name), "utf8")) !== before)
        snapshot.errors.push("采集期间配置变化，请重新查询");
    } catch {
      snapshot.errors.push("采集期间配置不可读取，请重新查询");
    }
  }
  snapshot.capturedAt = new Date().toISOString();
  return snapshot;
}
