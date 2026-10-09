export function assertIsolatedRuntimeTarget(
  directory: string,
  root?: string,
): Promise<void>;
export function setupDshRuntime(options?: {
  target?: string;
  nodePath?: string;
  nodeLicense?: string;
  npmPath?: string;
  install?: boolean;
}): Promise<{
  directory: string;
  schemaVersion: number;
  dshVersion: string;
  reviewedSourceCommit: string;
  lockSha256: string;
  node: { version: string; binarySha256: string; licenseSha256: string };
  installedPackages: number;
}>;
