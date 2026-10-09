export interface LaunchShortcut {
  path: string;
  targetPath: string;
  arguments: string;
  workingDirectory: string;
  iconLocation: string;
}
export interface LaunchPointerSnapshot {
  allowedShortcutPaths: string[];
  shortcuts: LaunchShortcut[];
  run?: string | null;
  systemRun?: { sid: string; value: string | null };
}
export interface LaunchPointerOptions {
  releaseRoot: string;
  releaseDirectory: string;
  apply?: boolean;
  desktopDirectories?: string[];
}
export interface LaunchPointerPlan {
  releaseRoot: string;
  releaseDirectory: string;
  targetPath: string;
  shortcuts: { before: LaunchShortcut; after: LaunchShortcut }[];
  run?: { before: string; after: string; localBefore?: string; sid?: string };
}
export interface LaunchPointerReport {
  mode: "check" | "apply";
  staleCount: number;
  updatedCount: number;
  entries: {
    path: string;
    targetPath: string;
    newTargetPath: string;
    status: "stale" | "updated";
  }[];
  run?: { status: "stale" | "updated" };
}
export interface LaunchPointerPorts {
  validateRelease(options: LaunchPointerOptions): Promise<void>;
  read(options: LaunchPointerOptions): Promise<LaunchPointerSnapshot>;
  apply(plan: LaunchPointerPlan): Promise<void>;
}
export function planLaunchPointerUpdates(
  options: LaunchPointerOptions,
  snapshot: LaunchPointerSnapshot,
): LaunchPointerPlan;
export function refreshLaunchPointers(
  options: LaunchPointerOptions,
  ports?: LaunchPointerPorts,
): Promise<LaunchPointerReport>;
export function windowsPorts(
  execute?: (script: string, input: unknown) => Promise<unknown>,
): LaunchPointerPorts;
