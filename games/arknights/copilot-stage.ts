import { asRecord } from "../../packages/protocol/struct";
import type { CopilotStage } from "../../packages/protocol/copilot";

/** Both pinned resource catalogs must agree on one normal stage ID. */
export function resolveCopilotStage(
  stages: unknown,
  tiles: unknown,
  code: string,
): CopilotStage | undefined {
  if (
    !Array.isArray(stages) ||
    !asRecord(tiles) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(code)
  )
    return;
  const candidates = stages
    .map(asRecord)
    .filter(
      (s) =>
        typeof s?.code === "string" &&
        s.code.toUpperCase() === code.toUpperCase(),
    );
  const ids = new Set(candidates.map((s) => s?.stageId));
  if (ids.size !== 1) return;
  const id = [...ids][0];
  if (typeof id !== "string" || !id || id.length > 128 || id.includes("#"))
    return;
  const maps = Object.values(tiles as Record<string, unknown>)
    .map(asRecord)
    .filter(
      (s) =>
        s?.stageId === id &&
        typeof s.code === "string" &&
        s.code.toUpperCase() === code.toUpperCase(),
    );
  if (maps.length !== 1 || typeof maps[0]?.levelId !== "string") return;
  // A shared levelId/code may also resolve to a challenge map in Tile.find().
  // Only the unambiguous normal stage ID is accepted in downloaded payloads.
  return { id, code: code.toUpperCase(), aliases: [id] };
}
