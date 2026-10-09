export const faultCodes = [
  "skill-exception",
  "native-completion-missing",
  "foster-return-failed",
  "foster-scan-limit",
  "worker-run-timeout",
  "worker-rpc-timeout",
  "worker-native-timeout",
  "worker-exited",
] as const;
export type FaultCode = (typeof faultCodes)[number];
export type FailureCapture =
  | { status: "not-attempted" | "unavailable" }
  | {
      status: "stored";
      key: string;
      sha256: string;
      bytes: number;
      width: number;
      height: number;
      capturedAt: string;
    };
export interface FailureEvidence {
  version: 1;
  code: FaultCode;
  source: "runner" | "watchdog";
  runId: string;
  skillId?: string;
  observedAt: string;
  capture: FailureCapture;
}
export class TaskFaultError extends Error {
  constructor(
    public readonly faultCode: FaultCode,
    message: string,
  ) {
    super(message);
  }
}
const object = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  Boolean(
    v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.keys(v).every((k) => keys.includes(k)),
  );
const date = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(v) &&
  Number.isFinite(Date.parse(v));
export function validFailureEvidence(value: unknown): value is FailureEvidence {
  if (
    !object(value, [
      "version",
      "code",
      "source",
      "runId",
      "skillId",
      "observedAt",
      "capture",
    ]) ||
    value.version !== 1 ||
    !faultCodes.includes(value.code as FaultCode) ||
    !["runner", "watchdog"].includes(String(value.source)) ||
    typeof value.runId !== "string" ||
    !/^[A-Za-z0-9:._-]{1,160}$/.test(value.runId) ||
    (value.skillId !== undefined &&
      (typeof value.skillId !== "string" ||
        !/^[a-z0-9-]{1,80}$/.test(value.skillId))) ||
    !date(value.observedAt)
  )
    return false;
  if (
    typeof value.source !== "string" ||
    (value.source === "watchdog") !== String(value.code).startsWith("worker-")
  )
    return false;
  const c = value.capture;
  if (
    !object(c, [
      "status",
      "key",
      "sha256",
      "bytes",
      "width",
      "height",
      "capturedAt",
    ])
  )
    return false;
  if (c.status === "unavailable" || c.status === "not-attempted")
    return Object.keys(c).length === 1;
  return (
    c.status === "stored" &&
    value.source === "runner" &&
    typeof c.key === "string" &&
    /^[a-f0-9-]{36}\.png$/.test(c.key) &&
    typeof c.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(c.sha256) &&
    Number.isInteger(c.bytes) &&
    Number(c.bytes) > 0 &&
    Number(c.bytes) <= 8 * 1024 * 1024 &&
    [c.width, c.height].every(
      (n) => Number.isInteger(n) && Number(n) > 0 && Number(n) <= 16384,
    ) &&
    date(c.capturedAt) &&
    Date.parse(c.capturedAt) >= Date.parse(value.observedAt)
  );
}
