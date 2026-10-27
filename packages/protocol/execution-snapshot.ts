/**
 * Versioned view over the per-execution `snapshot` blob.
 *
 * Snapshots are append-only across versions: known sections are parsed and
 * typed, unknown keys are preserved in `raw` so newer producers never break
 * older readers. Parsing never mutates the stored record — fingerprints
 * (canonical over the raw snapshot) stay stable.
 */
import type { Plan } from "./index";
import type { ContinuationLink, ContinuationSelection } from "./continuation";
import { asRecord } from "./struct";

const GAME_IDS = ["arknights", "onmyoji"] as const;

/** Moved verbatim from games/execution-detail.ts (behaviour frozen). */
export function parseContinuationLink(
  value: unknown,
): ContinuationLink | undefined {
  const link = asRecord(value);
  if (
    !link ||
    typeof link.parentId !== "string" ||
    !/^[a-zA-Z0-9:._-]{1,160}$/.test(link.parentId) ||
    typeof link.parentFingerprint !== "string" ||
    link.parentFingerprint.length > 128 ||
    typeof link.acknowledgedPartial !== "boolean"
  )
    return undefined;
  const selections = (input: unknown): ContinuationSelection[] | undefined => {
    if (!Array.isArray(input) || input.length > 2) return undefined;
    const result: ContinuationSelection[] = [];
    for (const raw of input) {
      const entry = asRecord(raw);
      if (
        !entry ||
        !GAME_IDS.includes(entry.gameId as (typeof GAME_IDS)[number]) ||
        !Array.isArray(entry.skillIds) ||
        entry.skillIds.length > 32 ||
        entry.skillIds.some(
          (id) => typeof id !== "string" || !/^[a-zA-Z0-9._-]{1,80}$/.test(id),
        )
      )
        return undefined;
      result.push({
        gameId: entry.gameId as string,
        skillIds: [...entry.skillIds],
      });
    }
    return result;
  };
  const retained = selections(link.retained);
  const excluded = selections(link.excluded);
  if (!retained || !excluded) return undefined;
  return {
    parentId: link.parentId,
    parentFingerprint: link.parentFingerprint,
    retained,
    excluded,
    acknowledgedPartial: link.acknowledgedPartial,
  };
}

/** Moved verbatim from games/execution-detail.ts (behaviour frozen). */
export function parseFrozenPlan(value: unknown): Plan | undefined {
  const p = asRecord(value);
  if (
    !p ||
    typeof p.gameId !== "string" ||
    !p.gameId ||
    (p.mode !== "live" && p.mode !== "rehearsal") ||
    !Array.isArray(p.skillIds) ||
    !p.skillIds.length ||
    p.skillIds.length > 32 ||
    p.skillIds.some((id) => typeof id !== "string" || !id) ||
    new Set(p.skillIds).size !== p.skillIds.length
  )
    return undefined;
  return { gameId: p.gameId, mode: p.mode, skillIds: [...p.skillIds] };
}

export interface ExecutionSnapshotView {
  /** The untouched snapshot blob — fingerprints must hash this, never the view. */
  raw: Record<string, unknown>;
  schemaStatus: "legacy" | "current" | "unsupported" | "invalid";
  appVersion?: string;
  plan?: Plan;
  arknightsPlan?: Plan;
  onmyojiPlan?: Plan;
  continuation?: ContinuationLink;
  device?: { adbPath?: string; address?: string };
  lane?: Record<string, unknown>;
  profile?: Record<string, unknown>;
}

export const EXECUTION_SNAPSHOT_VERSION = 1;

/** Validate a new snapshot and stamp its schema without mutating the input. */
export function executionSnapshotForWrite(
  value: unknown,
): Record<string, unknown> {
  const view = parseExecutionSnapshot(value);
  if (
    !view ||
    (view.schemaStatus !== "legacy" && view.schemaStatus !== "current")
  )
    throw Error("执行快照格式或版本不受支持");
  return { ...view.raw, schemaVersion: EXECUTION_SNAPSHOT_VERSION };
}

/**
 * Typed view over a stored snapshot. Sections are optional: single-mode
 * requests carry plan/automation/device, lane cycles carry lanes/schedule/
 * agent, continuations carry continuation. Unknown sections are ignored by
 * the view but preserved in `raw`.
 */
export function parseExecutionSnapshot(
  value: unknown,
): ExecutionSnapshotView | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const version = raw.schemaVersion;
  const schemaStatus = !Object.hasOwn(raw, "schemaVersion")
    ? "legacy"
    : version === EXECUTION_SNAPSHOT_VERSION
      ? "current"
      : typeof version === "number" &&
          Number.isSafeInteger(version) &&
          version > 0
        ? "unsupported"
        : "invalid";
  const view: ExecutionSnapshotView = { raw, schemaStatus };
  if (schemaStatus === "unsupported" || schemaStatus === "invalid") return view;
  if (typeof raw.appVersion === "string") view.appVersion = raw.appVersion;
  const plan = parseFrozenPlan(raw.plan);
  if (plan) view.plan = plan;
  const arknightsPlan = parseFrozenPlan(raw.arknightsPlan);
  if (arknightsPlan) view.arknightsPlan = arknightsPlan;
  const onmyojiPlan = parseFrozenPlan(raw.onmyojiPlan);
  if (onmyojiPlan) view.onmyojiPlan = onmyojiPlan;
  const continuation = parseContinuationLink(raw.continuation);
  if (continuation) view.continuation = continuation;
  const device = asRecord(raw.device);
  if (device)
    view.device = {
      adbPath: typeof device.adbPath === "string" ? device.adbPath : undefined,
      address: typeof device.address === "string" ? device.address : undefined,
    };
  const lane = asRecord(raw.lane);
  if (lane) view.lane = lane;
  const profile = asRecord(raw.profile);
  if (profile) view.profile = profile;
  return view;
}
