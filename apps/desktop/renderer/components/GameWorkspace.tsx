import { useState } from "react";
import { ArrowUpRight, Square } from "lucide-react";
import type { DesktopController } from "../hooks/useDesktop";
import { gameWorkspace } from "../game-workspaces";
import Workspace from "../views/Workspace";
import ArknightsSettings from "./ArknightsSettings";

const tabs = [
  ["tasks", "任务"],
  ["settings", "游戏设置"],
  ["records", "执行记录"],
  ["progress", "适配进展"],
] as const;
export default function GameWorkspace({
  desktop,
}: {
  desktop: DesktopController;
}) {
  const [tab, setTab] = useState<string>("tasks");
  const info = gameWorkspace(desktop.game);
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
        <nav className="workspace-tabs" aria-label="游戏工作区">
          {tabs.map(([id, title]) => (
            <button
              key={id}
              aria-current={tab === id ? "page" : undefined}
              className={tab === id ? "selected" : ""}
              onClick={() => setTab(id)}
            >
              {title}
            </button>
          ))}
        </nav>
      </header>
      {desktop.active && (
        <div className="run-strip" role="status">
          <span>
            <i className="tiny-dot" />
            任务正在运行 · {desktop.events.at(-1)?.message ?? "等待执行进度"}
          </span>
          <button
            className="button"
            disabled={!desktop.api || desktop.globalStatus === "stopping"}
            onClick={() => void desktop.stop()}
          >
            <Square size={13} />
            停止任务
          </button>
        </div>
      )}
      <div hidden={tab !== "tasks"}>
        <Workspace desktop={desktop} />
      </div>
      <div hidden={tab !== "settings"} className="workspace-section">
        {info.settingsKey === "arknights" ? (
          <ArknightsSettings desktop={desktop} />
        ) : (
          <section className="surface settings-placeholder">
            <h2>{desktop.game.name} · 游戏设置</h2>
            <p>
              当前任务继续使用已有策略。专属账号与任务策略面板将在后续适配中完善。
            </p>
            <button
              className="button"
              onClick={() => desktop.setView("settings")}
            >
              管理自动化设置 <ArrowUpRight size={14} />
            </button>
            <button
              className="button"
              onClick={() => desktop.setView("devices")}
            >
              管理设备与账号通道 <ArrowUpRight size={14} />
            </button>
          </section>
        )}
      </div>
      <div hidden={tab !== "records"}>
        <Workspace desktop={desktop} recordsOnly />
      </div>
      <div hidden={tab !== "progress"} className="workspace-section">
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
      </div>
    </div>
  );
}
