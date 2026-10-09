import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopAPI } from "../../../../packages/protocol";
import type {
  PlannerInput,
  PlannerViewState,
} from "../../../../packages/protocol/agent-planner";

export function usePlanner(api: DesktopAPI | undefined) {
  const [state, setState] = useState<PlannerViewState>({
    revision: -1,
    status: "idle",
  });
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const mounted = useRef(false);
  const pendingRef = useRef(false);
  const apply = useCallback((value: PlannerViewState) => {
    if (mounted.current)
      setState((previous) =>
        value.revision >= previous.revision ? value : previous,
      );
  }, []);
  useEffect(() => {
    if (!api) return;
    mounted.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const unsubscribe =
      typeof api.onPlannerState === "function"
        ? api.onPlannerState((value) => {
            if (!stopped) {
              apply(value);
              setReady(true);
              setConnectionError("");
            }
          })
        : undefined;
    const refresh = async () => {
      try {
        const value = await api.plannerSnapshot();
        if (stopped) return;
        apply(value);
        setReady(true);
        setConnectionError("");
      } catch {
        if (!stopped) setConnectionError("无法读取规划状态，正在重新连接。");
      }
      if (!stopped) timer = setTimeout(refresh, unsubscribe ? 30000 : 1000);
    };
    void refresh();
    return () => {
      stopped = true;
      mounted.current = false;
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [api, apply]);
  const perform = async (action: () => Promise<PlannerViewState>) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError("");
    try {
      apply(await action());
    } catch {
      if (mounted.current) setError("请求未完成，请检查规划状态后重试。");
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return {
    state,
    ready,
    pending,
    error: connectionError || error,
    start: (input: PlannerInput) =>
      api ? perform(() => api.startPlanner(input)) : Promise.resolve(),
    cancel: (requestId = state.requestId) =>
      api && requestId
        ? perform(() => api.cancelPlanner(requestId))
        : Promise.resolve(),
  };
}
