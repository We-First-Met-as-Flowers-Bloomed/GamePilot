import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopAPI } from "../../../../packages/protocol";
import type { ChatView } from "../../../../packages/protocol/agent-chat";
import type { PlannerSource } from "../../../../packages/protocol/agent-planner";

/** Subscribe before the initial read; a late read cannot rewind a pushed revision. */
export function watchChatState(
  api: Pick<DesktopAPI, "chatSnapshot"> &
    Partial<Pick<DesktopAPI, "onChatState">>,
  receive: (value: ChatView) => void,
  connection: (message: string) => void,
) {
  let closed = false,
    revision = -1,
    deliveries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const accept = (value: ChatView) => {
    if (closed) return;
    deliveries++;
    connection("");
    if (value.revision <= revision) return;
    revision = value.revision;
    receive(value);
  };
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = api.onChatState?.(accept);
  } catch {
    /* Older previews use polling. */
  }
  const poll = async () => {
    const before = deliveries;
    try {
      accept(await api.chatSnapshot());
    } catch {
      if (!closed && before === deliveries)
        connection("无法读取对话状态，正在重新连接。");
    }
    if (!closed) timer = setTimeout(poll, unsubscribe ? 30000 : 1000);
  };
  void poll();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    unsubscribe?.();
  };
}

export function useChat(api?: DesktopAPI) {
  const [state, setState] = useState<ChatView>({ revision: -1, sessions: [] });
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const mounted = useRef(false),
    inFlight = useRef(false);
  const apply = useCallback((value: ChatView) => {
    if (mounted.current)
      setState((previous) =>
        value.revision > previous.revision ? value : previous,
      );
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (!api)
      return () => {
        mounted.current = false;
      };
    const unsubscribe = watchChatState(
      api,
      (value) => {
        apply(value);
        setReady(true);
      },
      setConnectionError,
    );
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [api, apply]);
  const perform = async (action: () => Promise<ChatView>) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      apply(await action());
      return true;
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error
            ? e.message
            : "请求未完成，请查看对话状态。不要重复启动任务。",
        );
      return false;
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return {
    state,
    ready,
    pending,
    error: connectionError || error || state.error || "",
    newSession: () =>
      api ? perform(() => api.newChat()) : Promise.resolve(false),
    select: (id: string) =>
      api ? perform(() => api.selectChat(id)) : Promise.resolve(false),
    send: (input: {
      sessionId: string;
      prompt: string;
      at: string;
      source: PlannerSource;
    }) => (api ? perform(() => api.sendChat(input)) : Promise.resolve(false)),
    cancel: (sessionId: string, turnId: string) =>
      api
        ? perform(() => api.cancelChat({ sessionId, turnId }))
        : Promise.resolve(false),
    archive: (sessionId: string) =>
      api && typeof api.archiveChat === "function"
        ? perform(() => api.archiveChat({ sessionId }))
        : Promise.resolve(false),
    restore: (archiveId: string) =>
      api && typeof api.restoreArchivedChat === "function"
        ? perform(() => api.restoreArchivedChat({ archiveId }))
        : Promise.resolve(false),
    delete: (sessionId: string) =>
      api && typeof api.deleteChat === "function"
        ? perform(() =>
            api.deleteChat({ sessionId, confirmation: "delete-chat" }),
          )
        : Promise.resolve(false),
  };
}
export type ChatController = ReturnType<typeof useChat>;
