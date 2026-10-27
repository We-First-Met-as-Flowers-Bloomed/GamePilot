import { useGameAutomation } from "../hooks/useGameAutomation";
import { Play, Square, Settings2 } from "lucide-react";
import type { DesktopController } from "../hooks/useDesktop";
import { useEffect, useState } from "react";
import {
  channelGame,
  channelOwnsHistoryRequest,
} from "../../../../packages/protocol/account-channel";
import {
  eventExecutionSource,
  isActiveStatus,
} from "../../../../packages/protocol/run-state";
import RoutineEditor from "../components/RoutineEditor";
import TaskProgress from "../components/TaskProgress";
import ExecutionNotice from "../components/ExecutionNotice";
import ExecutionHistory from "../components/ExecutionHistory";
import ExecutionProgressPanel from "../components/ExecutionProgressPanel";
import { DailyResultSummary } from "../components/ResultSummary";
import AgentPlanner from "../components/AgentPlanner";
import { arknightsDailySkills } from "../../../../games/arknights/daily-plan";
import { gameSlotRecords } from "../game-slot-records";
import type { Routine } from "../../../../packages/protocol/routine";
import { executionForEvent } from "../execution-selection";
import ArknightsAutomation, {
  ArknightsAutomationControls,
  useArknightsAutomation,
} from "../components/ArknightsAutomation";

const requestStatusLabels: Record<string, string> = {
  queued: "准备中",
  running: "运行中",
  stopping: "正在停止",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已停止",
};

export default function Daily({
  desktop: d,
  onOpenExecution,
}: {
  desktop: DesktopController;
  onOpenExecution?: (id: string) => void;
}) {
  const arknightsAutomation = useArknightsAutomation(d.api);
  const onmyojiAutomation = useGameAutomation(d.api, "onmyoji");
  const [plannerRequested, setPlannerRequested] = useState(
    d.entryTarget === "planner" || d.snapshot?.plannerPreview === true,
  );
  useEffect(() => {
    if (d.entryTarget === "planner" || d.snapshot?.plannerPreview === true)
      setPlannerRequested(true);
  }, [d.entryTarget, d.snapshot?.plannerPreview]);
  const lanes = d.deviceLanes.lanes.filter((lane) => lane.enabled);
  const runnableLanes = lanes.filter((lane) => channelGame(lane));
  const editRoutine = (
    laneId: string,
    gameId: "arknights" | "onmyoji",
    routine: Routine,
  ) =>
    d.setDeviceLanes((previous) => ({
      ...previous,
      version: 2,
      lanes: previous.lanes.map((lane) =>
        lane.id === laneId
          ? { ...lane, [gameId]: { ...lane[gameId], routine } }
          : lane,
      ),
    }));
  return (
    <div className="page daily-page">
      <div className="eyebrow">DAILY ROUTINE</div>
      <h1>每日任务</h1>
      <p className="intro">
        每个账号独立保存任务，使用各自绑定的游戏和模拟器执行。
      </p>
      {plannerRequested && (
        <AgentPlanner
          api={d.api}
          openRequested={d.entryTarget === "planner"}
          onOpened={d.clearEntryTarget}
          onOpenExecution={onOpenExecution}
        />
      )}
      {d.snapshot?.plannerPreview && (
        <p className="banner warning">
          AI 规划开发预览 · 使用独立数据，真实游戏执行已关闭。
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
          任务计划有未保存的修改。开始任务前会先保存，或{" "}
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
            disabled={!d.api || d.globalStatus === "stopping"}
            onClick={d.stopLanes}
          >
            <Square size={14} />
            停止全部账号
          </button>
        ) : (
          <button
            className="button primary"
            disabled={
              !d.api ||
              !!d.busy ||
              !runnableLanes.length ||
              d.snapshot?.plannerPreview
            }
            onClick={d.startLanes}
          >
            <Play size={14} />
            开始全部账号日常
          </button>
        )}
      </div>
      <section className="surface">
        <div className="section-label">
          <h2>账号日常计划</h2>
          <button className="button" onClick={() => d.setView("devices")}>
            <Settings2 size={14} />
            账号与渠道
          </button>
        </div>
        {lanes.some((lane) => channelGame(lane) === "arknights") && (
          <ArknightsAutomationControls
            controller={arknightsAutomation}
            disabled={d.active || !!d.busy || d.snapshot?.plannerPreview}
          />
        )}
        {lanes.some((lane) => channelGame(lane) === "onmyoji") && (
          <ArknightsAutomationControls
            controller={onmyojiAutomation}
            disabled={d.active || !!d.busy || d.snapshot?.plannerPreview}
          />
        )}
        <div className="daily-grid">
          {lanes.length ? (
            lanes.map((lane) => {
              const gameId = channelGame(lane);
              const lastRun = d.laneDailyStates?.[lane.id]?.lastRun;
              const selectedId = executionForEvent(
                lastRun,
                d.snapshot?.executions,
              );
              const selectedReceipt = d.snapshot?.executions?.find(
                (request) => request.id === selectedId,
              );
              const continuation =
                selectedReceipt?.laneId === lastRun?.laneId &&
                selectedReceipt?.batchId === lastRun?.batchId &&
                selectedReceipt &&
                channelOwnsHistoryRequest(selectedReceipt, lane) &&
                selectedReceipt.snapshot.continuation
                  ? selectedReceipt
                  : undefined;
              if (!gameId) {
                return (
                  <article
                    key={lane.id}
                    className="daily-lane"
                    data-lane-id={lane.id}
                    data-device-instance={lane.instance}
                  >
                    <div className="section-label">
                      <h3>{lane.name}</h3>
                      <span className="badge">
                        {continuation ? "续跑进度见下方" : "今日日常待核对"}
                      </span>
                    </div>
                    <p className="helper">
                      旧渠道记录 · MuMu 实例 {lane.instance} · 游戏范围未配置
                    </p>
                    {continuation && (
                      <p className="helper">
                        最近续跑（仅所选任务）。原请求结果单独保留，合并进度见下方。
                      </p>
                    )}
                    <ExecutionProgressPanel
                      api={d.api}
                      requestId={selectedId}
                      laneId={lane.id}
                      revision={JSON.stringify([
                        lastRun?.at,
                        selectedReceipt?.status,
                        selectedReceipt?.finishedAt,
                      ])}
                      onOpenExecution={onOpenExecution}
                    />
                    <button
                      className="text-button"
                      onClick={() => d.setView("devices")}
                    >
                      配置账号渠道
                    </button>
                  </article>
                );
              }
              const gameName = gameId === "arknights" ? "明日方舟" : "阴阳师";
              const profile =
                gameId === "arknights"
                  ? d.arknightsProfiles.profiles.find(
                      (item) => item.id === lane.arknights.profileId,
                    )
                  : undefined;
              const facts = gameSlotRecords({
                lane,
                gameId,
                profile,
                requests: d.snapshot?.executions,
                tasks: d.taskRecords,
                events: d.allEvents,
                now: d.today,
              });
              const target = { laneId: lane.id, gameId };
              const slotOwner = facts.latestRequest?.snapshot.gameSlot as
                typeof target | undefined;
              const exactSlot =
                slotOwner?.laneId === lane.id && slotOwner.gameId === gameId;
              const currentLaneActive = isActiveStatus(d.laneStatuses[lane.id]);
              const running = facts.active || currentLaneActive;
              const canStop =
                running &&
                (currentLaneActive || facts.latestRequest?.laneId === lane.id);
              const requestLaneId = facts.latestRequest?.laneId ?? lane.id;
              const legacyRun = !facts.latestRequest
                ? d.laneDailyStates?.[lane.id]?.lastRun
                : undefined;
              const legacySource =
                legacyRun &&
                eventExecutionSource(legacyRun, d.snapshot?.executions);
              return (
                <article
                  key={lane.id}
                  className="daily-lane"
                  data-lane-id={lane.id}
                  data-game-id={gameId}
                  data-device-instance={lane.instance}
                >
                  <div className="section-label">
                    <h3>{lane.name}</h3>
                    <span
                      className={`badge ${facts.status === "failed" ? "red" : ""}`}
                    >
                      {currentLaneActive && !facts.active
                        ? "账号任务处理中"
                        : continuation
                          ? "续跑进度见下方"
                          : facts.latestRequest
                            ? facts.label
                            : "今日日常待核对"}
                    </span>
                  </div>
                  <p className="helper">
                    {gameName} · MuMu 实例 {lane.instance}
                    {profile
                      ? ` · ${profile.clientType === "Official" ? "官服" : "B服"} · ${profile.name}`
                      : gameId === "onmyoji"
                        ? ` · ${lane.onmyoji.identity?.serverName ?? "使用设备内当前角色"}`
                        : " · 账号档案缺失"}
                  </p>
                  {continuation && (
                    <>
                      <p className="helper">
                        最近续跑（仅所选任务）。原请求结果单独保留，合并进度见下方。
                      </p>
                      <ExecutionProgressPanel
                        api={d.api}
                        requestId={continuation.id}
                        laneId={continuation.laneId}
                        revision={facts.revision}
                        onOpenExecution={onOpenExecution}
                      />
                    </>
                  )}
                  {legacyRun?.status && (
                    <p className="helper">
                      {legacySource === "single"
                        ? "最近单项请求"
                        : legacySource === "daily"
                          ? "上次日常请求"
                          : "上次请求（范围未知）"}
                      ：{requestStatusLabels[legacyRun.status]}
                    </p>
                  )}
                  <div className="lane-card-actions">
                    <button
                      className={`button ${running ? "" : "primary"}`}
                      aria-label={`${running ? "停止" : "运行"}账号 ${lane.name}`}
                      disabled={
                        !d.api ||
                        (running
                          ? !canStop ||
                            facts.status === "stopping" ||
                            d.laneStatuses[lane.id] === "stopping"
                          : !!d.busy ||
                            (d.active && d.lanesDirty) ||
                            d.snapshot?.plannerPreview)
                      }
                      onClick={() => {
                        if (!running) d.startGameSlot(target);
                        else if (canStop) {
                          if (exactSlot) d.stopGameSlot(target);
                          else d.stopLane(lane.id);
                        }
                      }}
                    >
                      {running ? <Square size={14} /> : <Play size={14} />}
                      {running ? "停止此账号" : "运行此账号"}
                    </button>
                    {facts.requestId && onOpenExecution && (
                      <button
                        className="button"
                        onClick={() => onOpenExecution(facts.requestId!)}
                      >
                        查看本次详情
                      </button>
                    )}
                  </div>
                  {running && !canStop && (
                    <p className="helper">
                      旧渠道请求仍在运行，可使用停止全部账号。
                    </p>
                  )}
                  {facts.gameDay && (
                    <p className="helper">最近请求所属游戏日 {facts.gameDay}</p>
                  )}
                  {(gameId === "arknights" || gameId === "onmyoji") && (
                    <ArknightsAutomation
                      laneId={lane.id}
                      laneName={lane.name}
                      controller={
                        gameId === "arknights"
                          ? arknightsAutomation
                          : onmyojiAutomation
                      }
                      disabled={
                        !!d.busy || running || d.snapshot?.plannerPreview
                      }
                      onOpenSettings={() => d.setView("devices")}
                    />
                  )}
                  <details className="daily-plan-details">
                    <summary>任务清单与执行记录</summary>
                    <RoutineEditor
                      gameId={gameId}
                      value={lane[gameId].routine}
                      defaults={
                        profile ? arknightsDailySkills(profile) : undefined
                      }
                      disabled={!d.api || d.active || !!d.busy}
                      onChange={(routine) =>
                        editRoutine(lane.id, gameId, routine)
                      }
                    />
                    {!continuation && (
                      <ExecutionProgressPanel
                        api={d.api}
                        requestId={facts.requestId}
                        laneId={requestLaneId}
                        revision={facts.revision}
                        onOpenExecution={onOpenExecution}
                      />
                    )}
                    <DailyResultSummary
                      api={d.api}
                      requestId={
                        facts.scope === "daily" ? facts.requestId : undefined
                      }
                      laneId={requestLaneId}
                    />
                    <TaskProgress
                      records={facts.records}
                      laneId={requestLaneId}
                      batchId={facts.batchId}
                      gameId={gameId}
                    />
                  </details>
                </article>
              );
            })
          ) : (
            <p className="empty-log">
              尚未启用账号渠道。先在账号与渠道页绑定游戏和模拟器。
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
        每日结果按各游戏刷新时间归属。Windows
        方舟日常的运行记录请在对应入口查看。
      </p>
    </div>
  );
}
