import { Play, Square, Settings2 } from "lucide-react";
import type { DesktopController } from "../hooks/useDesktop";
import {
  isActiveStatus,
  eventExecutionSource,
} from "../../../../packages/protocol/run-state";
import RoutineEditor from "../components/RoutineEditor";
import TaskProgress from "../components/TaskProgress";
import ExecutionNotice from "../components/ExecutionNotice";
import ExecutionHistory from "../components/ExecutionHistory";
import ExecutionProgressPanel from "../components/ExecutionProgressPanel";
import { executionForEvent } from "../execution-selection";
import { DailyResultSummary } from "../components/ResultSummary";
import AgentPlanner from "../components/AgentPlanner";
import { arknightsDailySkills } from "../../../../games/arknights/daily-plan";
import type { Routine } from "../../../../packages/protocol/routine";
const labels: Record<string, string> = {
  queued: "准备中",
  running: "运行中",
  stopping: "正在停止",
  succeeded: "已完成",
  failed: "失败，查看记录",
  cancelled: "已停止",
};
export default function Daily({
  desktop: d,
  onOpenExecution,
}: {
  desktop: DesktopController;
  onOpenExecution?: (id: string) => void;
}) {
  const lanes = d.deviceLanes.lanes.filter((lane) => lane.enabled);
  const editRoutine = (
    laneId: string,
    gameId: "arknights" | "onmyoji",
    routine: Routine,
  ) =>
    d.setDeviceLanes((previous) => ({
      ...previous,
      lanes: previous.lanes.map((lane) =>
        lane.id === laneId
          ? { ...lane, [gameId]: { ...lane[gameId], routine } }
          : lane,
      ),
    }));
  return (
    <div className="page daily-page">
      <div className="eyebrow">DAILY ROUTINE</div>
      <h1>今天的日常计划</h1>
      <p className="intro">
        这里的设备与游戏，也是定时任务实际执行的计划。每个设备独立运行、独立记录结果。
      </p>
      <AgentPlanner
        api={d.api}
        openRequested={d.entryTarget === "planner"}
        onOpened={d.clearEntryTarget}
        onOpenExecution={onOpenExecution}
      />
      {d.snapshot?.plannerPreview && (
        <p className="banner warning">
          AI 规划开发预览 · 使用独立数据，真实游戏执行已关闭。展开页面上方的“用
          AI 规划日常”开始体验。
        </p>
      )}
      {d.snapshot?.taskRecordError && (
        <div className="banner warning" role="alert">
          {d.snapshot.taskRecordError}
        </div>
      )}
      <ExecutionNotice
        records={d.snapshot?.executions}
        api={d.api}
        disabled={d.active || !!d.busy}
        onResolved={d.updateExecution}
        onOpenExecution={onOpenExecution}
      />
      {d.lanesDirty && (
        <div className="banner warning">
          设备计划有未保存的修改，后台仍使用上次保存的计划。点击开始会先保存，或{" "}
          <button
            className="button"
            disabled={!d.api || d.active || !!d.busy}
            onClick={d.saveDeviceLanes}
          >
            立即保存
          </button>
        </div>
      )}
      <div className="composer-actions daily-actions">
        <button className="text-button" onClick={() => d.setView("settings")}>
          管理定时与开机启动
        </button>
        {d.active ? (
          <button
            className="button"
            disabled={!d.api || !!d.busy || d.globalStatus === "stopping"}
            onClick={d.stop}
          >
            <Square size={14} />
            停止全部任务
          </button>
        ) : (
          <button
            className="button primary"
            disabled={
              !d.api || !!d.busy || !lanes.length || d.snapshot?.plannerPreview
            }
            onClick={d.startLanes}
          >
            <Play size={14} />
            开始每日计划
          </button>
        )}
      </div>
      <section className="surface">
        <div className="section-label">
          <h2>账号与执行顺序</h2>
          <button className="button" onClick={() => d.setView("devices")}>
            <Settings2 size={14} />
            配置设备与账号
          </button>
        </div>
        <div className="daily-grid">
          {lanes.length ? (
            lanes.map((lane) => {
              const profile = d.arknightsProfiles.profiles.find(
                (p) => p.id === lane.arknights.profileId,
              );
              const status = d.laneStatuses[lane.id];
              const daily = d.laneDailyStates[lane.id];
              const scope =
                daily.lastRun &&
                eventExecutionSource(daily.lastRun, d.snapshot?.executions);
              const executionId = executionForEvent(
                daily.lastRun,
                d.snapshot?.executions,
              );
              const continuationReceipt = d.snapshot?.executions?.find(
                (request) => request.id === executionId,
              );
              const isContinuation = Boolean(
                continuationReceipt?.laneId === lane.id &&
                continuationReceipt?.batchId === daily.lastRun?.batchId &&
                continuationReceipt?.snapshot.continuation,
              );
              const scopeLabel = isContinuation
                ? "最近续跑（仅所选任务）"
                : scope === "daily"
                  ? "上次日常请求"
                  : scope === "single"
                    ? "最近单项请求"
                    : scope === "maintenance"
                      ? "最近寄养请求"
                      : "上次请求（范围未知）";
              const uncertain =
                !isActiveStatus(daily.status) &&
                d.taskRecords?.some(
                  (r) =>
                    r.laneId === lane.id &&
                    r.batchId === daily.lastRun?.batchId &&
                    r.status === "unknown",
                );
              const progressRevision = JSON.stringify([
                daily.lastRun?.at,
                d.snapshot?.executions
                  ?.filter((request) => request.laneId === lane.id)
                  .map((request) => [
                    request.id,
                    request.status,
                    request.finishedAt,
                  ]),
                d.taskRecords
                  ?.filter((record) => record.laneId === lane.id)
                  .map((record) => [record.runId, record.updatedAt]),
              ]);
              return (
                <article key={lane.id} className="daily-lane">
                  <div className="section-label">
                    <h3>
                      {lane.name}{" "}
                      <span className="muted">MuMu {lane.instance}</span>
                    </h3>
                    <span
                      className={`badge ${daily.status === "failed" ? "red" : ""}`}
                    >
                      {isActiveStatus(daily.status)
                        ? scope === "maintenance"
                          ? "寄养 · "
                          : scope === "single"
                            ? "单项 · "
                            : scope === "daily"
                              ? "日常 · "
                              : "请求 · "
                        : ""}
                      {daily.status
                        ? uncertain
                          ? "部分结果未知"
                          : labels[daily.status]
                        : isContinuation
                          ? "续跑进度见下方"
                          : "今日日常待核对"}
                    </span>
                  </div>
                  <ExecutionProgressPanel
                    api={d.api}
                    requestId={executionId}
                    laneId={lane.id}
                    revision={progressRevision}
                    onOpenExecution={onOpenExecution}
                  />
                  {!daily.status && daily.lastRun?.status && (
                    <p className="helper">
                      {scopeLabel}：{labels[daily.lastRun.status]} ·{" "}
                      {daily.gameDay
                        ? `所属游戏日 ${daily.gameDay}`
                        : "所属游戏日未知"}
                    </p>
                  )}
                  {!daily.status && (
                    <p className="helper">
                      {isContinuation
                        ? "原请求与所选续跑任务的合并进度见上方；原请求结果单独保留。"
                        : "暂无可确认当前计划的今日日常结果；单项、旧计划或缺失记录均不能证明整套完成或未执行。"}
                    </p>
                  )}
                  {isActiveStatus(daily.status) && daily.gameDay && (
                    <p className="helper">本轮所属游戏日 {daily.gameDay}</p>
                  )}
                  <DailyResultSummary
                    api={d.api}
                    requestId={scope === "daily" ? executionId : undefined}
                    laneId={lane.id}
                  />
                  <ol className="daily-games">
                    {lane.arknights.enabled && (
                      <li>
                        <strong>
                          明日方舟 · {profile?.name ?? "账号档案缺失"}
                        </strong>
                        <p>
                          {profile
                            ? `${profile.clientType === "Official" ? "官服" : "B服"} · ${profile.stage ? `关卡 ${profile.stage}，使用现有理智` : "未指定关卡，跳过作战"} · 不使用理智药或源石`
                            : "请在设备页重新选择账号档案"}
                        </p>
                        <RoutineEditor
                          gameId="arknights"
                          value={lane.arknights.routine}
                          defaults={
                            profile ? arknightsDailySkills(profile) : undefined
                          }
                          disabled={!d.api || d.active || !!d.busy}
                          onChange={(routine) =>
                            editRoutine(lane.id, "arknights", routine)
                          }
                        />
                        <p>
                          完成后退出游戏
                          {lane.onmyoji.enabled ? "，继续阴阳师" : ""}
                        </p>
                        <TaskProgress
                          records={d.taskRecords}
                          laneId={lane.id}
                          batchId={daily.lastRun?.batchId}
                          gameId="arknights"
                        />
                      </li>
                    )}
                    {lane.onmyoji.enabled && (
                      <li>
                        <strong>阴阳师 · 模拟器内当前角色</strong>
                        <p>
                          麒麟仅周一至周四开放。仍在优化，遇到未识别页面会停止。
                        </p>
                        <RoutineEditor
                          gameId="onmyoji"
                          value={lane.onmyoji.routine}
                          disabled={!d.api || d.active || !!d.busy}
                          onChange={(routine) =>
                            editRoutine(lane.id, "onmyoji", routine)
                          }
                        />
                        <TaskProgress
                          records={d.taskRecords}
                          laneId={lane.id}
                          batchId={daily.lastRun?.batchId}
                          gameId="onmyoji"
                        />
                      </li>
                    )}
                  </ol>
                  <div className="lane-card-actions">
                    {executionId && onOpenExecution && (
                      <button
                        className="button"
                        onClick={() => onOpenExecution(executionId)}
                      >
                        查看本次详情
                      </button>
                    )}
                    <button
                      className="button"
                      disabled={
                        !d.api ||
                        !!d.busy ||
                        (!isActiveStatus(status) && d.active) ||
                        d.snapshot?.plannerPreview
                      }
                      onClick={() =>
                        isActiveStatus(status)
                          ? d.stopLane(lane.id)
                          : d.startLane(lane.id)
                      }
                    >
                      {isActiveStatus(status) ? "停止此账号" : "运行此账号"}
                    </button>
                  </div>
                </article>
              );
            })
          ) : (
            <p className="empty-log">
              尚未启用设备。先在设备页选择模拟器、账号和游戏。
            </p>
          )}
        </div>
      </section>
      {onOpenExecution && (
        <ExecutionHistory
          records={d.snapshot?.executions}
          onOpen={onOpenExecution}
        />
      )}
      <p className="helper">
        今日按游戏刷新时间计算，跨刷新任务归属开始时的游戏日。历史结果单独显示；手动运行会再次检查日常，自动定时按设备账本避免同一天重复启动。
      </p>
    </div>
  );
}
