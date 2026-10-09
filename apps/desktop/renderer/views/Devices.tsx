import { useEffect, useRef } from "react";
import {
  RefreshCw,
  Monitor,
  Unplug,
  Play,
  Square,
  Save,
  Plus,
  Trash2,
} from "lucide-react";
import type { DesktopController } from "../hooks/useDesktop";
import DevicePreview from "../components/DevicePreview";
export default function Devices({ desktop }: { desktop: DesktopController }) {
  const {
    discover,
    api,
    busy,
    active,
    devices,
    connect,
    scanned,
    settings,
    setSettings,
    saveSettings,
    deviceLanes,
    setDeviceLanes,
    mumuInstances,
    scanMuMuInstances,
    saveDeviceLanes,
    startLane,
    startLanes,
    stopLane,
    stopLanes,
    laneStatuses,
    arknightsProfiles,
  } = desktop;
  const advanced = useRef<HTMLDetailsElement>(null);
  const adbInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (desktop.entryTarget !== "connection" || !advanced.current) return;
    advanced.current.open = true;
    window.scrollTo({
      top: window.scrollY + advanced.current.getBoundingClientRect().top - 24,
    });
    adbInput.current?.focus({ preventScroll: true });
    desktop.clearEntryTarget();
  }, [desktop.entryTarget, desktop.clearEntryTarget]);
  const laneActive = (id: string) =>
    ["queued", "running", "stopping"].includes(laneStatuses[id] ?? "");
  const anyLaneActive = deviceLanes.lanes.some((lane) => laneActive(lane.id));
  const updateLane = (
    id: string,
    change: Partial<(typeof deviceLanes.lanes)[number]>,
  ) =>
    setDeviceLanes({
      ...deviceLanes,
      lanes: deviceLanes.lanes.map((lane) =>
        lane.id === id ? { ...lane, ...change } : lane,
      ),
    });
  return (
    <div className="page">
      <div className="eyebrow">DEVICE CONNECTION</div>
      <h1>连接你的游戏设备</h1>
      <p className="intro">
        为每日计划绑定模拟器与账号；单设备工具的 ADB 配置在下方高级连接中管理。
      </p>
      <section className="surface lane-section">
        <div className="section-label">
          <div>
            <h3>双账号流水线</h3>
            <p className="muted">
              启用的设备并行运行；每台只执行已勾选游戏，方舟完成退出后再运行阴阳师。修改后点击运行会先保存。
            </p>
          </div>
          <div className="lane-toolbar">
            <button
              className="button"
              disabled={
                !!busy ||
                active ||
                anyLaneActive ||
                deviceLanes.lanes.length >= 8
              }
              onClick={() => {
                const instance =
                  Math.max(
                    -1,
                    ...deviceLanes.lanes.map((lane) => lane.instance),
                  ) + 1;
                setDeviceLanes({
                  ...deviceLanes,
                  lanes: [
                    ...deviceLanes.lanes,
                    {
                      id: `lane-${Date.now().toString(36)}`,
                      name: `MuMu ${instance}`,
                      managerPath: deviceLanes.lanes[0]?.managerPath ?? "",
                      instance,
                      enabled: false,
                      arknights: {
                        enabled: true,
                        profileId:
                          arknightsProfiles.activeProfileId || "default",
                      },
                      onmyoji: { enabled: false },
                      closeEmulatorAfterSuccess: false,
                    },
                  ],
                });
              }}
            >
              <Plus size={14} /> 添加设备
            </button>
            <button
              className="button"
              disabled={!api || !!busy || active || anyLaneActive}
              onClick={() =>
                scanMuMuInstances(deviceLanes.lanes[0]?.managerPath)
              }
            >
              <RefreshCw
                size={14}
                className={busy === "mumu-instances" ? "spin" : ""}
              />
              检测实例
            </button>
            <button
              className="button"
              disabled={!api || !!busy || active || anyLaneActive}
              onClick={saveDeviceLanes}
            >
              <Save size={14} /> 保存
            </button>
            {anyLaneActive ? (
              <button className="button" onClick={stopLanes} disabled={!api}>
                <Square size={14} /> 停止全部
              </button>
            ) : (
              <button
                className="button primary"
                onClick={startLanes}
                disabled={
                  !api || !!busy || !deviceLanes.lanes.some((x) => x.enabled)
                }
              >
                <Play size={14} /> 运行全部
              </button>
            )}
          </div>
        </div>
        <div className="lane-grid">
          {deviceLanes.lanes.map((lane) => {
            const detected = mumuInstances.find(
              (item) => item.instance === lane.instance,
            );
            const running = laneActive(lane.id);
            return (
              <article className="lane-card" key={lane.id}>
                <div className="lane-card-head">
                  <div>
                    <strong>{lane.name}</strong>
                    <small>
                      实例 {lane.instance}
                      {detected?.address ? ` · ${detected.address}` : ""}
                    </small>
                  </div>
                  <span className={`badge ${running ? "green" : ""}`}>
                    {running
                      ? laneStatuses[lane.id] === "stopping"
                        ? "正在停止"
                        : "运行中"
                      : laneStatuses[lane.id] === "succeeded"
                        ? "已完成"
                        : laneStatuses[lane.id] === "failed"
                          ? "失败"
                          : detected?.ready
                            ? "已就绪"
                            : "待检测"}
                  </span>
                </div>
                <label>
                  MuMuManager.exe
                  <input
                    value={lane.managerPath}
                    disabled={running || !!busy || active}
                    onChange={(event) =>
                      updateLane(lane.id, { managerPath: event.target.value })
                    }
                  />
                </label>
                <label>
                  实例编号
                  <input
                    type="number"
                    min="0"
                    max="999"
                    value={lane.instance}
                    disabled={running || !!busy || active}
                    onChange={(event) =>
                      updateLane(lane.id, {
                        instance: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  明日方舟账号档案
                  <select
                    value={lane.arknights.profileId}
                    disabled={running || !!busy || active}
                    onChange={(event) =>
                      updateLane(lane.id, {
                        arknights: {
                          ...lane.arknights,
                          profileId: event.target.value,
                        },
                      })
                    }
                  >
                    {arknightsProfiles.profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name} ·{" "}
                        {profile.clientType === "Bilibili" ? "B服" : "官服"}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="lane-games">
                  <label>
                    <input
                      type="checkbox"
                      checked={lane.enabled}
                      disabled={running || !!busy || active}
                      onChange={(event) =>
                        updateLane(lane.id, { enabled: event.target.checked })
                      }
                    />
                    启用此设备
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={lane.arknights.enabled}
                      disabled={running || !!busy || active}
                      onChange={(event) =>
                        updateLane(lane.id, {
                          arknights: {
                            ...lane.arknights,
                            enabled: event.target.checked,
                          },
                        })
                      }
                    />
                    明日方舟
                    {detected?.arknights
                      ? `（${detected.arknights === "Bilibili" ? "B服" : "官服"}）`
                      : ""}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={lane.onmyoji.enabled}
                      disabled={running || !!busy || active}
                      onChange={(event) =>
                        updateLane(lane.id, {
                          onmyoji: {
                            ...lane.onmyoji,
                            enabled: event.target.checked,
                          },
                        })
                      }
                    />
                    阴阳师{detected?.onmyoji ? "（已安装）" : ""}
                  </label>
                </div>
                <div className="lane-card-actions">
                  {deviceLanes.lanes.length > 1 && !running && (
                    <button
                      className="button"
                      aria-label={`删除 ${lane.name}`}
                      disabled={active || !!busy}
                      onClick={() =>
                        setDeviceLanes({
                          ...deviceLanes,
                          lanes: deviceLanes.lanes.filter(
                            (item) => item.id !== lane.id,
                          ),
                        })
                      }
                    >
                      <Trash2 size={14} /> 删除
                    </button>
                  )}
                  {running ? (
                    <button
                      className="button"
                      onClick={() => stopLane(lane.id)}
                      disabled={!api || laneStatuses[lane.id] === "stopping"}
                    >
                      <Square size={14} /> 停止此设备
                    </button>
                  ) : (
                    <button
                      className="button primary"
                      onClick={() => startLane(lane.id)}
                      disabled={!api || !!busy || active || !lane.enabled}
                    >
                      <Play size={14} /> 运行此设备
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>
      <section className="inline-device surface">
        <DevicePreview desktop={desktop} />
      </section>
      <details
        ref={advanced}
        className="surface device-advanced"
        id="device-advanced"
      >
        <summary>高级连接 · 单设备工具</summary>
        <p className="muted">
          扫描或手动连接一个设备，用于单设备任务和设备预览。每日计划继续使用上方绑定的模拟器。
        </p>
        <section className="advanced-scan">
          <div className="section-label">
            <h3>可用设备</h3>
            <button
              className="button"
              onClick={discover}
              disabled={!api || !!busy || active}
            >
              <RefreshCw
                size={14}
                className={busy === "discover" ? "spin" : ""}
              />
              {busy === "discover" ? "扫描中…" : "扫描设备"}
            </button>
          </div>
          {devices.length ? (
            devices.map((device, index) => (
              <div className="device-row" key={`${device.address}-${index}`}>
                <Monitor size={22} />
                <div>
                  <strong>{device.name}</strong>
                  <small>{device.address}</small>
                </div>
                <button
                  className="button"
                  disabled={!api || !!busy || active}
                  onClick={() => connect(device)}
                >
                  连接
                </button>
              </div>
            ))
          ) : (
            <div className="empty-block">
              <Unplug size={25} />
              <p>
                {scanned
                  ? "未发现设备，请确认模拟器已启动并开启 ADB。"
                  : "点击扫描，查找正在运行的模拟器。"}
              </p>
            </div>
          )}
        </section>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            saveSettings();
          }}
        >
          <h3>手动连接</h3>
          <p className="muted">使用模拟器提供的 ADB 程序路径与连接地址。</p>
          <label htmlFor="device-adb-path">
            ADB 程序路径
            <input
              ref={adbInput}
              id="device-adb-path"
              value={settings.adbPath}
              placeholder="C:\\…\\adb.exe"
              onChange={(event) =>
                setSettings({
                  ...settings,
                  adbPath: event.target.value,
                })
              }
            />
          </label>
          <label htmlFor="device-address">
            设备地址
            <input
              id="device-address"
              value={settings.address}
              placeholder="127.0.0.1:端口"
              onChange={(event) =>
                setSettings({
                  ...settings,
                  address: event.target.value,
                })
              }
            />
          </label>
          <div className="lane-toolbar">
            <button
              className="button"
              type="submit"
              disabled={!api || !!busy || active}
            >
              <Save size={14} />
              {busy === "save" ? "保存中…" : "保存连接设置"}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={
                !api ||
                !!busy ||
                active ||
                !settings.adbPath.trim() ||
                !settings.address.trim()
              }
              onClick={() =>
                connect({
                  name: "手动连接",
                  adbPath: settings.adbPath,
                  address: settings.address,
                })
              }
            >
              {busy === "connect" ? "连接中…" : "连接设备"}
            </button>
          </div>
        </form>
      </details>
    </div>
  );
}
