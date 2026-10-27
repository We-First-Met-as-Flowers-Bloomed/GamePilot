import { useState } from "react";
import { ArrowUpRight, Play, Square } from "lucide-react";
import type { DesktopController } from "../hooks/useDesktop";
import { channelGame } from "../../../../packages/protocol/account-channel";
import {
  aggregateStatus,
  isActiveStatus,
} from "../../../../packages/protocol/run-state";
import { gameWorkspace } from "../game-workspaces";
import { gameSlotRecords } from "../game-slot-records";
import { arknightsDailySkills } from "../../../../games/arknights/daily-plan";
import Workspace from "../views/Workspace";
import ArknightsSettings from "./ArknightsSettings";
import OnmyojiIdentitySettings from "./OnmyojiIdentitySettings";
import CopilotLibrary from "./CopilotLibrary";
import RoutineEditor from "./RoutineEditor";
import TaskProgress from "./TaskProgress";

const tabs = [
  ["tasks", "任务"],
  ["settings", "游戏设置"],
  ["records", "执行记录"],
  ["progress", "适配进展"],
] as const;
type Tab = (typeof tabs)[number][0];

export default function GameWorkspace({
  desktop,
}: {
  desktop: DesktopController;
}) {
  const [tab, setTab] = useState<Tab>("tasks");
  const [visited, setVisited] = useState<Partial<Record<Tab, boolean>>>({
    tasks: true,
  });
  const [selectedId, setSelectedId] = useState("");
  const [advancedOpened, setAdvancedOpened] = useState(false);
  const [copilotOpened, setCopilotOpened] = useState(false);
  const info = gameWorkspace(desktop.game);
  const lanes = desktop.deviceLanes.lanes.filter(
    (lane) => channelGame(lane) === desktop.game.id,
  );
  const lane = lanes.find((item) => item.id === selectedId) ?? lanes[0];
  const gameId = lane && channelGame(lane);
  const profile =
    gameId === "arknights"
      ? desktop.arknightsProfiles.profiles.find(
          (item) => item.id === lane.arknights.profileId,
        )
      : undefined;
  const facts =
    lane && gameId
      ? gameSlotRecords({
          lane,
          gameId,
          profile,
          requests: desktop.snapshot?.executions,
          tasks: desktop.taskRecords,
          events: desktop.allEvents,
          now: desktop.today,
        })
      : undefined;
  const currentLaneActive =
    !!lane && isActiveStatus(desktop.laneStatuses[lane.id]);
  const running = !!facts?.active || currentLaneActive;
  const canStop =
    running && (currentLaneActive || facts?.latestRequest?.laneId === lane?.id);
  const openTab = (next: Tab) => {
    setVisited((previous) => ({ ...previous, [next]: true }));
    setTab(next);
  };
  const scoped = lane
    ? {
        ...desktop,
        deviceLanes: { ...desktop.deviceLanes, lanes: [lane] },
        events: (desktop.events ?? []).filter(
          (event) =>
            event.laneId === lane.id ||
            (event.laneId === lane.legacyBinding?.laneId &&
              event.gameId === gameId),
        ),
      }
    : desktop;
  const runOrStop = () => {
    if (!lane || !gameId) return;
    const target = { laneId: lane.id, gameId };
    if (!running) desktop.startGameSlot(target);
    else if (canStop) {
      const owner = facts?.latestRequest?.snapshot.gameSlot as
        typeof target | undefined;
      if (owner?.laneId === lane.id && owner.gameId === gameId)
        desktop.stopGameSlot(target);
      else desktop.stopLane(lane.id);
    }
  };
  return (
    <div className="game-workspace">
      <header className="workspace-header">
        <div className="eyebrow">GAME WORKSPACE</div>
        <div className="workspace-title">
          <span className="workspace-mark">{info.mark}</span>
          <div>
            <h1>{desktop.game.name}</h1>
            <p>{info.description}</p>
          </div>
          <span className="badge">{info.status}</span>
        </div>
        <label>
          工作区账号
          <select
            aria-label="工作区账号"
            value={lane?.id ?? ""}
            disabled={!lanes.length}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {!lanes.length && <option value="">尚未绑定此游戏账号</option>}
            {lanes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · 实例 {item.instance}
              </option>
            ))}
          </select>
        </label>
        <nav className="workspace-tabs" aria-label="游戏工作区">
          {tabs.map(([id, title]) => (
            <button
              key={id}
              aria-current={tab === id ? "page" : undefined}
              className={tab === id ? "selected" : ""}
              onClick={() => openTab(id)}
            >
              {title}
            </button>
          ))}
        </nav>
      </header>
      {!lane && (
        <section className="surface">
          <p>先为此游戏添加独立账号渠道。</p>
          <button className="button" onClick={() => desktop.setView("devices")}>
            账号与渠道 <ArrowUpRight size={14} />
          </button>
        </section>
      )}
      {lane && gameId && (
        <>
          <div hidden={tab !== "tasks"}>
            <section className="surface" aria-label="所选账号任务">
              <div className="section-label">
                <h2>{lane.name} · 日常任务</h2>
                <span className="badge">MuMu 实例 {lane.instance}</span>
              </div>
              <p role="status">
                {currentLaneActive && !facts?.active
                  ? "账号任务处理中"
                  : facts?.label}
              </p>
              <button
                className="button primary"
                aria-label={`${running ? "停止" : "运行"}账号 ${lane.name}`}
                disabled={
                  !desktop.api ||
                  (running
                    ? !canStop ||
                      facts?.status === "stopping" ||
                      desktop.laneStatuses[lane.id] === "stopping"
                    : !!desktop.busy ||
                      !lane.enabled ||
                      (desktop.active && desktop.lanesDirty))
                }
                onClick={runOrStop}
              >
                {running ? <Square size={14} /> : <Play size={14} />}
                {running ? "停止此账号" : "运行此账号"}
              </button>
              {running && !canStop && (
                <p className="helper">
                  旧渠道请求仍在运行，可在工作台停止全部账号。
                </p>
              )}
              <RoutineEditor
                gameId={gameId}
                value={lane[gameId].routine}
                defaults={profile ? arknightsDailySkills(profile) : undefined}
                disabled={!desktop.api || desktop.active || !!desktop.busy}
                onChange={(routine) =>
                  desktop.setDeviceLanes((previous) => ({
                    ...previous,
                    version: 2,
                    lanes: previous.lanes.map((item) =>
                      item.id === lane.id
                        ? { ...item, [gameId]: { ...item[gameId], routine } }
                        : item,
                    ),
                  }))
                }
              />
              {desktop.lanesDirty && (
                <button
                  className="button"
                  disabled={!desktop.api || desktop.active || !!desktop.busy}
                  onClick={desktop.saveDeviceLanes}
                >
                  保存任务计划
                </button>
              )}
            </section>
            {gameId === "arknights" && (
              <details
                onToggle={(event) => {
                  if (event.currentTarget.open) setCopilotOpened(true);
                }}
              >
                <summary>高级任务 · 社区作业</summary>
                {copilotOpened && (
                  <CopilotLibrary
                    key={lane.id}
                    desktop={scoped}
                    onRecords={() => openTab("records")}
                  />
                )}
              </details>
            )}
            <details
              onToggle={(event) => {
                if (event.currentTarget.open) setAdvancedOpened(true);
              }}
            >
              <summary>高级设备工具</summary>
              {advancedOpened && <Workspace desktop={desktop} />}
            </details>
          </div>
          <div hidden={tab !== "settings"} className="workspace-section">
            {visited.settings &&
              (gameId === "arknights" ? (
                <ArknightsSettings
                  key={lane.id}
                  desktop={desktop}
                  profileId={lane.arknights.profileId}
                />
              ) : (
                <section className="surface">
                  <h2>{lane.name} · 角色设置</h2>
                  <OnmyojiIdentitySettings
                    key={lane.id}
                    lane={lane}
                    api={desktop.api}
                    disabled={!desktop.api || desktop.active || !!desktop.busy}
                    onChange={(identity) =>
                      desktop.setDeviceLanes((previous) => ({
                        ...previous,
                        version: 2,
                        lanes: previous.lanes.map((item) =>
                          item.id === lane.id
                            ? {
                                ...item,
                                onmyoji: { ...item.onmyoji, identity },
                              }
                            : item,
                        ),
                      }))
                    }
                  />
                  <button
                    className="button primary"
                    disabled={
                      !desktop.api ||
                      desktop.active ||
                      !!desktop.busy ||
                      !desktop.lanesDirty
                    }
                    onClick={desktop.saveDeviceLanes}
                  >
                    保存角色设置
                  </button>
                </section>
              ))}
          </div>
          <div hidden={tab !== "records"}>
            {visited.records && (
              <section className="surface">
                <h2>{lane.name} · 执行记录</h2>
                <p role="status">{facts?.label}</p>
                <TaskProgress
                  records={facts?.records}
                  laneId={facts?.latestRequest?.laneId ?? lane.id}
                  batchId={facts?.batchId}
                  gameId={gameId}
                />
                <Workspace
                  desktop={{
                    ...scoped,
                    status: aggregateStatus(scoped.events),
                    active: running,
                  }}
                  recordsOnly
                />
              </section>
            )}
          </div>
        </>
      )}
      <div hidden={tab !== "progress"} className="workspace-section">
        {visited.progress && (
          <>
            <div className="section-label">
              <h2>适配进展</h2>
              <span className="badge">{info.status}</span>
            </div>
            <p className="muted progress-intro">
              功能接入、参数校验和实机验证是不同阶段，以具体任务的验证记录为准。
            </p>
            {info.progress.map((item, index) => (
              <section className="progress-row" key={item.title}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.description}</p>
                </div>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
