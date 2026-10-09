import { Activity, ChevronDown, Square } from "lucide-react";
import { useState } from "react";
import type { DesktopController } from "../hooks/useDesktop";
import { chatLaneActivity } from "../chat-activity";
import ExecutionProgressPanel from "./ExecutionProgressPanel";
import { DailyResultSummary } from "./ResultSummary";
import TaskProgress from "./TaskProgress";
import IncidentAgentPanel from "./IncidentAgentPanel";

/** A compact execution surface; model prose never supplies completion or progress. */
export default function ChatActivity({
  desktop: d,
  onOpenExecution,
}: {
  desktop: DesktopController;
  onOpenExecution?: (id: string) => void;
}) {
  const lanes = d.deviceLanes.lanes.filter((lane) => lane.enabled);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  return (
    <section className="chat-activity" aria-label="游戏任务执行进度">
      <header className="chat-activity-header">
        <span>
          <Activity size={15} /> 任务执行
        </span>
        <button
          type="button"
          className="text-button"
          onClick={() => d.setView("daily")}
        >
          管理每日计划
        </button>
      </header>
      {!lanes.length && (
        <p className="helper">
          还没有启用账号。
          <button
            type="button"
            className="text-button"
            onClick={() => d.setView("devices")}
          >
            配置设备与账号
          </button>
        </p>
      )}
      <div className="chat-activity-lanes">
        {lanes.map((lane) => {
          const daily = d.laneDailyStates[lane.id] ?? { status: null };
          const facts = chatLaneActivity(
            lane,
            daily,
            d.taskRecords,
            d.snapshot?.executions,
          );
          const current = facts.currentStep;
          return (
            <article
              key={lane.id}
              className="chat-lane-card"
              data-lane-id={lane.id}
            >
              <header className="chat-lane-heading">
                <div>
                  <strong>{lane.name}</strong>
                  <small className="muted">MuMu {lane.instance}</small>
                </div>
                <span
                  className="chat-lane-state"
                  data-state={facts.status ?? "unconfirmed"}
                  role="status"
                >
                  {facts.label}
                </span>
                {facts.active && (
                  <button
                    type="button"
                    className="button"
                    aria-label={`停止${lane.name}`}
                    disabled={!d.api || !!d.busy || facts.status === "stopping"}
                    onClick={() => d.stopLane(lane.id)}
                  >
                    <Square size={12} /> 停止
                  </button>
                )}
              </header>
              <p className="chat-lane-current">
                {current
                  ? `${current.status === "running" ? "正在执行" : current.status === "pending" ? "等待执行" : "待处理"}：${current.gameName} · ${current.title}`
                  : daily.gameDay
                    ? `最近请求所属游戏日 ${daily.gameDay}`
                    : "等待执行记录，尚不能确认今日日常结果。"}
              </p>
              <details
                className="chat-lane-details"
                onToggle={(event) => {
                  const open = event.currentTarget.open;
                  setOpened((current) => ({ ...current, [lane.id]: open }));
                }}
              >
                <summary>
                  <ChevronDown size={13} /> 展开执行详情
                </summary>
                {opened[lane.id] && (
                  <div className="chat-lane-body">
                    <ExecutionProgressPanel
                      api={d.api}
                      requestId={facts.requestId}
                      laneId={lane.id}
                      revision={facts.revision}
                      onOpenExecution={onOpenExecution}
                    />
                    {facts.dailyRequestId && (
                      <DailyResultSummary
                        api={d.api}
                        requestId={facts.dailyRequestId}
                        laneId={lane.id}
                      />
                    )}
                    <div className="chat-lane-games">
                      {lane.arknights.enabled && (
                        <section>
                          <h4>明日方舟</h4>
                          <TaskProgress
                            records={d.taskRecords}
                            laneId={lane.id}
                            batchId={daily.lastRun?.batchId}
                            gameId="arknights"
                          />
                        </section>
                      )}
                      {lane.onmyoji.enabled && (
                        <section>
                          <h4>阴阳师</h4>
                          <TaskProgress
                            records={d.taskRecords}
                            laneId={lane.id}
                            batchId={daily.lastRun?.batchId}
                            gameId="onmyoji"
                          />
                        </section>
                      )}
                    </div>
                    {facts.canDiagnose && facts.requestId && (
                      <IncidentAgentPanel
                        key={facts.requestId}
                        api={d.api}
                        requestId={facts.requestId}
                        disabled={d.active || !!d.busy}
                        onStarted={onOpenExecution}
                      />
                    )}
                    {facts.requestId && onOpenExecution && (
                      <button
                        type="button"
                        className="button"
                        onClick={() => onOpenExecution(facts.requestId!)}
                      >
                        查看本次记录与续跑
                      </button>
                    )}
                  </div>
                )}
              </details>
            </article>
          );
        })}
      </div>
    </section>
  );
}
