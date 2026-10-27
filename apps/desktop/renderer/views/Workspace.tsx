import { groupedSkills } from "../game-workspaces";
import {
  Check,
  ListChecks,
  Square,
  Play,
  ShieldCheck,
  LoaderCircle,
  Circle,
} from "lucide-react";
import type { DesktopController } from "../hooks/useDesktop";
import type { RunStatus } from "../../../../packages/protocol";
const statusLabels: Record<RunStatus, string> = {
  queued: "等待开始",
  running: "运行中",
  stopping: "正在停止",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export default function Workspace({
  desktop,
  recordsOnly = false,
}: {
  desktop: DesktopController;
  recordsOnly?: boolean;
}) {
  const {
    dailyReady,
    startDaily,
    game,
    active,
    selected,
    toggle,
    mode,
    setMode,
    liveReady,
    api,
    busy,
    status,
    start,
    stop,
    events,
  } = desktop;
  return (
    <div className="workspace page">
      {!recordsOnly && (
        <>
          <div className="workspace-scope">
            <p>
              高级设备工具使用手动连接的设备与当前游戏档案。各账号的日常和定时任务在每日任务中管理。
            </p>
            <button
              className="text-button"
              onClick={() => desktop.setView("daily")}
            >
              返回每日计划
            </button>
          </div>
          <section className="composer" aria-label="每日任务">
            <div className="composer-top">
              <ListChecks size={18} />
              <strong>单设备日常 · 当前游戏</strong>
              <span className="badge">{desktop.daily.length} 个步骤</span>
            </div>
            <div className="daily-route">
              {desktop.daily.map((id, index) => (
                <span key={id}>
                  <b>{index + 1}</b>
                  {game.skills.find((skill) => skill.id === id)?.title ?? id}
                </span>
              ))}
            </div>
            <p>
              {game.id === "arknights"
                ? "启动后用现有理智代理作战，再完成基建一键轮换、好友和奖励；不使用理智药或源石。"
                : "签到、邮件、免费礼包、工作日麒麟，再按声望完成地域鬼王；礼包任务不会购买付费内容。"}
            </p>
            <p>完成后可查看执行记录；异常会停止并提示处理。</p>
            {active && (
              <p role="status">
                <LoaderCircle size={12} className="spin" />{" "}
                {status && statusLabels[status]} · {events.at(-1)?.message}
              </p>
            )}
            <div className="composer-actions">
              <span className="readiness">
                {dailyReady
                  ? "单设备执行 · 不使用多账号通道"
                  : "每日任务尚未完成实机适配"}
              </span>
              {active ? (
                <button
                  className="button"
                  disabled={!api || desktop.globalStatus === "stopping"}
                  onClick={() => {
                    void api?.stop().catch((reason) => {
                      desktop.setError(
                        reason instanceof Error
                          ? reason.message
                          : String(reason),
                      );
                    });
                  }}
                >
                  <Square size={14} />
                  {desktop.globalStatus === "stopping"
                    ? "正在停止…"
                    : "停止任务"}
                </button>
              ) : (
                <button
                  className="button primary"
                  disabled={!api || !!busy || active || !dailyReady}
                  onClick={startDaily}
                >
                  <Play size={14} />
                  {busy === "daily" ? "正在启动…" : "运行当前游戏"}
                </button>
              )}
            </div>
          </section>
          <div className="section-label task-section-heading">
            <h3>自定义任务</h3>
            <span>可多选</span>
          </div>
          {groupedSkills(game).map((group) => (
            <section className="skill-group" key={group.title}>
              <div className="group-heading">
                <h3>{group.title}</h3>
                <span>{group.skills.length} 项</span>
              </div>
              <div className="skill-list">
                {group.skills.map((skill, index) => (
                  <button
                    key={skill.id}
                    disabled={active || !!busy}
                    className={`skill-card ${selected.includes(skill.id) ? "checked" : ""}`}
                    aria-pressed={selected.includes(skill.id)}
                    onClick={() => toggle(skill.id)}
                  >
                    <span className="skill-number">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="skill-copy">
                      <strong>{skill.title}</strong>
                      <small>{skill.description}</small>
                    </span>
                    <span className="skill-tail">
                      <span className="readiness">
                        {skill.ready ? "已接入" : "待适配"}
                      </span>
                      <span className="checkbox">
                        {selected.includes(skill.id) && <Check size={13} />}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
          <div className="composer selection-composer">
            <div className="composer-top">
              <ListChecks size={18} />
              <strong>
                {selected.length
                  ? `已选择 ${selected.length} 项任务`
                  : "从上方选择任务，组建执行计划"}
              </strong>
            </div>
            <p>
              手动选择任务并检查运行模式，也可以{" "}
              <button className="text-button" onClick={desktop.openPlanner}>
                用 AI 规划日常
              </button>
              。
            </p>
            <div className="composer-actions">
              <div className="segmented" aria-label="运行模式">
                <button
                  className={mode === "rehearsal" ? "active" : ""}
                  disabled={active || !!busy}
                  onClick={() => setMode("rehearsal")}
                >
                  演练
                </button>
                <button
                  className={mode === "live" ? "active" : ""}
                  disabled={active || !liveReady}
                  title={
                    !liveReady
                      ? "需要连接设备，且所有选中技能均已完成实机适配"
                      : "实际操作设备"
                  }
                  onClick={() => setMode("live")}
                >
                  实机执行
                </button>
              </div>
              {active ? (
                <button
                  className="button"
                  disabled={
                    !api || !!busy || desktop.globalStatus === "stopping"
                  }
                  onClick={stop}
                >
                  <Square size={14} />
                  {desktop.globalStatus === "stopping"
                    ? "正在停止…"
                    : "停止任务"}
                </button>
              ) : (
                <button
                  className="button primary"
                  disabled={
                    !api ||
                    !!busy ||
                    !selected.length ||
                    (mode === "live" && !liveReady)
                  }
                  onClick={start}
                >
                  <Play size={14} />
                  {mode === "rehearsal" ? "开始演练" : "开始执行"}
                </button>
              )}
            </div>
          </div>
          <p className="helper">
            <ShieldCheck size={14} />
            演练仅检查任务流程，不操作设备，不代表游戏任务完成。
          </p>
        </>
      )}
      {recordsOnly && (
        <section className="activity">
          <div className="section-label">
            <h3>执行记录</h3>
            {status && (
              <span className={`badge ${status === "failed" ? "red" : ""}`}>
                {active && <LoaderCircle size={12} className="spin" />}
                {statusLabels[status]}
              </span>
            )}
          </div>
          {events.length ? (
            <ol className="event-list" aria-live="polite">
              {events.map((event, index) => (
                <li key={`${event.runId}-${index}`}>
                  <time>{new Date(event.at).toLocaleTimeString("zh-CN")}</time>
                  <Circle size={7} />
                  <span>
                    {event.laneId
                      ? `[${desktop.deviceLanes.lanes.find((lane) => lane.id === event.laneId)?.name ?? event.laneId}] `
                      : ""}
                    {event.message}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="empty-log">
              <ListChecks size={18} />
              <span>执行后，步骤和结果会显示在这里。</span>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
