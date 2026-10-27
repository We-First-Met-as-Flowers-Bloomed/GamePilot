import { CircleCheck, CircleHelp, CircleX, Clock3, Square } from "lucide-react";
import { useEffect, useState } from "react";
import type { DesktopAPI } from "../../../../packages/protocol";
import type {
  GoalRun,
  GoalStatus,
} from "../../../../packages/protocol/agent-goal";
import { useGoals, type GoalController } from "../hooks/useGoals";
import { games as registeredGames } from "../../../../games/registry";
import GoalMatrix from "./GoalMatrix";

const labels: Record<GoalStatus, string> = {
  preparing: "准备目标",
  running: "正在提交",
  waiting: "游戏运行中",
  recovering: "核对恢复",
  "needs-user": "需要你处理",
  completed: "目标已核验完成",
  failed: "目标未满足",
  cancelling: "正在确认停止",
  cancelled: "目标已停止",
  unknown: "结果尚未确认",
};
const games: Record<string, string> = {
  arknights: "明日方舟",
  onmyoji: "阴阳师",
};
const laneLabel = (id?: string) =>
  id === "lane-a" ? "账号一" : id === "lane-b" ? "账号二" : (id ?? "账号");
const satisfaction = (value: boolean | null) =>
  value === true ? "已核验满足" : value === false ? "尚未满足" : "未确认";
const skillTitle = (gameId: string, skillId: string) =>
  registeredGames
    .find((game) => game.id === gameId)
    ?.skills.find((skill) => skill.id === skillId)?.title ?? skillId;

export function GoalCard({
  goal,
  pending,
  onCancel,
  onOpenExecution,
  onResume,
  compact = false,
}: {
  goal: GoalRun;
  pending: boolean;
  onCancel: (goal: GoalRun) => void;
  onOpenExecution: (id: string) => void;
  /** Opens a new user message; it does not grant or execute a continuation. */
  onResume?: (goalId: string) => void;
  compact?: boolean;
}) {
  const canStop =
    ["preparing", "running", "waiting", "recovering", "cancelling"].includes(
      goal.status,
    ) ||
    (goal.status === "unknown" && !!goal.submission && !goal.cancelledAt);
  const Icon =
    goal.status === "completed" && goal.goalSatisfied === true
      ? CircleCheck
      : ["failed", "cancelled"].includes(goal.status)
        ? CircleX
        : ["unknown", "needs-user"].includes(goal.status)
          ? CircleHelp
          : Clock3;
  const status =
    goal.status === "completed" && goal.goalSatisfied !== true
      ? "结果尚未确认"
      : labels[goal.status];
  const review = goal.originalReview ?? goal.review;
  return (
    <article
      tabIndex={-1}
      className={`chat-command-card chat-goal-card ${compact ? "compact-goal" : ""}`}
      data-goal-id={goal.id}
      data-status={goal.status}
      data-result-verified={
        goal.status === "completed" && goal.goalSatisfied === true
      }
      data-intent-turn-id={goal.turnId}
    >
      <header>
        <Icon size={16} aria-hidden="true" />
        <strong>游戏目标</strong>
        <span role="status">{status}</span>
      </header>
      <p className="chat-command-intent-reference">{goal.prompt}</p>
      <p className="chat-goal-conclusion">
        {status} ·{" "}
        {goal.goalSatisfied === true && goal.status === "completed"
          ? "宿主已核验原目标"
          : goal.goalSatisfied === false
            ? "宿主记录目标尚未满足"
            : "以宿主实际步骤结果为准"}
      </p>
      {!compact && <p className="helper">{goal.message}</p>}
      <GoalMatrix goal={goal} />
      <p className="helper chat-goal-verification">
        {goal.flowComplete ? "原执行流程已处理" : "等待实际执行结果"} ·{" "}
        {goal.goalSatisfied === true && goal.status === "completed"
          ? "目标已核验满足"
          : goal.goalSatisfied === false
            ? "目标尚未满足"
            : "目标满足情况未确认"}
      </p>
      {goal.publicReply && !compact && (
        <div className="chat-model-explanation">
          <strong>
            {goal.publicReply.model ? "模型答复" : "宿主结果摘要"}
          </strong>
          <p className="chat-answer">{goal.publicReply.text}</p>
        </div>
      )}
      <details className="chat-record-details">
        <summary>实际结果与执行范围</summary>
        <div className="chat-summary-body">
          {compact && <p className="helper">{goal.message}</p>}
          {goal.publicReply && compact && (
            <div className="chat-model-explanation">
              <strong>
                {goal.publicReply.model ? "模型答复" : "宿主结果摘要"}
              </strong>
              <p className="chat-answer">{goal.publicReply.text}</p>
            </div>
          )}
          {review?.summary.length ? (
            <div className="chat-command-plans">
              {review.summary.map((lane, index) => (
                <section key={`${lane.laneName}-${index}`}>
                  <strong>{lane.laneName}</strong>
                  {lane.games.map((game) => (
                    <div key={game.gameId}>
                      <h4>{game.title}</h4>
                      <ol>
                        {game.steps.map((step, stepIndex) => (
                          <li key={stepIndex}>{step}</li>
                        ))}
                      </ol>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          ) : (
            <p>
              {(review?.scopes ?? goal.grant.scopes)
                .map(
                  (scope) =>
                    `${laneLabel(scope.laneId)} · ${games[scope.gameId] ?? scope.gameId} · ${scope.skillIds.map((id) => skillTitle(scope.gameId, id)).join("、")}`,
                )
                .join("；")}
            </p>
          )}
          <strong>实际结果</strong>
          {goal.requests.length ? (
            <ul>
              {goal.requests.map((request) => (
                <li key={request.requestId}>
                  <div>
                    {laneLabel(request.laneId)}
                    {request.gameId &&
                      ` · ${games[request.gameId] ?? request.gameId}`}{" "}
                    ·{" "}
                    {request.status === "running"
                      ? "执行中"
                      : request.status === "cancelled"
                        ? "已停止"
                        : request.status === "failed"
                          ? "请求失败"
                          : request.status === "unknown"
                            ? "请求结果未知"
                            : "请求流程已结束"}{" "}
                    · 目标{satisfaction(request.goalSatisfied)}
                  </div>
                  {request.skills.length > 0 && (
                    <ul>
                      {request.skills.map((skill, index) => (
                        <li key={`${skill.skillId}-${index}`}>
                          {skill.summary} · {satisfaction(skill.goalSatisfied)}
                          {skill.skipReason && (
                            <small> · 跳过原因：{skill.skipReason}</small>
                          )}
                          {skill.evidenceTimestamp && (
                            <small>
                              {" "}
                              · 观察时间：{skill.evidenceTimestamp}
                            </small>
                          )}
                          {!!skill.effectEvidence?.length && (
                            <details className="chat-effect-evidence">
                              <summary>
                                已观察到的业务效果 ·{" "}
                                {skill.effectEvidence.length}
                              </summary>
                              <p className="helper">
                                效果证据保留；步骤是否完成仍以上方结果为准。
                              </p>
                              <ul>
                                {skill.effectEvidence.map(
                                  (effect, effectIndex) => (
                                    <li key={effectIndex}>
                                      {effect.summary}
                                      <small> · {effect.observedAt}</small>
                                    </li>
                                  ),
                                )}
                              </ul>
                            </details>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onOpenExecution(request.requestId)}
                  >
                    查看原任务记录
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p>尚无实际请求结果。</p>
          )}
          <p className="helper">
            本目标已使用 {goal.retryCount} / {goal.grant.maxRetries}{" "}
            次恢复额度。
          </p>
        </div>
      </details>
      <div className="chat-command-actions goal-panel-footer">
        <p className="helper">
          已使用 {goal.retryCount} / {goal.grant.maxRetries} 次恢复额度
        </p>
        {goal.requests.map((request, index) => (
          <button
            key={`${request.requestId}-${index}`}
            type="button"
            className="text-button"
            onClick={() => onOpenExecution(request.requestId)}
          >
            查看原任务记录{goal.requests.length > 1 ? ` ${index + 1}` : ""}
          </button>
        ))}
        {canStop && (
          <button
            type="button"
            className="button secondary"
            disabled={pending || goal.status === "cancelling"}
            onClick={() => onCancel(goal)}
          >
            <Square size={12} aria-hidden="true" />
            {pending || goal.status === "cancelling"
              ? "正在确认停止"
              : "停止目标"}
          </button>
        )}
        {onResume &&
          ["needs-user", "failed", "unknown"].includes(goal.status) && (
            <button
              type="button"
              className="text-button"
              onClick={() => onResume(goal.id)}
            >
              继续沟通这个目标
            </button>
          )}
      </div>
    </article>
  );
}

interface GoalCardsProps {
  api?: DesktopAPI;
  sessionId: string;
  turnId?: string;
  onOpenExecution: (id: string) => void;
  onResume?: (goalId: string) => void;
  controller?: GoalController;
  compact?: boolean;
  focusGoalId?: string;
}
/** Standalone legacy consumers keep their subscription; Chat supplies its single controller. */
export function GoalCards(props: GoalCardsProps) {
  return props.controller ? (
    <GoalCardList {...props} controller={props.controller} />
  ) : (
    <SubscribedGoalCards {...props} />
  );
}
function SubscribedGoalCards(props: GoalCardsProps) {
  const goals = useGoals(props.api, props.sessionId);
  return <GoalCardList {...props} controller={goals} />;
}
function GoalCardList({
  api,
  sessionId,
  turnId,
  onOpenExecution,
  onResume,
  controller: goals,
  compact,
  focusGoalId,
}: GoalCardsProps & { controller: GoalController }) {
  const [limit, setLimit] = useState(16);
  useEffect(() => setLimit(16), [sessionId, turnId]);
  if (!goals.available) return null;
  const entries = goals.state.goals
    .filter(
      (goal) =>
        goal.sessionId === sessionId && (!turnId || goal.turnId === turnId),
    )
    .sort((a, b) =>
      compact
        ? Date.parse(b.createdAt) - Date.parse(a.createdAt)
        : Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
  const active = (goal: GoalRun) =>
    ["preparing", "running", "waiting", "recovering", "cancelling"].includes(
      goal.status,
    );
  const other = entries
    .filter((goal) => !active(goal))
    .sort(
      (a, b) =>
        Number(a.status !== "needs-user") - Number(b.status !== "needs-user"),
    );
  const shown = compact
    ? [
        ...entries.filter(active),
        ...other.filter(
          (goal, index) => index < limit || goal.id === focusGoalId,
        ),
      ]
    : entries.slice(-16);
  if (!entries.length && !goals.error) return null;
  return (
    <div className="chat-goal-cards" aria-label="游戏目标">
      {goals.error && (
        <p role="alert" className="error">
          {goals.error}
        </p>
      )}
      {shown.map((goal) => (
        <GoalCard
          key={goal.id}
          goal={goal}
          pending={goals.pending.includes(goal.id)}
          onCancel={(value) => {
            void goals.cancel(value);
          }}
          onOpenExecution={onOpenExecution}
          onResume={onResume}
          compact={compact}
        />
      ))}
      {compact && other.length > limit && (
        <button
          type="button"
          className="text-button chat-goal-more"
          onClick={() => setLimit((value) => value + 16)}
        >
          显示更多任务 · 另有 {other.length - limit} 项
        </button>
      )}
    </div>
  );
}

export default GoalCards;
