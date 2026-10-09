export const startupFaultLabels = {
  "mumu-state-unavailable": "无法确认 MuMu 实例状态",
  "mumu-launch-failed": "MuMu 启动失败",
  "mumu-boot-timeout": "等待 Android 启动超时",
  "mumu-stopping-timeout": "等待 MuMu 原实例停止超时",
  "mumu-startup-interrupted": "MuMu 启动被停止过程打断",
} as const;
export interface StartupFault {
  version: 1;
  source: "startup";
  code: keyof typeof startupFaultLabels;
  observedAt: string;
}
export class StartupFaultError extends Error {
  readonly fault: StartupFault;
  constructor(code: StartupFault["code"], message: string, cause?: unknown) {
    super(message, { cause });
    this.fault = {
      version: 1,
      source: "startup",
      code,
      observedAt: new Date().toISOString(),
    };
  }
}
export function startupFaultFrom(error: unknown): StartupFault | undefined {
  return error instanceof StartupFaultError ? { ...error.fault } : undefined;
}
export function validStartupFault(fault: unknown): fault is StartupFault {
  if (!fault || typeof fault !== "object" || Array.isArray(fault)) return false;
  const f = fault as Record<string, unknown>;
  return (
    Object.keys(f).length === 4 &&
    Object.keys(f).every((k) =>
      ["version", "source", "code", "observedAt"].includes(k),
    ) &&
    f.version === 1 &&
    f.source === "startup" &&
    typeof f.code === "string" &&
    Object.hasOwn(startupFaultLabels, f.code) &&
    typeof f.observedAt === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(
      f.observedAt,
    ) &&
    Number.isFinite(Date.parse(f.observedAt))
  );
}
export function validStartupFaultAssociation(record: {
  startupFault?: unknown;
  status: string;
  startedAt: string;
  finishedAt?: string;
}) {
  return (
    record.startupFault === undefined ||
    (validStartupFault(record.startupFault) &&
      ["failed", "unknown"].includes(record.status) &&
      !!record.finishedAt &&
      Date.parse(record.startupFault.observedAt) >=
        Date.parse(record.startedAt) &&
      Date.parse(record.startupFault.observedAt) <=
        Date.parse(record.finishedAt))
  );
}
