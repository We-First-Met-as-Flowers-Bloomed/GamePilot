import { useEffect, useState } from "react";
import {
  ChevronDown,
  CircleCheck,
  CircleX,
  Clock3,
  Wrench,
  Minus,
} from "lucide-react";
import type { DesktopAPI } from "../../../../packages/protocol";
import type { AgentEvent } from "../../../../packages/protocol/agent-events";
import type { PlannerUsage } from "../../../../packages/protocol/agent-planner";

const toolKinds = ["tool-requested", "tool-started", "tool-result"];
function statusMark(event: AgentEvent) {
  return event.status === "succeeded" ? (
    <CircleCheck size={14} />
  ) : event.status === "running" ? (
    <Clock3 size={14} />
  ) : ["failed", "blocked"].includes(event.status) ? (
    <CircleX size={14} />
  ) : (
    <Minus size={14} />
  );
}
export function measuredDuration(value?: number) {
  return value === undefined || !Number.isFinite(value) || value < 0
    ? "耗时未记录"
    : value > 0 && value < 1
      ? "小于 1 毫秒"
      : value < 1000
        ? `${Math.round(value)} 毫秒`
        : `${Number((value / 1000).toFixed(2))} 秒`;
}
function publicJson(value: string | undefined) {
  if (value === undefined) return "未记录";
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

/** Public host events, grouped by exact call ID; journal timestamps are never durations. */
export function AgentEventTimeline({ events }: { events: AgentEvent[] }) {
  const groups: { key: string; events: AgentEvent[]; callId?: string }[] = [];
  const calls = new Map<string, (typeof groups)[number]>();
  for (const event of events.filter((e) => e.kind !== "model-usage")) {
    if (toolKinds.includes(event.kind) && event.callId) {
      const key = `${event.requestId}:${event.callId}`;
      const group = calls.get(key);
      if (group) group.events.push(event);
      else {
        const value = { key, events: [event], callId: event.callId };
        calls.set(key, value);
        groups.push(value);
      }
    } else groups.push({ key: `event-${event.seq}`, events: [event] });
  }
  return (
    <ol className="agent-event-timeline">
      {groups.map((group) => {
        const first = group.events[0],
          last = group.events.at(-1)!;
        const isTool = toolKinds.includes(first.kind);
        if (!isTool)
          return (
            <li
              key={group.key}
              data-agent-event-seq={first.seq}
              data-status={last.status}
            >
              {statusMark(last)}
              <span>{last.text}</span>
              <time dateTime={last.at} title="记录时间">
                {new Date(last.at).toLocaleTimeString("zh-CN", {
                  hour12: false,
                })}
              </time>
            </li>
          );
        const args = group.events.find(
          (e) => e.details?.arguments !== undefined,
        )?.details?.arguments;
        const result = [...group.events]
          .reverse()
          .find((e) => e.details?.result !== undefined)?.details?.result;
        const duration = [...group.events]
          .reverse()
          .find((e) => e.details?.durationMs !== undefined)
          ?.details?.durationMs;
        return (
          <li
            key={group.key}
            data-agent-event-seq={first.seq}
            data-agent-call-id={group.callId}
            data-status={last.status}
            className="agent-tool-entry"
          >
            <details className="agent-call-details">
              <summary>
                {statusMark(last)}
                <span>{last.tool ?? first.tool ?? "工具调用"}</span>
                <small>{measuredDuration(duration)}</small>
                <ChevronDown size={13} />
              </summary>
              <div className="agent-call-body">
                <p>{last.text}</p>
                <div className="agent-call-io">
                  <section>
                    <h5>调用参数</h5>
                    <pre>{publicJson(args)}</pre>
                  </section>
                  <section>
                    <h5>返回摘要</h5>
                    <pre>{publicJson(result)}</pre>
                  </section>
                </div>
                <small className="helper">
                  记录时间{" "}
                  <time dateTime={last.at}>
                    {new Date(last.at).toLocaleTimeString("zh-CN", {
                      hour12: false,
                    })}
                  </time>{" "}
                  · 公开工具摘要
                </small>
              </div>
            </details>
          </li>
        );
      })}
    </ol>
  );
}

/** Listener before replay; sequence dedupe lets late IPC and disk history converge. */
export function AgentRunTrace({
  api,
  requestId,
  active,
  presentation = "inline",
  omitCommands = false,
}: {
  api?: DesktopAPI;
  requestId?: string;
  active: boolean;
  presentation?: "inline" | "trajectory";
  omitCommands?: boolean;
}) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    setEvents([]);
    setPartial("");
    setError("");
    if (!api || !requestId || typeof api.agentEvents !== "function") return;
    let disposed = false;
    const accept = (values: AgentEvent[]) => {
      if (disposed) return;
      setEvents((previous) =>
        [
          ...new Map(
            [...previous, ...values]
              .filter(
                (e) =>
                  e.requestId === requestId || e.parentRequestId === requestId,
              )
              .map((e) => [e.seq, e]),
          ).values(),
        ]
          .sort((a, b) => a.seq - b.seq)
          .slice(-4096),
      );
    };
    const unsubscribe = api.onAgentEvent((event) => {
      if (event.requestId === requestId || event.parentRequestId === requestId)
        accept([event]);
    });
    const unerror = api.onAgentError?.((message) => {
      if (!disposed) setError(message);
    });
    const unstream = api.onPlannerStream((value) => {
      if (
        !disposed &&
        value.requestId === requestId &&
        value.event.kind === "answer-delta"
      ) {
        const text = value.event.text;
        setPartial((previous) => (previous + text).slice(-32768));
      }
    });
    const replay = async () => {
      let afterSeq = 0;
      try {
        for (;;) {
          const page = await api.agentEvents({
            requestId,
            afterSeq,
            limit: 128,
          });
          if (disposed) return;
          accept(page.events);
          if (page.error || page.gap) {
            setError(page.error || "记录存在缺口，请以原任务账本核对结果。");
            return;
          }
          if (!page.hasMore) return;
          if (page.cursor <= afterSeq) throw Error("cursor");
          afterSeq = page.cursor;
        }
      } catch {
        if (!disposed)
          setError("过程记录暂时无法读取；游戏结果仍以原账本为准。");
      }
    };
    void replay();
    return () => {
      disposed = true;
      unsubscribe();
      unstream();
      unerror?.();
    };
  }, [api, requestId]);
  const usage: PlannerUsage | undefined = events
    .filter((e) => e.kind === "model-usage")
    .at(-1)?.usage;
  const tools = events.filter((e) =>
    ["tool-requested", "tool-started", "tool-result"].includes(e.kind),
  );
  return (
    <>
      {active && partial && (
        <p className="chat-answer chat-partial" aria-label="模型实时回复">
          {partial}
        </p>
      )}
      {error && (
        <p className="helper" role="alert">
          {error}
        </p>
      )}
      {events.length === 0 && presentation === "trajectory" && (
        <p className="trajectory-empty-record">
          还没有调用记录
          {active ? "，正在等待宿主事件。" : "；该轮次未提供过程记录。"}
        </p>
      )}
      {events.length > 0 && (
        <details
          className="chat-response-details chat-tool-trace"
          aria-label="实时工具与模型记录"
          open={presentation === "trajectory"}
        >
          <summary>
            <Wrench size={14} />
            {active ? "正在处理" : "处理记录"}
            <span>
              {tools.filter((e) => e.kind === "tool-result").length} 次工具返回
            </span>
            <ChevronDown size={14} />
          </summary>
          <AgentEventTimeline
            events={
              omitCommands
                ? events.filter((event) => event.kind !== "command")
                : events
            }
          />
          <p className="helper">
            模型提供用量：
            {usage
              ? `输入 ${usage.inputTokens ?? "未提供"} · 输出 ${usage.outputTokens ?? "未提供"}${usage.cachedInputTokens === undefined ? "" : ` · 输入内缓存 ${usage.cachedInputTokens}`}`
              : "未提供"}
            。工具返回与游戏完成分别核对。
          </p>
        </details>
      )}
    </>
  );
}
