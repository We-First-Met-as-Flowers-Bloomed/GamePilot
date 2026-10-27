import { Activity, ArrowDown, MessageSquare } from "lucide-react";
import { useEffect, useState } from "react";
import type { DesktopAPI } from "../../../../packages/protocol";
import type { ChatSession } from "../../../../packages/protocol/agent-chat";
import { plannerActive } from "../../../../packages/protocol/agent-planner";
import { chatTurnLabel } from "../chat-state";
import { AgentRunTrace, measuredDuration } from "./AgentRunTrace";
import type { ChatCommandView } from "../../../../packages/protocol/chat-commands";
import { useGoals, type GoalController } from "../hooks/useGoals";
import { useDistinctValue } from "../hooks/useDistinctValue";
import { watchSnapshot } from "../hooks/watchSnapshot";

export function trajectoryCommandScope(
  commands: ChatCommandView[],
  session?: ChatSession,
) {
  const scoped = commands.filter(
    (command) => command.sessionId === session?.id,
  );
  return {
    forTurn: (turnId: string, requestId?: string) =>
      scoped.filter(
        (command) =>
          command.origin?.turnId === turnId &&
          command.origin.plannerRequestId === requestId,
      ),
    standalone: scoped.filter(
      (command) =>
        !command.origin ||
        !session?.turns.some(
          (turn) =>
            turn.id === command.origin?.turnId &&
            turn.planner.requestId === command.origin.plannerRequestId,
        ),
    ),
  };
}
function CommandTrajectory({
  api,
  command,
}: {
  api?: DesktopAPI;
  command: ChatCommandView;
}) {
  const labels = {
    review: "等待确认",
    submitted: "调度器已受理",
    blocked: "没有启动",
    unknown: "受理结果待核对",
  };
  return (
    <section
      className="trajectory-command"
      data-command-review-id={command.reviewId}
    >
      <header>
        <strong>{command.text}</strong>
        <span>{labels[command.status]}</span>
      </header>
      {command.message && <p className="helper">{command.message}</p>}
      <AgentRunTrace
        api={api}
        requestId={command.reviewId}
        active={false}
        presentation="trajectory"
      />
    </section>
  );
}

/** A read-only view of the same session and durable host events as the conversation. */
interface TrajectoryProps {
  api?: DesktopAPI;
  session?: ChatSession;
  controller?: GoalController;
}
export default function ChatTrajectory(props: TrajectoryProps) {
  return props.controller ? (
    <TrajectoryContent {...props} controller={props.controller} />
  ) : (
    <SubscribedTrajectory {...props} />
  );
}
function SubscribedTrajectory(props: TrajectoryProps) {
  const goals = useGoals(props.api, props.session?.id ?? "");
  return <TrajectoryContent {...props} controller={goals} />;
}
function TrajectoryContent({
  api,
  session,
  controller: goals,
}: TrajectoryProps & { controller: GoalController }) {
  const turns = session?.turns ?? [];
  const [commands, setCommands] = useState<ChatCommandView[]>([]);
  const [commandError, setCommandError] = useState("");
  const unchanged = useDistinctValue();
  useEffect(() => {
    setCommands([]);
    setCommandError("");
    if (!api || !session?.id || typeof api.chatCommands !== "function") return;
    const sessionId = session.id;
    return watchSnapshot({
      read: () => api.chatCommands(sessionId),
      subscribe: (refresh) =>
        api.onAgentEvent?.((event) => {
          if (event.kind === "command" && event.sessionId === sessionId)
            refresh();
        }) ?? (() => {}),
      accept: (values) => {
        setCommandError("");
        if (!unchanged([sessionId, values])) return;
        setCommands(
          values.filter((command) => command.sessionId === sessionId),
        );
      },
      error: () => {
        setCommandError("暂时无法读取本会话的宿主指令轨迹，请核对原执行回执。");
      },
    });
  }, [api, session?.id]);
  const commandScope = trajectoryCommandScope(commands, session);
  return (
    <section className="chat-trajectory" aria-label="当前会话调用轨迹">
      <header className="trajectory-heading">
        <div>
          <Activity size={18} />
          <h2>调用轨迹</h2>
        </div>
        <span>{turns.length} 轮对话</span>
      </header>
      <p className="trajectory-description">
        公开工具调用与宿主回执。游戏完成以执行回执为准。
      </p>
      {commandError && (
        <p className="helper" role="alert">
          {commandError}
        </p>
      )}
      {!turns.length ? (
        <div className="trajectory-empty">
          <Activity size={24} />
          <h3>还没有调用记录</h3>
          <p>发送需求后，模型调用、工具返回和执行进度会在这里显示。</p>
        </div>
      ) : (
        turns.map((turn, index) => {
          const state = turn.planner;
          return (
            <article
              className="trajectory-turn"
              key={turn.id}
              data-trajectory-turn-id={turn.id}
            >
              <header>
                <span className="trajectory-turn-index">{index + 1}</span>
                <strong>{chatTurnLabel(state)}</strong>
                <time dateTime={turn.createdAt}>
                  {new Date(turn.createdAt).toLocaleString("zh-CN", {
                    hour12: false,
                  })}
                </time>
              </header>
              <div className="trajectory-prompt">
                <MessageSquare size={15} />
                <p>{turn.prompt}</p>
              </div>
              {state.result && (
                <div className="trajectory-turn-meta">
                  <span>{state.result.model}</span>
                  <span>
                    本轮模型与工具总耗时{" "}
                    {measuredDuration(state.result.elapsedMs)}
                  </span>
                </div>
              )}
              {state.error && (
                <p className="banner warning" role="alert">
                  {state.error.message}
                </p>
              )}
              <div className="trajectory-flow-marker" aria-hidden="true">
                <ArrowDown size={15} />
              </div>
              <AgentRunTrace
                api={api}
                requestId={state.requestId}
                active={plannerActive(state)}
                presentation="trajectory"
                omitCommands
              />
              {goals.state.goals
                .filter(
                  (goal) =>
                    goal.sessionId === session?.id && goal.turnId === turn.id,
                )
                .map((goal) => (
                  <section
                    className="trajectory-command"
                    key={goal.id}
                    data-trajectory-goal-id={goal.id}
                  >
                    <header>
                      <strong>游戏目标与恢复</strong>
                      <span>{goal.message}</span>
                    </header>
                    <AgentRunTrace
                      api={api}
                      requestId={goal.id}
                      active={[
                        "preparing",
                        "running",
                        "waiting",
                        "recovering",
                        "cancelling",
                      ].includes(goal.status)}
                      presentation="trajectory"
                    />
                  </section>
                ))}
              {commandScope.forTurn(turn.id, state.requestId).map((command) => (
                <CommandTrajectory
                  key={command.reviewId}
                  api={api}
                  command={command}
                />
              ))}
            </article>
          );
        })
      )}
      {commandScope.standalone.length > 0 && (
        <section className="trajectory-host-commands">
          <h3>宿主指令</h3>
          <p className="helper">
            这些指令没有关联到当前会话的模型轮次，原执行回执单独保留。
          </p>
          {commandScope.standalone.map((command) => (
            <CommandTrajectory
              key={command.reviewId}
              api={api}
              command={command}
            />
          ))}
        </section>
      )}
    </section>
  );
}
