import { agentDate } from "../../../packages/protocol/agent";
import type {
  PlannerViewState,
  PlannerSource,
} from "../../../packages/protocol/agent-planner";
export function defaultPlannerTime(now = new Date()) {
  const beijing = new Date(now.getTime() + 8 * 3600000);
  if (beijing.getUTCHours() >= 8) beijing.setUTCDate(beijing.getUTCDate() + 1);
  return beijing.toISOString().slice(0, 10) + "T08:00";
}
export function plannerTime(local: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return undefined;
  try {
    return agentDate(local + ":00+08:00");
  } catch {
    return undefined;
  }
}
export function draftMatchesInput(
  state: PlannerViewState,
  prompt: string,
  local: string,
  source: PlannerSource = "fixture",
) {
  return (
    state.prompt === prompt.trim() &&
    state.at === plannerTime(local) &&
    (state.source ?? "fixture") === source
  );
}
export function plannerLocalTime(at: string) {
  return new Date(new Date(at).getTime() + 8 * 3600000)
    .toISOString()
    .slice(0, 16);
}
