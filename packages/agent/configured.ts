import { createHash } from "node:crypto";
import { boundedRead } from "./read-file";
import { readRecordedHistory } from "./recorded";
import { join } from "node:path";
import { validateDeviceLanes } from "../protocol";
import { validateArknightsProfiles } from "../../games/arknights/config";
import {
  plannerProfile,
  plannerRoutine,
} from "../../games/agent-configuration";
import { AgentToolError, type AgentSnapshot } from "../protocol/agent";

export interface ConfiguredSnapshot {
  snapshot: AgentSnapshot;
  /** Host only: includes private-field changes, never passed to model tools. */
  fingerprint: string;
  /** Host only: raw account/settings bytes, independent of advancing task history. */
  configurationFingerprint?: string;
  /** Private host association, never copied into AgentSnapshot or model tools. */
  bindings?: { requestId: string; alias: string }[];
}
const names = ["device-lanes.json", "arknights.json"] as const;
/** Configuration-only by default; optional bounded history, never recovery or device probes. */
export async function readConfiguredSnapshot(
  directory: string,
  options: { history?: boolean } = {},
): Promise<ConfiguredSnapshot> {
  try {
    const read = () =>
      Promise.all(names.map((name) => boundedRead(join(directory, name))));
    const before = await read();
    const lanes = validateDeviceLanes(JSON.parse(before[0]));
    const profiles = validateArknightsProfiles(JSON.parse(before[1]));
    const ids = new Map(
      profiles.profiles.map((p, i) => [p.id, `profile-${i + 1}`]),
    );
    if (lanes.lanes.some((l) => !ids.has(l.arknights.profileId)))
      throw Error("unbound profile");
    const snapshot: AgentSnapshot = {
      source: "configured",
      capturedAt: new Date().toISOString(),
      historyAvailable: false,
      uidConfigured: Object.fromEntries(
        profiles.profiles.map((p) => [ids.get(p.id)!, Boolean(p.expectedUid)]),
      ),
      profiles: {
        version: 1,
        activeProfileId: ids.get(profiles.activeProfileId)!,
        profiles: profiles.profiles.map((p) =>
          plannerProfile(p, ids.get(p.id)!),
        ),
      },
      lanes: {
        version: 1,
        lanes: lanes.lanes.map((l, i) => ({
          id: `lane-${String.fromCharCode(97 + i)}`,
          name: `槽位 ${i + 1}`,
          managerPath: "",
          instance: l.instance,
          enabled: l.enabled,
          closeEmulatorAfterSuccess: false,
          arknights: {
            enabled: l.arknights.enabled,
            profileId: ids.get(l.arknights.profileId)!,
            routine: plannerRoutine(l.arknights.routine, "arknights"),
          },
          onmyoji: {
            enabled: l.onmyoji.enabled,
            routine: plannerRoutine(l.onmyoji.routine, "onmyoji"),
          },
        })),
      },
      requests: [],
      tasks: [],
      errors: [],
    };
    const recorded = options.history
      ? await readRecordedHistory(directory, lanes, profiles)
      : undefined;
    if (recorded) {
      snapshot.source = "recorded";
      snapshot.historyAvailable = true;
      snapshot.requests = recorded.requests;
      snapshot.tasks = recorded.tasks;
      snapshot.history = recorded.history;
      snapshot.incidentSignals = recorded.incidentSignals;
      snapshot.incidentFaults = recorded.incidentFaults;
      snapshot.recordedLogins = recorded.recordedLogins;
      snapshot.recordedResults = recorded.recordedResults;
      snapshot.recordedProgress = recorded.recordedProgress;
    }
    const after = await read();
    if (before.some((raw, i) => raw !== after[i])) throw Error("changed");
    return {
      snapshot,
      ...(recorded ? { bindings: recorded.bindings } : {}),
      fingerprint: createHash("sha256")
        .update(JSON.stringify([before, recorded?.fingerprint ?? null]))
        .digest("hex"),
      configurationFingerprint: createHash("sha256")
        .update(JSON.stringify(before))
        .digest("hex"),
    };
  } catch (error) {
    if (error instanceof AgentToolError && error.code === "HISTORY_UNAVAILABLE")
      throw error;
    throw new AgentToolError(
      "CONFIGURATION_UNAVAILABLE",
      "账号配置无法完整读取，请检查设置后重试",
    );
  }
}
