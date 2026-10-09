export interface DshRuntimeBuildInfo {
  schemaVersion: number;
  dshVersion: string;
  reviewedSourceCommit: string;
  lockSha256: string;
  node: { version: string; binarySha256: string; licenseSha256: string };
  installedPackages: number;
}
export function validateDshRuntime(
  directory: string,
): Promise<DshRuntimeBuildInfo>;
export function portableDshEntry(relativePath: string): boolean;
export function copyDshRuntime(
  source: string,
  destination: string,
): Promise<DshRuntimeBuildInfo>;
