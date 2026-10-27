import { sha256 } from "./sha256";

export const onmyojiIdentityPackages = [
  "com.netease.onmyoji",
  "com.netease.onmyoji.wyzymnqsd_cps",
] as const;

export interface OnmyojiIdentityBinding {
  roleId: string;
  /** Optional display note; the own-avatar settings page exposes UID, not server. */
  serverName?: string;
}
export interface OnmyojiRuntimeConfig {
  identity?: OnmyojiIdentityBinding;
}
export interface OnmyojiIdentityEvidence {
  version: 1;
  certification: "experimental" | "profile-uid-v1";
  status: "unconfigured" | "unknown" | "mismatch" | "matched";
  reason: string;
  candidateMatch: boolean;
  expected?: OnmyojiIdentityBinding;
  device?: { adbPath: string; address: string };
  packageName?: (typeof onmyojiIdentityPackages)[number];
  startedAt: string;
  observedAt: string;
  frames: { observedAt: string; identity?: OnmyojiIdentityBinding }[];
  courtyardFrames?: string[];
}
import { recordWithKeys } from "./struct";

export const onmyojiIdentityReasons = [
  "unconfigured",
  "device-not-connected",
  "device-changed",
  "package-unavailable",
  "package-not-running",
  "profile-anchor-missing",
  "sampling-interval",
  "anchors-not-certified",
  "identity-mismatch",
  "observation-timeout",
  "observation-failed",
  "identity-matched",
  "courtyard-anchor-missing",
  "profile-return-failed",
] as const;
const text = (value: unknown, maximum: number): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= maximum &&
  !/[\x00-\x1f\x7f-\x9f]/.test(value);
export function validateOnmyojiIdentityBinding(
  value: unknown,
): OnmyojiIdentityBinding {
  const input = recordWithKeys(value, ["roleId", "serverName"]);
  if (
    !input ||
    !text(input.roleId, 128) ||
    (input.serverName !== undefined && !text(input.serverName, 80))
  )
    throw Error("阴阳师身份绑定无效");
  // Opaque strings: no numeric conversion, guessed digit length or nickname fallback.
  return {
    roleId: input.roleId,
    ...(input.serverName === undefined ? {} : { serverName: input.serverName }),
  };
}
export function validateOnmyojiConfig(value: unknown): OnmyojiRuntimeConfig {
  const input = recordWithKeys(value, ["identity"]);
  if (!input) throw Error("阴阳师运行配置无效");
  return input.identity === undefined
    ? {}
    : { identity: validateOnmyojiIdentityBinding(input.identity) };
}
export function sameOnmyojiIdentity(
  left?: OnmyojiIdentityBinding,
  right?: OnmyojiIdentityBinding,
): boolean {
  return (
    left?.roleId === right?.roleId && left?.serverName === right?.serverName
  );
}

/** Planner snapshots bind both identity fields without disclosing account text. */
export function plannerOnmyojiIdentity(
  binding?: OnmyojiIdentityBinding,
): OnmyojiIdentityBinding | undefined {
  return binding === undefined
    ? undefined
    : {
        roleId: `binding-v1:${sha256(JSON.stringify([binding.roleId, binding.serverName]))}`,
        serverName: "opaque-binding-v1",
      };
}
const date = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
export function validOnmyojiIdentityEvidence(
  value: unknown,
): value is OnmyojiIdentityEvidence {
  const input = recordWithKeys(value, [
    "version",
    "certification",
    "status",
    "reason",
    "candidateMatch",
    "expected",
    "device",
    "packageName",
    "startedAt",
    "observedAt",
    "frames",
    "courtyardFrames",
  ]);
  if (
    !input ||
    input.version !== 1 ||
    !["experimental", "profile-uid-v1"].includes(String(input.certification)) ||
    !["unconfigured", "unknown", "mismatch", "matched"].includes(
      String(input.status),
    ) ||
    !onmyojiIdentityReasons.includes(
      input.reason as (typeof onmyojiIdentityReasons)[number],
    ) ||
    typeof input.candidateMatch !== "boolean" ||
    !date(input.startedAt) ||
    !date(input.observedAt) ||
    Date.parse(input.observedAt) < Date.parse(input.startedAt) ||
    !Array.isArray(input.frames) ||
    input.frames.length > 2
  )
    return false;
  try {
    if (input.expected !== undefined)
      validateOnmyojiIdentityBinding(input.expected);
    if (input.device !== undefined) {
      const device = recordWithKeys(input.device, ["adbPath", "address"]);
      if (!device || !text(device.adbPath, 4096) || !text(device.address, 1024))
        return false;
    }
    if (
      input.packageName !== undefined &&
      !onmyojiIdentityPackages.includes(
        input.packageName as (typeof onmyojiIdentityPackages)[number],
      )
    )
      return false;
    let prior = Date.parse(input.startedAt);
    for (const raw of input.frames) {
      const frame = recordWithKeys(raw, ["observedAt", "identity"]);
      if (
        !frame ||
        !date(frame.observedAt) ||
        Date.parse(frame.observedAt) < prior ||
        Date.parse(frame.observedAt) > Date.parse(input.observedAt)
      )
        return false;
      if (frame.identity !== undefined)
        validateOnmyojiIdentityBinding(frame.identity);
      prior = Date.parse(frame.observedAt);
    }
    if (
      input.frames.length &&
      (!input.device ||
        !onmyojiIdentityPackages.includes(
          input.packageName as (typeof onmyojiIdentityPackages)[number],
        ))
    )
      return false;
    const evidence = input as unknown as OnmyojiIdentityEvidence;
    if (evidence.certification === "profile-uid-v1") {
      if (
        !evidence.expected ||
        !Array.isArray(evidence.courtyardFrames) ||
        evidence.courtyardFrames.length > 2
      )
        return false;
      let previous = evidence.frames.at(-1)?.observedAt ?? evidence.startedAt;
      for (const at of evidence.courtyardFrames) {
        if (
          !date(at) ||
          Date.parse(at) <= Date.parse(previous) ||
          Date.parse(at) > Date.parse(evidence.observedAt)
        )
          return false;
        previous = at;
      }
      if (evidence.status === "mismatch")
        return (
          !evidence.candidateMatch &&
          evidence.reason === "identity-mismatch" &&
          evidence.frames.some(
            (frame) =>
              frame.identity &&
              frame.identity.roleId !== evidence.expected!.roleId,
          )
        );
      if (evidence.status === "unknown")
        return (
          !evidence.candidateMatch &&
          ![
            "identity-matched",
            "identity-mismatch",
            "unconfigured",
            "anchors-not-certified",
          ].includes(evidence.reason)
        );
      const gap = (values: string[]) =>
        values.length === 2 &&
        Date.parse(values[1]) - Date.parse(values[0]) >= 600 &&
        Date.parse(values[1]) - Date.parse(values[0]) <= 10_000;
      return (
        evidence.status === "matched" &&
        evidence.reason === "identity-matched" &&
        evidence.candidateMatch &&
        evidence.device !== undefined &&
        evidence.packageName !== undefined &&
        /^\d+$/.test(evidence.expected.roleId) &&
        Date.parse(evidence.observedAt) - Date.parse(evidence.startedAt) <=
          45_000 &&
        gap(evidence.frames.map((frame) => frame.observedAt)) &&
        gap(evidence.courtyardFrames) &&
        evidence.frames.every(
          (frame) => frame.identity?.roleId === evidence.expected!.roleId,
        )
      );
    }
    if (
      (evidence.packageName !== undefined &&
        evidence.packageName !== "com.netease.onmyoji") ||
      evidence.status === "matched" ||
      evidence.courtyardFrames !== undefined ||
      [
        "identity-matched",
        "courtyard-anchor-missing",
        "profile-return-failed",
      ].includes(evidence.reason)
    )
      return false;
    if (evidence.status === "unconfigured")
      return (
        evidence.reason === "unconfigured" &&
        !evidence.expected &&
        !evidence.candidateMatch &&
        evidence.frames.length === 0
      );
    if (!evidence.expected) return false;
    if (evidence.status === "mismatch")
      return (
        !evidence.candidateMatch &&
        evidence.reason === "identity-mismatch" &&
        evidence.frames.some(
          (frame) =>
            frame.identity &&
            !sameOnmyojiIdentity(evidence.expected, frame.identity),
        )
      );
    if (
      evidence.reason === "identity-mismatch" ||
      evidence.reason === "unconfigured"
    )
      return false;
    if (evidence.candidateMatch) {
      const interval =
        evidence.frames.length === 2
          ? Date.parse(evidence.frames[1].observedAt) -
            Date.parse(evidence.frames[0].observedAt)
          : 0;
      return (
        evidence.reason === "anchors-not-certified" &&
        evidence.frames.length === 2 &&
        interval >= 600 &&
        interval <= 1500 &&
        Date.parse(evidence.observedAt) - Date.parse(evidence.startedAt) <=
          5000 &&
        evidence.frames.every(
          (frame) =>
            frame.identity &&
            sameOnmyojiIdentity(frame.identity, evidence.expected),
        )
      );
    }
    return true;
  } catch {
    return false;
  }
}
/** This projection alone may enter model-facing output. Role IDs and device paths stay local. */
export function publicOnmyojiIdentityInspection(
  value: OnmyojiIdentityEvidence,
) {
  if (!validOnmyojiIdentityEvidence(value))
    throw Error("阴阳师身份核对记录无效");
  return {
    status:
      value.status === "matched"
        ? ("matched" as const)
        : value.status === "mismatch"
          ? ("mismatch" as const)
          : ("unknown" as const),
    configured: value.expected !== undefined,
    certified:
      value.status === "matched" && value.certification === "profile-uid-v1",
    reason: value.reason,
    observedAt: value.observedAt,
  };
}
export function unconfiguredOnmyojiIdentityEvidence(
  now = Date.now(),
): OnmyojiIdentityEvidence {
  const at = new Date(now).toISOString();
  return {
    version: 1,
    certification: "experimental",
    status: "unconfigured",
    reason: "unconfigured",
    candidateMatch: false,
    startedAt: at,
    observedAt: at,
    frames: [],
  };
}

export type OnmyojiIdentityInspection = ReturnType<
  typeof publicOnmyojiIdentityInspection
>;
