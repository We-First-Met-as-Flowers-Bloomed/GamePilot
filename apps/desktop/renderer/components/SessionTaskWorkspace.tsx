import { Activity, ChevronDown, ListChecks } from "lucide-react";
import type { GoalController } from "../hooks/useGoals";
import { sessionTaskState } from "../chat-workspace-state";
import { GoalCards } from "./GoalCards";

export default function SessionTaskWorkspace({
  sessionId,
  controller,
  onOpenExecution,
  onResume,
  focusGoalId,
}: {
  sessionId?: string;
  controller: GoalController;
  onOpenExecution: (id: string) => void;
  onResume: (id: string) => void;
  focusGoalId?: string;
}) {
  const state = sessionTaskState(sessionId, controller.state.goals);
  if (!sessionId || (!state.entries.length && !controller.error)) return null;
  const important = [...state.attention, ...state.active];
  if (!important.length && state.entries[0]) important.push(state.entries[0]);
  const history = state.entries.filter(
    (goal) => !important.some((entry) => entry.id === goal.id),
  );
  const subset = (entries: typeof history) => ({
    ...controller,
    error: "",
    state: { ...controller.state, goals: entries },
  });
  return (
    <section
      className="session-task-workspace"
      aria-label="本会话交办任务"
      data-session-id={sessionId}
      data-task-tone={state.tone}
    >
      <header>
        <span>
          <ListChecks size={16} aria-hidden="true" />
          本会话交办任务
        </span>
        <span role="status" aria-live="polite">
          {state.label}
        </span>
      </header>
      {controller.error && <p role="alert">{controller.error}</p>}
      {!!important.length && (
        <GoalCards
          sessionId={sessionId}
          controller={subset(important)}
          compact
          onOpenExecution={onOpenExecution}
          onResume={onResume}
          focusGoalId={focusGoalId}
        />
      )}
      {!!history.length && (
        <details className="session-task-history">
          <summary>
            <Activity size={14} aria-hidden="true" />
            结果与已停止任务 · {history.length}
            <ChevronDown size={14} aria-hidden="true" />
          </summary>
          <GoalCards
            sessionId={sessionId}
            controller={subset(history)}
            compact
            onOpenExecution={onOpenExecution}
            onResume={onResume}
            focusGoalId={focusGoalId}
          />
        </details>
      )}
    </section>
  );
}
