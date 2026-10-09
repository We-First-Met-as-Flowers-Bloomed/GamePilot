import type { AgentToolName, CompiledDraft } from "./agent";

export const gameGoalToolNames = [
  "run_saved_daily",
  "run_plan",
  "read_goal",
  "inspect_goal",
  "wait_goal",
  "cancel_goal",
  "resume_goal",
  "resume_daily",
  "save_daily_preference",
] as const;
export type GameGoalToolName = (typeof gameGoalToolNames)[number];
export type AgentRuntimeToolName = AgentToolName | GameGoalToolName;
/** Only ChatService constructs this from an already-persisted, current user turn. */
export interface AgentRuntimePrincipal {
  sessionId: string;
  turnId: string;
  prompt: string;
}
export interface AgentRuntimeToolBinding {
  specs: { name: string; description: string; inputSchema: unknown }[];
  call(
    name: string,
    args: unknown,
    context: { callId: string; signal: AbortSignal },
  ): Promise<unknown>;
  compiled(draft: CompiledDraft | undefined): void;
  goalIds(): string[];
  changedPreferences?(): boolean;
}
