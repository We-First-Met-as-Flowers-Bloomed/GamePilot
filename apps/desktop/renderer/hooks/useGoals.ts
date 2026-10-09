import { useEffect, useRef, useState } from "react";
import type { DesktopAPI } from "../../../../packages/protocol";
import type {
  GoalRun,
  GoalView,
} from "../../../../packages/protocol/agent-goal";

/** Optional methods preserve old preview APIs without creating fake goal state. */
export interface GoalClientAPI {
  goalSnapshot?(sessionId?: string): Promise<GoalView>;
  onGoalState?(listener: (view: GoalView) => void): () => void;
  cancelGoal?(input: { goalId: string; sessionId: string }): Promise<GoalRun>;
}
/** Subscribe before reading. Goal events drive updates; game ticks never trigger model calls. */
export function watchGoalState(
  api: GoalClientAPI,
  sessionId: string,
  receive: (view: GoalView) => void,
  connection: (message: string) => void,
) {
  if (typeof api.goalSnapshot !== "function") return () => {};
  let closed = false,
    revision = -1,
    deliveries = 0;
  const accept = (view: GoalView) => {
    if (closed) return;
    deliveries++;
    connection("");
    if (view.revision <= revision) return;
    revision = view.revision;
    receive({
      ...view,
      goals: view.goals.filter((goal) => goal.sessionId === sessionId),
    });
  };
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = api.onGoalState?.(accept);
  } catch {
    /* The initial read still gives the last committed host state. */
  }
  let initial: Promise<GoalView>;
  try {
    initial = api.goalSnapshot(sessionId);
  } catch (error) {
    initial = Promise.reject(error);
  }
  void initial.then(accept, () => {
    if (!closed && deliveries === 0)
      connection("无法读取目标状态，请查看原任务记录。");
  });
  return () => {
    closed = true;
    unsubscribe?.();
  };
}
export async function cancelCurrentGoal(
  api: GoalClientAPI,
  sessionId: string,
  goal: GoalRun,
) {
  if (goal.sessionId !== sessionId) throw Error("目标不属于当前会话。");
  if (typeof api.cancelGoal !== "function")
    throw Error("当前版本不支持停止目标，请从任务记录停止原请求。");
  return api.cancelGoal({ goalId: goal.id, sessionId });
}
export function useGoals(
  api: (DesktopAPI & GoalClientAPI) | undefined,
  sessionId: string,
) {
  const [state, setState] = useState<GoalView>({ revision: -1, goals: [] });
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState("");
  const pendingIds = useRef(new Set<string>());
  const mounted = useRef(false);
  const generation = useRef(0);
  const available = !!sessionId && typeof api?.goalSnapshot === "function";
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const current = ++generation.current;
    setState({ revision: -1, goals: [] });
    setError("");
    if (!api || !available) return;
    const close = watchGoalState(
      api,
      sessionId,
      (view) => {
        if (generation.current === current)
          setState((prior) => (view.revision > prior.revision ? view : prior));
      },
      (message) => {
        if (generation.current === current) setError(message);
      },
    );
    return () => {
      generation.current++;
      close();
    };
  }, [api, sessionId, available]);
  const cancel = async (goal: GoalRun) => {
    if (!api || pendingIds.current.has(goal.id)) return false;
    const current = generation.current;
    pendingIds.current.add(goal.id);
    setPending([...pendingIds.current]);
    setError("");
    try {
      const stopped = await cancelCurrentGoal(api, sessionId, goal);
      if (generation.current === current)
        setState((prior) => ({
          ...prior,
          goals: prior.goals.map((value) =>
            value.id === stopped.id && stopped.revision > value.revision
              ? stopped
              : value,
          ),
        }));
      return true;
    } catch (e) {
      if (generation.current === current)
        setError(
          e instanceof Error ? e.message : "停止结果尚未确认，请查看原请求。",
        );
      return false;
    } finally {
      pendingIds.current.delete(goal.id);
      // Pending reflects actual in-flight goal IDs across session changes.
      // Only the response's status/error belong to its captured generation.
      if (mounted.current) setPending([...pendingIds.current]);
    }
  };
  return {
    state,
    available,
    pending,
    error: error || state.error || "",
    cancel,
  };
}
export type GoalController = ReturnType<typeof useGoals>;
