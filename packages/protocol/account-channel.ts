import type { DeviceLane } from "./index";
import type { ExecutionRecord } from "./execution";
import type { TaskRecord } from "./task-record";
import { parseExecutionSnapshot } from "./execution-snapshot";
import { arknights } from "../../games/arknights";
import { onmyoji } from "../../games/onmyoji";

export type ChannelGame = "arknights" | "onmyoji";
const games: ChannelGame[] = ["arknights", "onmyoji"];
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export function channelGame(lane: DeviceLane): ChannelGame | undefined {
  return lane.arknights.enabled === lane.onmyoji.enabled
    ? undefined
    : lane.arknights.enabled
      ? "arknights"
      : "onmyoji";
}
export function channelHistoryLaneIds(lane: DeviceLane): string[] {
  return [
    ...new Set([
      lane.id,
      ...(lane.legacyBinding ? [lane.legacyBinding.laneId] : []),
    ]),
  ];
}
export function legacyLaneScope(lane: DeviceLane): string {
  return JSON.stringify([
    lane.managerPath.toLowerCase().replaceAll("\\", "/"),
    lane.instance,
    lane.arknights.enabled ? lane.arknights.profileId : "",
    lane.onmyoji.enabled,
  ]);
}
/** Browser-safe equivalent of the Windows normalization used by device admission. */
export function canonicalChannelDeviceKey(
  managerPath: string,
  instance: number,
): string {
  if (!managerPath.trim()) return "*";
  const path = managerPath.replaceAll("/", "\\");
  if (!path.startsWith("\\") && !/^[a-z]:\\/i.test(path)) return "*";
  let rest = path;
  let root = "";
  let absolute = false;
  const drive = /^([a-z]:)(\\)?/i.exec(path);
  const unc = /^\\\\([^\\]+)\\+([^\\]+)(?:\\+|$)/.exec(path);
  if (drive) {
    absolute = drive[2] !== undefined;
    root = drive[1] + (absolute ? "\\" : "");
    rest = path.slice(drive[0].length);
  } else if (unc) {
    absolute = true;
    root = `\\\\${unc[1]}\\${unc[2]}\\`;
    rest = path.slice(unc[0].length);
  } else if (path.startsWith("\\")) {
    absolute = true;
    root = "\\";
    rest = path.slice(1);
  }
  const segments: string[] = [];
  for (const segment of rest.split("\\")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length && segments.at(-1) !== "..") segments.pop();
      else if (!absolute) segments.push(segment);
    } else segments.push(segment);
  }
  let normalized = root + (segments.join("\\") || (absolute ? "" : "."));
  if (path.endsWith("\\") && !normalized.endsWith("\\")) normalized += "\\";
  return `mumu:${normalized.toLowerCase()}#${instance}`;
}
function sameResource(resource: string, lane: DeviceLane): boolean {
  const match = /^mumu:(.+)#(\d+)$/i.exec(resource);
  return (
    !!match &&
    canonicalChannelDeviceKey(match[1], Number(match[2])) ===
      canonicalChannelDeviceKey(lane.managerPath, lane.instance)
  );
}
function originalResourceMatches(
  request: ExecutionRecord,
  lane: DeviceLane,
): boolean {
  const original = object(request.snapshot.lane);
  if (
    typeof original?.managerPath !== "string" ||
    typeof original.instance !== "number"
  )
    return false;
  const resource = canonicalChannelDeviceKey(
    original.managerPath,
    original.instance,
  );
  return (
    resource === "*" ||
    resource === canonicalChannelDeviceKey(lane.managerPath, lane.instance)
  );
}

/** Undefined means missing or contradictory scope, never permission to ignore history. */
function requestGames(request: ExecutionRecord): ChannelGame[] | undefined {
  const view = parseExecutionSnapshot(request.snapshot);
  if (!view || !["legacy", "current"].includes(view.schemaStatus))
    return undefined;
  const result: ChannelGame[] = [];
  for (const key of ["plan", "arknightsPlan", "onmyojiPlan"]) {
    if (request.snapshot[key] === undefined) continue;
    const plan = object(request.snapshot[key]);
    if (
      !plan ||
      !games.includes(plan.gameId as ChannelGame) ||
      (key !== "plan" && key !== `${plan.gameId}Plan`) ||
      !["live", "rehearsal"].includes(String(plan.mode)) ||
      !Array.isArray(plan.skillIds) ||
      !plan.skillIds.length ||
      plan.skillIds.length > 32 ||
      plan.skillIds.some(
        (id) =>
          !(plan.gameId === "arknights" ? arknights : onmyoji).skills.some(
            (skill) => skill.id === id,
          ),
      ) ||
      new Set(plan.skillIds).size !== plan.skillIds.length
    )
      return undefined;
    result.push(plan.gameId as ChannelGame);
  }
  const slot = object(request.snapshot.gameSlot);
  if (
    request.snapshot.gameSlot !== undefined &&
    (!slot ||
      slot.laneId !== request.laneId ||
      !games.includes(slot.gameId as ChannelGame) ||
      !result.length ||
      result.some((game) => game !== slot.gameId))
  )
    return undefined;
  const original = object(request.snapshot.lane);
  if (
    original &&
    games.some(
      (game) =>
        object(original[game])?.enabled === true && !result.includes(game),
    )
  )
    return undefined;
  return result.length ? [...new Set(result)] : undefined;
}

/** Read-only lineage, not proof of completion, matching settings, or replay permission. */
export function channelOwnsHistoryRequest(
  request: ExecutionRecord,
  lane: DeviceLane,
): boolean {
  const ids = channelHistoryLaneIds(lane);
  const original = object(request.snapshot.lane);
  if (
    !request.laneId ||
    !ids.includes(request.laneId) ||
    (original?.id !== undefined && original.id !== request.laneId)
  )
    return false;
  const game = channelGame(lane);
  return !game || requestGames(request)?.includes(game) === true;
}

/** Physical ownership always wins; lineage is narrowed only by frozen game plans. */
export function requestMayAffectChannel(
  request: ExecutionRecord,
  lane: DeviceLane,
): boolean {
  if (
    canonicalChannelDeviceKey(lane.managerPath, lane.instance) === "*" ||
    request.resources.some(
      (resource) => resource === "*" || sameResource(resource, lane),
    ) ||
    originalResourceMatches(request, lane)
  )
    return true;
  const original = object(request.snapshot.lane);
  const ids = channelHistoryLaneIds(lane);
  if (
    !(request.laneId && ids.includes(request.laneId)) &&
    !(typeof original?.id === "string" && ids.includes(original.id))
  )
    return false;
  const game = channelGame(lane);
  const declared = requestGames(request);
  return !game || !declared || declared.includes(game);
}

export function taskMayAffectChannel(
  task: TaskRecord,
  lane: DeviceLane,
  request?: ExecutionRecord,
): boolean {
  if (request && requestMayAffectChannel(request, lane)) return true;
  if (
    task.instance === lane.instance ||
    (task.laneId === undefined && task.instance === undefined)
  )
    return true;
  if (!task.laneId || !channelHistoryLaneIds(lane).includes(task.laneId))
    return false;
  const game = channelGame(lane);
  return !game || task.plan?.gameId !== task.gameId || task.gameId === game;
}
