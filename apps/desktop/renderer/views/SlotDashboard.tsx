import { useState } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  Layers3,
  ListChecks,
  Monitor,
  Play,
  Settings2,
  Square,
} from "lucide-react";
import type { DesktopController } from "../hooks/useDesktop";
import { slotDashboardState } from "../slot-dashboard-state";
import TaskProgress from "../components/TaskProgress";
import { isActiveStatus } from "../../../../packages/protocol/run-state";
import "../slot-dashboard.css";

export default function SlotDashboard({
  desktop: d,
  onOpenExecution,
}: {
  desktop: DesktopController;
  onOpenExecution?: (id: string) => void;
}) {
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const { slots, counts, deviceCount } = slotDashboardState({
    lanes: d.deviceLanes.lanes,
    profiles: d.arknightsProfiles.profiles,
    tasks: d.taskRecords,
    requests: d.snapshot?.executions,
    events: d.allEvents,
    now: d.today,
    laneStatuses: d.laneStatuses,
  });
  const preventStart = !d.api || !!d.busy || !!d.snapshot?.plannerPreview;
  if (d.api && d.hydrated === false)
    return (
      <div
        className="page slot-dashboard slots-dashboard"
        aria-label="槽位总览"
      >
        <h1>槽位总览</h1>
        <p role="status" className="intro">
          正在读取已保存的槽位与账号配置…
        </p>
      </div>
    );
  return (
    <div className="page slot-dashboard slots-dashboard" aria-label="槽位总览">
      <header className="slot-dashboard-header">
        <div>
          <div className="eyebrow">GAMEPILOT / DAILY WORKSPACE</div>
          <h1>槽位总览</h1>
          <p className="intro">管理游戏日常，从这里开始。</p>
        </div>
        <div className="slot-dashboard-tools">
          <button
            type="button"
            className="button"
            onClick={() => d.setView("daily")}
          >
            <ListChecks size={15} /> 每日计划
          </button>
          <button
            type="button"
            className="button"
            onClick={() => d.setView("devices")}
          >
            <Settings2 size={15} /> 设备配置
          </button>
        </div>
      </header>
      <dl className="slot-dashboard-counts" aria-label="槽位统计">
        <div>
          <dt>
            <Layers3 size={15} /> 账号渠道
          </dt>
          <dd>
            {counts.configured}
            <span>{counts.enabled} 个启用</span>
          </dd>
        </div>
        <div>
          <dt>
            <Monitor size={15} /> 绑定模拟器
          </dt>
          <dd>
            {deviceCount}
            <span>{slots.some(slot => slot.sharedWith.length > 0) ? "共享时依次执行" : "各渠道独立绑定"}</span>
          </dd>
        </div>
        <div>
          <dt>活动槽位</dt>
          <dd>
            {counts.active}
            <span>{counts.active ? "正在处理任务" : "当前无活动任务"}</span>
          </dd>
        </div>
      </dl>
      <section className="slot-dashboard-workspace" aria-label="账号槽位">
        <header className="slot-workspace-heading">
          <div>
            <h2>我的游戏账号</h2>
            <p>每个槽位独立运行一个游戏账号。</p>
          </div>
          {(counts.active > 0 ||
            Object.values(d.laneStatuses ?? {}).some(isActiveStatus)) && (
            <div className="slot-global-actions">
              <button
                type="button"
                className="button slot-stop"
                disabled={!d.api}
                onClick={d.stopLanes}
              >
                <Square size={14} /> 停止全部槽位
              </button>
            </div>
          )}
        </header>
        {slots.length ? (
          <div className="slot-dashboard-grid">
            {slots.map((slot, index) => {
              const title = `${slot.game.name} · ${slot.accountName}`;
              const target = { laneId: slot.lane.id, gameId: slot.game.id };
              return (
                <article
                  key={slot.id}
                  className="slot-account-card"
                  data-slot-id={slot.id}
                  data-slot-lane-id={slot.lane.id}
                  data-slot-game-id={slot.game.id}
                  data-state={slot.status ?? "unverified"}
                >
                  <header className="slot-account-heading">
                    <span className="slot-number">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div>
                      <p className="slot-game-name">{slot.game.name}</p>
                      <h3>{slot.accountName}</h3>
                    </div>
                    <span
                      className={`slot-enabled ${slot.lane.enabled ? "is-enabled" : ""}`}
                    >
                      {slot.lane.enabled ? "已启用" : "已停用"}
                    </span>
                  </header>
                  <div
                    className="slot-game-binding"
                    data-game-id={slot.game.id}
                    data-device-instance={slot.game.instance}
                    data-profile-id={
                      slot.game.id === "arknights"
                        ? slot.lane.arknights.profileId
                        : undefined
                    }
                  >
                    <div>
                      <strong>
                        <Monitor size={14} /> MuMu 实例 {slot.game.instance}
                        <span>
                          {slot.game.clientLabel}
                          {slot.sharedWith.length > 0 && " · 共享实例"}
                        </span>
                      </strong>
                      <p>{slot.game.identityLabel}</p>
                    </div>
                  </div>
                  <div className="slot-account-summary">
                    <section
                      className="slot-record-status"
                      aria-label={`${title}最近执行记录`}
                    >
                      <span className="slot-record-label">最近执行记录</span>
                      <p role="status">{slot.label}</p>
                      {slot.facts.currentStep && (
                        <small>最近步骤：{slot.facts.currentStep.title}</small>
                      )}
                      {slot.facts.latestRequest &&
                        !slot.facts.currentPlanMatches && (
                          <small>历史记录 · 待核对账号与计划</small>
                        )}
                    </section>
                    <div className="slot-account-actions">
                      {slot.active ? (
                        <button
                          type="button"
                          className="button slot-stop"
                          aria-label={`停止槽位 ${title}`}
                          disabled={
                            !d.api ||
                            !slot.canStop ||
                            slot.status === "stopping"
                          }
                          onClick={() =>
                            slot.stopKind === "channel"
                              ? d.stopLane(slot.lane.id)
                              : d.stopGameSlot(target)
                          }
                        >
                          <Square size={14} />
                          {slot.status === "stopping"
                            ? "正在停止"
                            : "停止此游戏"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="button primary"
                          aria-label={`运行槽位 ${title}`}
                          disabled={preventStart || !slot.canRun}
                          onClick={() => d.startGameSlot(target)}
                        >
                          <Play size={14} />
                          运行此游戏
                        </button>
                      )}
                      <small>
                        {slot.active && !slot.canStop
                          ? "原账号计划运行中，单游戏停止范围未确认；可停止全部。"
                          : slot.blockedBy
                            ? `等待设备释放：${slot.blockedBy}`
                            : `仅运行${slot.game.name}`}
                      </small>
                    </div>
                  </div>
                  <details
                    className="slot-execution-details"
                    onToggle={(event) => {
                      const open = event.currentTarget.open;
                      setOpened((current) => ({ ...current, [slot.id]: open }));
                    }}
                  >
                    <summary>
                      <span>执行记录与分步结果</span>
                      <ChevronDown size={15} />
                    </summary>
                    <div className="slot-execution-meta">
                      <p>来源渠道：{slot.lane.name}</p>
                      <p>执行范围：仅{slot.game.name} · 此账号的保存计划</p>
                      {slot.sharedWith.length > 0 && (
                        <p>共享实例：{slot.sharedWith.join("、")}</p>
                      )}
                      <p>
                        {slot.gameDay
                          ? `原请求所属游戏日 ${slot.gameDay}`
                          : "暂无可关联的游戏日记录"}
                      </p>
                      {slot.facts.latestRequest &&
                        !slot.facts.currentPlanMatches && (
                          <p>此记录尚未匹配当前账号与计划，仅供历史核对。</p>
                        )}
                      {slot.facts.requestId && (
                        <p>来源请求：{slot.facts.requestId}</p>
                      )}
                    </div>
                    {opened[slot.id] && (
                      <div className="slot-execution-body">
                        <section>
                          <h4>{slot.game.name} · 本轮分步记录</h4>
                          <TaskProgress
                            records={slot.boundRecords}
                            laneId={slot.lane.id}
                            batchId={slot.facts.batchId}
                            gameId={slot.game.id}
                          />
                        </section>
                        {slot.facts.requestId && onOpenExecution && (
                          <button
                            type="button"
                            className="button"
                            onClick={() =>
                              onOpenExecution(slot.facts.requestId!)
                            }
                          >
                            查看原请求
                            <ArrowUpRight size={14} />
                          </button>
                        )}
                      </div>
                    )}
                  </details>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="slot-dashboard-empty">
            <Monitor size={28} />
            <h3>从第一个账号槽位开始</h3>
            <p>绑定模拟器和游戏账号后，这里会显示真实配置与运行记录。</p>
            <button
              type="button"
              className="button primary"
              onClick={() => d.setView("devices")}
            >
              配置设备与账号
              <ArrowUpRight size={14} />
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
