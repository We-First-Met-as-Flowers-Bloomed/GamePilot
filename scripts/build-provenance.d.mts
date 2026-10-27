export interface SourceState {
  commit?: string;
  tree?: string;
  clean: boolean;
}
export interface BuildProvenance {
  version: 1;
  appVersion: string;
  sourceCommit?: string;
  sourceTree?: string;
  clean: boolean;
  builtAt: string;
  files: Record<string, string>;
}
export function sourceState(root: string): SourceState;
export function writeBuildProvenance(
  root: string,
  before: SourceState,
): Promise<BuildProvenance>;
export function validateBuild(
  directory: string,
  expected: { appVersion: string; sourceCommit?: string; sourceTree?: string },
): Promise<BuildProvenance>;
