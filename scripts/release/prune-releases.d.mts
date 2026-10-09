export interface RetentionOptions {
  releaseRoot: string;
  keep?: string[];
  apply?: boolean;
}
export interface RetentionDirectory {
  path: string;
  resolvedPath: string;
  reparsePoint: boolean;
  treeHasReparsePoint: boolean;
  manifestVersion: string;
  manifestSha256: string;
  manifestFilesMatch: boolean;
}
export interface RetentionInventory {
  root: { path: string; resolvedPath: string; reparsePoint: boolean };
  releases: RetentionDirectory[];
  references: { complete: boolean; values: string[] };
}
export interface RetentionPlan {
  releaseRoot: string;
  inventoryPaths: string[];
  inventoryHashes: Record<string, string>;
  keep: string[];
  retained: { path: string; reasons: string[] }[];
  candidates: string[];
}
export interface RetentionPorts {
  read(options: RetentionOptions): Promise<RetentionInventory>;
  apply(plan: RetentionPlan): Promise<{ deleted: string[] }>;
}
export function planReleaseRetention(
  options: RetentionOptions,
  inventory: RetentionInventory,
): RetentionPlan;
export function pruneReleases(
  options: RetentionOptions,
  ports?: RetentionPorts,
): Promise<{
  mode: "preview" | "apply";
  plan: RetentionPlan;
  deleted: string[];
}>;
export function windowsRetentionPorts(
  execute?: (script: string, input: unknown) => Promise<unknown>,
): RetentionPorts;
