export interface CliLane {
  id: string;
  instance?: number;
  enabled?: boolean;
  arknights?: { enabled: boolean };
  onmyoji?: { enabled: boolean };
  legacyBinding?: { laneId: string; instance?: number; scope?: string };
}
export function selectCliLane<T extends CliLane>(
  lanes: T[],
  argument: string,
  game?: "arknights" | "onmyoji",
): T;
export function selectCliCombos(
  lanes: CliLane[],
  argument?: string,
  game?: "all" | "arknights" | "onmyoji",
): { lane: string; game: "arknights" | "onmyoji" }[];
export function addressForLane(
  lane: {
    instance?: number;
    deviceInstances?: { arknights?: number; onmyoji?: number };
  },
  game?: "arknights" | "onmyoji",
): string;
export function selectCliDevice<T extends { address: string }>(
  devices: T[],
  address: string,
): T;
export interface SurveyArgs {
  lane: string;
  label: string;
  taps: [number, number][];
  waitMs: number;
  ocr: string;
  launch: boolean;
}
export function parseSurveyArgs(args: string[]): SurveyArgs;
export function assertCliOptions(
  args: string[],
  values: string[],
  flags: string[],
): void;
