import { Activity, ChevronDown, ListChecks } from "lucide-react";
import type { GoalController } from "../hooks/useGoals";
import { sessionTaskState } from "../chat-workspace-state";
import { GoalCards } from "./GoalCards";
import "../task-panel.css";

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
  if (!sessionId) return null;
  const loading = controller.state.revision < 0 && !controller.error;
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
          {controller.state.revision < 0
            ? controller.available && !controller.error
              ? "读取中"
              : "尚未核实"
            : state.label}
        </span>
      </header>
      {controller.error && <p role="alert">{controller.error}</p>}
      {loading ? (
        <p className="helper" role="status" data-task-loading="true">
          {controller.available
            ? "正在读取宿主任务记录…"
            : "当前环境无法读取宿主任务记录，任务状态尚未核实。"}
        </p>
      ) : (
        controller.state.revision >= 0 && (
          <>
            <div className="session-task-summary" aria-label="本会话任务汇总">
              <span>
                需要处理<strong>{state.attention.length}</strong>
              </span>
              <span>
                运行中<strong>{state.active.length}</strong>
              </span>
              <span>
                已核验完成<strong>{state.completed.length}</strong>
              </span>
            </div>
            {!state.entries.length && !controller.error && (
              <div className="task-panel-empty" data-task-empty="true">
                <div
                  className="task-panel-empty-illustration"
                  aria-hidden="true"
                />
                <p>本会话还没有交办任务。</p>
                <p className="helper">任务受理与结果以宿主记录为准。</p>
              </div>
            )}
          </>
        )
      )}
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
