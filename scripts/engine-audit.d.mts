export interface EngineOptions {
  root?: string;
  bundle?: string;
  archive?: string;
  contractFile?: string;
  targetBundle?: string;
  targetArchive?: string;
  targetContract?: string;
}
export interface EngineReport {
  schemaVersion: 1;
  status: "blocked" | "ready-for-review";
  version: string | null;
  bundle: string | null;
  archive: string | null;
  contractSha256: string | null;
  archiveSha256: string | null;
  files: {
    path: string;
    sha256: string;
    archiveSha256: string;
    status: "matched" | "modified";
  }[];
  skills: {
    id: string;
    type: string;
    params: string[];
    parameterExpressions: Record<string, string>;
    parameterSources: Record<string, { source: string; line: number }[]>;
    source: string;
    line: number;
    certification: "pending-real-device";
    parameterStatus: "blocked" | "static-adapter-reviewed";
  }[];
  awardOptions: {
    key: string;
    supported: boolean;
    configKey: string | null;
    minVersion: string | null;
    certification: "pending-real-device" | "unsupported";
  }[];
  gaps: string[];
  limits: string[];
}
export interface EngineRollbackPlan {
  schemaVersion: 1;
  status: "blocked" | "ready-for-review";
  action: "manual-engine-switch";
  automaticOverwrite: false;
  current: EngineReport;
  target: EngineReport;
  changedFiles: string[];
  gaps: string[];
  steps: string[];
}
export function auditEngine(options?: EngineOptions): Promise<EngineReport>;
export function planEngineRollback(
  options: EngineOptions,
): Promise<EngineRollbackPlan>;
export function parseEngineArgs(
  args: string[],
): EngineOptions & { mode: "check" | "rollback" };
