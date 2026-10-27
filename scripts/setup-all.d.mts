export type SetupScope = "all" | "public" | "private";
export interface SetupOptions {
  root?: string;
  scope?: SetupScope;
  platform?: string;
  arch?: string;
  nodeVersion?: string;
  dshNode?: string;
  dshLicense?: string;
  dshRuntime?: string;
  run?: (
    command: string,
    args: string[],
    options?: {
      cwd?: string;
      inherit?: boolean;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<string>;
  archiveEntries?: (path: string) => Promise<Record<string, string>>;
}
export interface SetupCheck {
  id: string;
  status: "passed" | "missing" | "invalid" | "not-checked";
  message: string;
  remediation: string;
}
export interface SetupReport {
  schemaVersion: 1;
  mode: "check";
  scope: SetupScope;
  complete: boolean;
  checks: SetupCheck[];
  limits: string[];
}
export const SETUP_PINS: Readonly<{
  node: string;
  npm: string;
  dotnet: string;
}>;
export const OCR_HASHES: Readonly<Record<string, string>>;
export const ONMYOJI_TEMPLATES: readonly string[];
export function digestFile(path: string): Promise<string>;
export function parseSetupArgs(args: string[]): SetupOptions & {
  mode: "check" | "install";
  scope: SetupScope;
  json: boolean;
};
export function checkEnvironment(options?: SetupOptions): Promise<SetupReport>;
export function installEnvironment(options?: SetupOptions): Promise<void>;
