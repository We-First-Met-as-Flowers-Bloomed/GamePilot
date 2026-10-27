import type { ExecutionRecord } from "./execution";
import { asRecord } from "./struct";
import { normalizeAbsoluteWindowsPath } from "./windows-path";

/** Worker process observations are lifecycle evidence, separate from frozen request hashes. */
export interface GameExitObservation {
  version: 1;
  kind: "game-exit";
  gameId: string;
  method: "adb-process-check";
  executionId: string;
  fingerprint: string;
  laneId?: string;
  batchId?: string;
  device: { adbPath: string; address: string };
  physicalResource?: string;
  packageName: string;
  firstObservedAt: string;
  observedAt: string;
  notRunning: [true, true];
}
export type WorkerExitObservation = Omit<
  GameExitObservation,
  "executionId" | "fingerprint" | "laneId" | "batchId" | "physicalResource"
>;

export function frozenMuMuResource(
  snapshot: Record<string, unknown>,
): string | undefined {
  const lane = asRecord(snapshot.lane);
  if (typeof lane?.managerPath !== "string" || !Number.isInteger(lane.instance))
    return;
  try {
    return `mumu:${normalizeAbsoluteWindowsPath(lane.managerPath).toLowerCase()}#${lane.instance}`;
  } catch {
    return;
  }
}

function matchesDevice(
  v: Record<string, unknown>,
  request: ExecutionRecord,
): boolean {
  const device = asRecord(v.device),
    lane = asRecord(request.snapshot.lane);
  if (
    !device ||
    typeof device.adbPath !== "string" ||
    typeof device.address !== "string" ||
    !device.address
  )
    return false;
  const resource = frozenMuMuResource(request.snapshot);
  if (resource && typeof lane?.managerPath === "string") {
    try {
      const manager = normalizeAbsoluteWindowsPath(lane.managerPath);
      const adb = manager.slice(0, manager.lastIndexOf("\\") + 1) + "adb.exe";
      return (
        v.physicalResource === resource &&
        request.resources.includes(resource) &&
        normalizeAbsoluteWindowsPath(device.adbPath).toLowerCase() ===
          adb.toLowerCase() &&
        /^127\.0\.0\.1:\d{1,5}$/.test(device.address) &&
        Number(device.address.split(":")[1]) >= 1 &&
        Number(device.address.split(":")[1]) <= 65535
      );
    } catch {
      return false;
    }
  }
  const expected = lane ?? asRecord(request.snapshot.device);
  return (
    !!expected &&
    device.adbPath === expected.adbPath &&
    device.address === expected.address
  );
}

export function validExitObservation(
  value: unknown,
  request: ExecutionRecord,
): value is GameExitObservation {
  const v = asRecord(value);
  const device = asRecord(v?.device);
  const lane = asRecord(request.snapshot.lane);
  const first = Date.parse(String(v?.firstObservedAt ?? "")),
    last = Date.parse(String(v?.observedAt ?? ""));
  return (
    !!v &&
    v.version === 1 &&
    v.kind === "game-exit" &&
    v.method === "adb-process-check" &&
    typeof v.gameId === "string" &&
    /^[a-z][a-z0-9-]{0,63}$/.test(v.gameId) &&
    v.executionId === request.id &&
    v.fingerprint === request.fingerprint &&
    v.laneId === request.laneId &&
    v.batchId === request.batchId &&
    !!device &&
    typeof device.adbPath === "string" &&
    !!device.adbPath &&
    typeof device.address === "string" &&
    !!device.address &&
    matchesDevice(v, request) &&
    typeof v.packageName === "string" &&
    /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+$/.test(v.packageName) &&
    Array.isArray(v.notRunning) &&
    v.notRunning.length === 2 &&
    v.notRunning.every((flag) => flag === true) &&
    first >= Date.parse(request.startedAt) &&
    last - first >= 250 &&
    last - first <= 5000 &&
    (!request.finishedAt || last <= Date.parse(request.finishedAt))
  );
}
