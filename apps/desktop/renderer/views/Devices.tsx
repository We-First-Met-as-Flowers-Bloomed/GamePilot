import { useEffect, useRef, useState } from "react";
import {
  RefreshCw,
  Monitor,
  Unplug,
  Play,
  Square,
  Save,
  Plus,
  Trash2,
  Layers3,
  Settings2,
  ChevronDown,
} from "lucide-react";
import type { DesktopController } from "../hooks/useDesktop";
import DevicePreview from "../components/DevicePreview";
import OnmyojiIdentitySettings from "../components/OnmyojiIdentitySettings";
import { laneDraftFromChannel, laneDraftsFromChannels } from "../channel-lane";
import ChannelCopy from "../components/ChannelCopy";
import { MAX_DEVICE_LANES } from "../../../../packages/protocol";
import { channelGame } from "../../../../packages/protocol/account-channel";
import "../channels.css";
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
    startGameSlot,
    startLanes,
    stopLane,
    stopLanes,
    laneStatuses,
    arknightsProfiles,
  } = desktop;
  const [newGame, setNewGame] = useState<"arknights" | "onmyoji">("arknights");
  const [discoveryGames, setDiscoveryGames] = useState<
    Record<number, "arknights" | "onmyoji" | "">
  >({});
  const advanced = useRef<HTMLDetailsElement>(null);
  const autoProbed = useRef(false);
  // channel-auto-scan：进入设备页时自动准备渠道列表，用户不必知道模拟器位置与端口。
  useEffect(() => {
    if (autoProbed.current || !api || desktop.hydrated === false) return;
    autoProbed.current = true;
    const managerPath = deviceLanes.lanes[0]?.managerPath ?? "";
    if (managerPath) {
      if (mumuInstances.length === 0) scanMuMuInstances(managerPath);
      return;
    }
    void (async () => {
      try {
        const found = await api.detectMuMu();
        const installation = found?.[0];
        if (!installation) return;
        setDeviceLanes((previous) => ({
          ...previous,
          lanes: previous.lanes.map((lane) =>
            lane.managerPath
              ? lane
              : {
                  ...lane,
                  managerPath: installation.managerPath,
                },
          ),
        }));
        scanMuMuInstances(installation.managerPath);
      } catch {
        // 检测失败时保持静默：用户仍可点「自动检测模拟器」手动触发。
      }
    })();
  }, [
    api,
    deviceLanes,
    desktop.hydrated,
    mumuInstances.length,
    scanMuMuInstances,
    setDeviceLanes,
  ]);
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
  const enabledCount = deviceLanes.lanes.filter((lane) => lane.enabled).length;
  const activeCount = deviceLanes.lanes.filter((lane) =>
    laneActive(lane.id),
  ).length;
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
    <div className="page channels-page">
      <header className="channels-heading">
        <div>
          <div className="eyebrow">DEVICE CHANNELS</div>
          <h1>账号与渠道</h1>
          <p className="intro">
            每个渠道绑定一个游戏账号和一台模拟器，账号、任务与运行记录独立保存。
          </p>
        </div>
        <span
          className={`channels-activity ${anyLaneActive ? "is-active" : ""}`}
        >
          <i aria-hidden="true" />
          {anyLaneActive
            ? `${activeCount} 个账号渠道处理中`
            : "当前没有处理中的账号渠道"}
        </span>
      </header>
      <dl className="channels-overview" aria-label="账号渠道概览">
        <div>
          <dt>账号渠道</dt>
          <dd>
            {deviceLanes.lanes.length}
            <span>个独立配置</span>
          </dd>
        </div>
        <div>
          <dt>已启用</dt>
          <dd>
            {enabledCount}
            <span>个参与运行</span>
          </dd>
        </div>
        <div>
          <dt>活动渠道</dt>
          <dd>
            {activeCount}
            <span>排队、运行或停止中</span>
          </dd>
        </div>
      </dl>

      <section className="surface lane-section">
        <div className="section-label">
          <div>
            <h2>账号渠道配置</h2>
            <p className="muted">
              选择该账号的设备与身份。任务清单在每日任务中编辑。
            </p>
          </div>
          <div className="lane-toolbar">
            <label>
              新增渠道的游戏
              <select
                value={newGame}
                disabled={active || !!busy || anyLaneActive}
                onChange={(event) =>
                  setNewGame(event.target.value as typeof newGame)
                }
              >
                <option value="arknights">明日方舟</option>
                <option value="onmyoji">阴阳师</option>
              </select>
            </label>
            <button
              className="button"
              disabled={
                !!busy ||
                active ||
                anyLaneActive ||
                deviceLanes.lanes.length >= MAX_DEVICE_LANES
              }
              onClick={() => {
                const instance =
                  Math.max(
                    -1,
                    ...deviceLanes.lanes.map((lane) => lane.instance),
                  ) + 1;
                setDeviceLanes({
                  ...deviceLanes,
                  version: 2,
                  lanes: [
                    ...deviceLanes.lanes,
                    {
                      id: `lane-${Date.now().toString(36)}`,
                      name: `${newGame === "arknights" ? "明日方舟" : "阴阳师"} · MuMu ${instance}`,
                      managerPath: deviceLanes.lanes[0]?.managerPath ?? "",
                      instance,
                      enabled: false,
                      arknights: {
                        enabled: newGame === "arknights",
                        profileId:
                          arknightsProfiles.activeProfileId || "default",
                      },
                      onmyoji: { enabled: newGame === "onmyoji" },
                      closeEmulatorAfterSuccess: false,
                    },
                  ],
                });
              }}
            >
              <Plus size={14} /> 添加账号渠道
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
                <Play size={14} /> 运行全部账号
              </button>
            )}
          </div>
        </div>
        {desktop.lanesDirty && (
          <p className="channels-unsaved" role="status">
            <Save size={14} /> 有未保存的配置。复制前请先保存当前账号渠道配置。
          </p>
        )}
        <div className="lane-grid">
          {deviceLanes.lanes.map((lane, index) => {
            const gameId = channelGame(lane);
            const detected = mumuInstances.find(
              (item) => item.instance === lane.instance,
            );
            const running = laneActive(lane.id);
            const status = laneStatuses[lane.id];
            const profile = arknightsProfiles.profiles.find(
              (item) => item.id === lane.arknights.profileId,
            );
            return (
              <article
                className={`lane-card ${running ? "is-running" : ""}`}
                key={lane.id}
                data-lane-id={lane.id}
                data-game-id={gameId}
                data-device-instance={lane.instance}
              >
                <div className="lane-card-head">
                  <span className="lane-card-number" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="lane-card-title">
                    <strong>{lane.name}</strong>
                    <span className="badge">
                      {gameId === "arknights"
                        ? "明日方舟"
                        : gameId === "onmyoji"
                          ? "阴阳师"
                          : "请核对游戏配置"}
                    </span>
                    <small>
                      <Monitor size={12} /> MuMu 实例 {lane.instance} ·{" "}
                      {detected?.ready ? "设备已就绪" : "设备待检测"}
                    </small>
                  </div>
                  <span
                    className={`badge lane-run-badge ${running ? "green" : status === "failed" ? "red" : ""}`}
                  >
                    {running
                      ? status === "stopping"
                        ? "正在停止"
                        : status === "queued"
                          ? "排队中"
                          : "运行中"
                      : status === "succeeded"
                        ? "上次运行结束"
                        : status === "failed"
                          ? "上次运行失败"
                          : status === "cancelled"
                            ? "已停止"
                            : lane.enabled
                              ? "待运行"
                              : "未启用"}
                  </span>
                </div>
                {gameId === "arknights" && (
                  <label className="lane-profile-field">
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
                    <span className="lane-binding-note">
                      {profile?.expectedUid?.trim()
                        ? "已配置 UID · 运行时核对身份"
                        : "尚未配置 UID"}
                    </span>
                  </label>
                )}
                {lane.identityRequired && (
                  <p className="muted">
                    {gameId === "arknights"
                      ? "请先填写此账号的 UID，再启用渠道。"
                      : "请先绑定此账号的阴阳师角色，再启用渠道。"}
                  </p>
                )}
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
                    启用此账号渠道
                  </label>
                </div>
                {gameId === "onmyoji" && (
                  <OnmyojiIdentitySettings
                    lane={lane}
                    api={api}
                    disabled={running || !!busy || active || anyLaneActive}
                    onChange={(identity) =>
                      updateLane(lane.id, {
                        onmyoji: { ...lane.onmyoji, identity },
                      })
                    }
                  />
                )}
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
                      <Square size={14} /> 停止此账号
                    </button>
                  ) : (
                    <button
                      className="button primary"
                      aria-label={`运行账号 ${lane.name}`}
                      onClick={() =>
                        gameId && startGameSlot({ laneId: lane.id, gameId })
                      }
                      disabled={
                        !api ||
                        !!busy ||
                        !gameId ||
                        !lane.enabled ||
                        (active && desktop.lanesDirty)
                      }
                    >
                      <Play size={14} /> 运行此账号
                    </button>
                  )}
                </div>
                <details className="lane-connection-details">
                  <summary>
                    <Settings2 size={14} /> 设备连接配置{" "}
                    <ChevronDown size={14} />
                  </summary>
                  <div className="lane-connection-fields">
                    <label>
                      MuMuManager.exe
                      <input
                        value={lane.managerPath}
                        disabled={running || !!busy || active}
                        onChange={(event) =>
                          updateLane(lane.id, {
                            managerPath: event.target.value,
                          })
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
                    {detected?.address && (
                      <p className="muted">
                        设备地址 <code>{detected.address}</code>
                      </p>
                    )}
                  </div>
                </details>
              </article>
            );
          })}
        </div>
        <div className="channels-copy-area">
          <Layers3 size={16} />
          <ChannelCopy
            lanes={deviceLanes}
            disabled={
              !api?.copyChannels ||
              !!busy ||
              active ||
              anyLaneActive ||
              desktop.lanesDirty
            }
            onCopy={desktop.copyChannels}
          />
        </div>
      </section>
      <details className="surface lane-section channel-discovery">
        <summary>
          <Monitor size={16} /> 发现与添加设备{" "}
          <span>{mumuInstances.length} 个扫描结果</span>
          <ChevronDown size={16} />
        </summary>
        <div className="section-label">
          <div>
            <h3>已发现的设备</h3>
            <p className="muted">
              扫描 MuMu
              实例并添加为独立账号渠道。安装多个游戏的设备，请选择本渠道使用的游戏。
            </p>
          </div>
          <div className="lane-toolbar">
            <button
              className="button"
              disabled={!!busy}
              onClick={() =>
                scanMuMuInstances(deviceLanes.lanes[0]?.managerPath)
              }
            >
              {busy === "mumu-instances" ? "扫描中…" : "重新扫描"}
            </button>

            <button
              className="button"
              disabled={!api || !!busy || active || anyLaneActive}
              onClick={async () => {
                if (!api) return;
                const found = await api.detectMuMu();
                const installation = found?.[0];
                if (!installation) return;
                setDeviceLanes((previous) => ({
                  ...previous,
                  lanes: previous.lanes.map((lane) => ({
                    ...lane,
                    managerPath: installation.managerPath,
                  })),
                }));
                scanMuMuInstances(installation.managerPath);
              }}
            >
              自动检测模拟器
            </button>

            <button
              className="button"
              disabled={!api || !!busy || active || anyLaneActive}
              onClick={() => {
                const additions = laneDraftsFromChannels(mumuInstances, {
                  managerPath: deviceLanes.lanes[0]?.managerPath ?? "",
                  profileId: arknightsProfiles.activeProfileId || "default",
                  boundInstances: deviceLanes.lanes.map(
                    (lane) => lane.instance,
                  ),
                  now: Date.now(),
                });
                if (additions.length === 0) return;
                setDeviceLanes({
                  ...deviceLanes,
                  version: 2,
                  lanes: [
                    ...deviceLanes.lanes,
                    ...additions.slice(
                      0,
                      MAX_DEVICE_LANES - deviceLanes.lanes.length,
                    ),
                  ],
                });
              }}
            >
              添加已识别游戏的设备
            </button>
          </div>
        </div>
        {mumuInstances.length === 0 ? (
          <p className="muted">还没有扫描结果，点「重新扫描」。</p>
        ) : (
          <ul className="channel-list">
            {mumuInstances.map((item) => {
              const supported = [...new Set(item.supportedGames ?? [])];
              const selectedGame =
                supported.length === 1
                  ? supported[0]
                  : discoveryGames[item.instance];
              const bound = deviceLanes.lanes.some(
                (lane) => lane.instance === item.instance,
              );
              const games: string[] = [];
              if (item.arknights)
                games.push(
                  `明日方舟（${item.arknights === "Bilibili" ? "B服" : "官服"}）`,
                );
              if (item.onmyoji) games.push("阴阳师");
              return (
                <li className="channel-row" key={item.instance}>
                  <span className="channel-name">实例 {item.instance}</span>
                  <code className="channel-address">{item.address}</code>
                  <span className="channel-games">
                    {games.length > 0
                      ? games.join(" · ")
                      : "（未装我们支持的游戏）"}
                  </span>
                  <span
                    className={
                      item.automationReady
                        ? "channel-badge channel-badge-ok"
                        : "channel-badge"
                    }
                  >
                    {item.automationReady
                      ? "✓ 可自动化"
                      : item.running
                        ? "暂不支持"
                        : "实例未运行"}
                  </span>
                  {supported.length > 1 && !bound && (
                    <select
                      aria-label={`实例 ${item.instance} 的游戏`}
                      value={selectedGame ?? ""}
                      disabled={active || anyLaneActive || !!busy}
                      onChange={(event) =>
                        setDiscoveryGames((previous) => ({
                          ...previous,
                          [item.instance]: event.target.value as
                            "arknights" | "onmyoji" | "",
                        }))
                      }
                    >
                      <option value="">选择一个游戏</option>
                      {supported.map((id) => (
                        <option key={id} value={id}>
                          {id === "arknights" ? "明日方舟" : "阴阳师"}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    className="button"
                    aria-label={`添加实例 ${item.instance} 的账号渠道`}
                    disabled={
                      !api ||
                      bound ||
                      !item.automationReady ||
                      !selectedGame ||
                      active ||
                      anyLaneActive ||
                      !!busy ||
                      deviceLanes.lanes.length >= MAX_DEVICE_LANES
                    }
                    onClick={() => {
                      if (!selectedGame) return;
                      const draft = laneDraftFromChannel(item, {
                        gameId: selectedGame,
                        managerPath: deviceLanes.lanes[0]?.managerPath ?? "",
                        profileId:
                          arknightsProfiles.activeProfileId || "default",
                        boundInstances: deviceLanes.lanes.map(
                          (lane) => lane.instance,
                        ),
                        now: Date.now(),
                      });
                      if (draft)
                        setDeviceLanes({
                          ...deviceLanes,
                          version: 2,
                          lanes: [...deviceLanes.lanes, draft],
                        });
                    }}
                  >
                    {bound ? "已绑定" : "添加账号"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </details>
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
