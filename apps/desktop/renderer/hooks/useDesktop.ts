import {
  aggregateStatus,
  boundRunHistory,
} from "../../../../packages/protocol/run-state";
import { useEffect, useRef, useState } from "react";
import type {
  Device,
  DeviceLanes,
  MuMuInstance,
  RunEvent,
  Settings,
  Snapshot,
} from "../../../../packages/protocol";
import type { ArknightsProfiles } from "../../../../games/arknights/config";
import { games, dailySkills } from "../../../../games/registry";
import { dailyLaneState } from "../daily-state";
import {
  reduceTaskRecords,
  type TaskRecord,
} from "../../../../packages/protocol/task-record";
export type View =
  | "chat"
  | "daily"
  | "workspace"
  | "devices"
  | "library"
  | "settings"
  | "models";
const emptySettings: Settings = {
  adbPath: "",
  address: "",
  modelEndpoint: "",
  modelName: "",
};
const emptyLanes: DeviceLanes = { version: 1, lanes: [] };
const emptyArknights: ArknightsProfiles = {
  version: 1,
  activeProfileId: "default",
  profiles: [],
};

export function useDesktop() {
  const api = window.gamepilot;
  const [view, setView] = useState<View>("chat");
  const [entryTarget, setEntryTarget] = useState<
    "planner" | "connection" | null
  >(null);
  const [snapshot, setSnapshot] = useState<Snapshot>({
    games,
    settings: emptySettings,
    engine: null,
  });
  const [settings, setSettings] = useState<Settings>(emptySettings);
  const [selected, setSelected] = useState<string[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceLanes, setDeviceLanes] = useState<DeviceLanes>(emptyLanes);
  const savedLanes = useRef<DeviceLanes>(emptyLanes);
  const [mumuInstances, setMuMuInstances] = useState<MuMuInstance[]>([]);
  const [arknightsProfiles, setArknightsProfiles] =
    useState<ArknightsProfiles>(emptyArknights);
  const [scanned, setScanned] = useState(false);
  const [allEvents, setEvents] = useState<RunEvent[]>([]);
  const [taskRecords, setTaskRecords] = useState<TaskRecord[]>([]);
  const [today, setToday] = useState(() => new Date());
  const [gameId, setGameId] = useState("arknights");
  const events = allEvents.filter(
    (event) => (event.gameId ?? "onmyoji") === gameId,
  );
  const status = aggregateStatus(events);
  const globalStatus = aggregateStatus(allEvents);
  const busyRef = useRef(false);
  const stoppingRef = useRef(false);
  const [hydrated, setHydrated] = useState(false);
  const [mode, setMode] = useState<"rehearsal" | "live">("rehearsal");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [shot, setShot] = useState("");
  const [shotTime, setShotTime] = useState("");
  const game =
    snapshot.games.find((item) => item.id === gameId) ??
    games.find((item) => item.id === gameId) ??
    games[0];
  const daily = dailySkills(game.id);
  const active =
    globalStatus === "running" ||
    globalStatus === "queued" ||
    globalStatus === "stopping";
  const connected = snapshot.engine?.connected === true;
  const liveReady =
    connected &&
    selected.length > 0 &&
    selected.every((id) => game.skills.find((skill) => skill.id === id)?.ready);

  const dailyReady =
    hydrated &&
    daily.every((id) => game.skills.find((skill) => skill.id === id)?.ready);

  useEffect(() => {
    const timer = window.setInterval(() => setToday(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!api) return;
    let mounted = true;
    const incoming: RunEvent[] = [];
    let loading = true;
    const unsubscribe = api.onEvent((event) => {
      if (loading) incoming.push(event);
      if (event.type === "engine") {
        setSnapshot((previous) => ({ ...previous, engine: null }));
        setShot("");
        setShotTime("");
        setError(event.message);
      }
      setEvents((previous) => boundHistory([...previous, event]));
      setTaskRecords((previous) => reduceTaskRecords(previous, event));
      setToday(new Date());
      if (
        event.status &&
        ["succeeded", "failed", "cancelled"].includes(event.status)
      ) {
        void api
          .snapshot()
          .then((value) => {
            if (mounted)
              setSnapshot((previous) => ({
                ...previous,
                engine: value.engine,
                engineError: value.engineError,
                taskRecordError: value.taskRecordError,
                executions: value.executions,
              }));
          })
          .catch((reason) => {
            if (mounted) setError(String(reason));
          });
      }
    });
    Promise.all([api.snapshot(), api.deviceLanes(), api.arknights()])
      .then(([value, lanes, profiles]) => {
        if (!mounted) return;
        setSnapshot(
          incoming.some((event) => event.type === "engine")
            ? { ...value, engine: null }
            : value,
        );
        setSettings(value.settings);
        setDeviceLanes(lanes);
        savedLanes.current = lanes;
        setArknightsProfiles(profiles);
        setEvents(mergeHistory(value.events ?? [], incoming));
        setTaskRecords(incoming.reduce(reduceTaskRecords, value.runs ?? []));
        loading = false;
        incoming.length = 0;
        setHydrated(true);
      })
      .catch((reason) => {
        if (mounted) setError(String(reason));
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [api]);

  async function perform(key: string, action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }
  function selectGame(id: string) {
    if (active || busyRef.current || !games.some((item) => item.id === id))
      return;
    setGameId(id);
    setSelected([]);
    setMode("rehearsal");
    setNotice("");
    setError("");
    setView("workspace");
  }
  function toggle(id: string) {
    if (!active && !busyRef.current)
      setSelected((previous) =>
        previous.includes(id)
          ? previous.filter((value) => value !== id)
          : [...previous, id],
      );
  }
  function clearConnection() {
    setSnapshot((previous) => ({
      ...previous,
      engine: previous.engine ? { ...previous.engine, connected: false } : null,
    }));
    setShot("");
    setShotTime("");
  }
  async function refreshConnection() {
    if (!api) return;
    try {
      const latest = await api.snapshot();
      setSnapshot(latest);
    } catch {
      // The original device error is more useful than a second snapshot error.
      clearConnection();
    }
  }
  function connect(device: Device) {
    void perform("connect", async () => {
      if (!api) return;
      clearConnection();
      try {
        const engine = await api.connect(device);
        setSnapshot((previous) => ({
          ...previous,
          engine,
          settings: {
            ...previous.settings,
            adbPath: device.adbPath,
            address: device.address,
          },
          engineError: undefined,
        }));
        setSettings((previous) => ({
          ...previous,
          adbPath: device.adbPath,
          address: device.address,
        }));
        setNotice(`已连接 ${device.address}，设备已保存。`);
      } catch (reason) {
        await refreshConnection();
        throw reason;
      }
    });
  }
  function capture() {
    void perform("capture", async () => {
      if (!api) return;
      try {
        setShot(await api.capture());
        setShotTime(new Date().toLocaleTimeString("zh-CN"));
      } catch (reason) {
        clearConnection();
        await refreshConnection();
        throw reason;
      }
    });
  }
  function discover() {
    void perform("discover", async () => {
      if (!api) return;
      setDevices(await api.discover());
      setScanned(true);
    });
  }
  function start() {
    void perform("start", async () => {
      if (!api) return;

      await api.start({ gameId: game.id, skillIds: selected, mode });
    });
  }
  function startDaily() {
    void perform("daily", async () => {
      if (!api || active || !dailyReady) return;
      setMode("live");
      setSelected(daily);
      try {
        await api.start({
          gameId: game.id,
          skillIds: daily,
          mode: "live",
        });
      } finally {
        await refreshConnection();
      }
    });
  }
  function stop() {
    // A start/save receipt can still be pending when the worker begins emitting
    // progress. Cancellation must reach the host independently of that receipt.
    if (!api || stoppingRef.current) return;
    stoppingRef.current = true;
    void api
      .stop()
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        stoppingRef.current = false;
      });
  }
  function saveSettings() {
    void perform("save", async () => {
      if (!api) return;
      const saved = await api.saveSettings(settings);
      setSettings(saved);
      setSnapshot((previous) => ({ ...previous, settings: saved }));
      setNotice("设置已保存到本机。");
    });
  }

  function scanMuMuInstances(managerPath?: string) {
    void perform("mumu-instances", async () => {
      if (!api) return;
      setMuMuInstances(await api.mumuInstances(managerPath));
    });
  }
  function saveDeviceLanes() {
    void perform("device-lanes-save", async () => {
      if (!api) return;
      const saved = await api.saveDeviceLanes(deviceLanes);
      setDeviceLanes(saved);
      savedLanes.current = saved;
      setNotice("双设备配置已保存。 ");
    });
  }
  async function saveLanesBeforeRun() {
    if (!api) return;
    if (JSON.stringify(savedLanes.current) !== JSON.stringify(deviceLanes)) {
      const saved = await api.saveDeviceLanes(deviceLanes);
      savedLanes.current = saved;
      setDeviceLanes(saved);
    }
  }
  async function saveArknights(input: ArknightsProfiles) {
    if (!api) throw new Error("桌面接口不可用");
    const saved = await api.saveArknights(input);
    setArknightsProfiles(saved);
    return saved;
  }
  function startLane(laneId: string) {
    void perform(`lane-start:${laneId}`, async () => {
      if (api) {
        await saveLanesBeforeRun();
        await api.startLane(laneId);
      }
    });
  }
  function startLanes() {
    void perform("lanes-start", async () => {
      if (api) {
        await saveLanesBeforeRun();
        const receipt = await api.startLanes();
        if (receipt.issues?.length)
          setError(
            "其余账号已受理，以下账号未启动：" +
              receipt.issues.map((issue) => issue.message).join("；"),
          );
      }
    });
  }
  function stopLane(laneId: string) {
    void perform(`lane-stop:${laneId}`, async () => {
      if (api) await api.stopLane(laneId);
    });
  }
  function stopLanes() {
    void perform("lanes-stop", async () => {
      if (api) await api.stopLanes();
    });
  }
  const laneStatuses = Object.fromEntries(
    deviceLanes.lanes.map((lane) => {
      const event = [...allEvents]
        .reverse()
        .find(
          (item) =>
            item.laneId === lane.id &&
            item.batchId &&
            item.runId === item.batchId &&
            item.status,
        );
      return [lane.id, event?.status ?? null];
    }),
  ) as Record<string, RunEvent["status"] | null>;
  const laneDailyStates = Object.fromEntries(
    deviceLanes.lanes.map((lane) => [
      lane.id,
      dailyLaneState(lane, allEvents, today, snapshot?.executions),
    ]),
  );

  return {
    api,
    view,
    setView,
    entryTarget,
    clearEntryTarget: () => setEntryTarget(null),
    openPlanner: () => {
      setEntryTarget("planner");
      setView("chat");
    },
    openDeviceConnection: () => {
      setEntryTarget("connection");
      setView("devices");
    },
    snapshot,
    settings,
    setSettings,
    selected,
    setSelected,
    devices,
    deviceLanes,
    lanesDirty:
      JSON.stringify(savedLanes.current) !== JSON.stringify(deviceLanes),
    setDeviceLanes,
    mumuInstances,
    arknightsProfiles,
    saveArknights,
    allEvents,
    taskRecords,
    scanned,
    events,
    status,
    mode,
    setMode,
    busy,
    error,
    setError,
    notice,
    shot,
    shotTime,
    game,
    games: snapshot.games,
    selectGame,
    globalStatus,
    daily,
    active,
    connected,
    liveReady,
    dailyReady,
    startDaily,
    toggle,
    connect,
    capture,
    discover,
    start,
    stop,
    saveSettings,
    scanMuMuInstances,
    saveDeviceLanes,
    startLane,
    startLanes,
    stopLane,
    stopLanes,
    laneStatuses,
    laneDailyStates,
    perform,
    updateExecution: (
      record: import("../../../../packages/protocol/execution").ExecutionRecord,
    ) =>
      setSnapshot((previous) => ({
        ...previous,
        executions: previous.executions?.map((r) =>
          r.id === record.id ? record : r,
        ),
      })),
  };
}
export type DesktopController = ReturnType<typeof useDesktop>;

export function mergeHistory(
  history: RunEvent[],
  incoming: RunEvent[],
): RunEvent[] {
  const key = (event: RunEvent) => JSON.stringify(event);
  const counts = new Map<string, number>();
  for (const event of history)
    counts.set(key(event), (counts.get(key(event)) ?? 0) + 1);
  const result = [...history];
  for (const event of incoming) {
    const remaining = counts.get(key(event)) ?? 0;
    if (remaining) counts.set(key(event), remaining - 1);
    else result.push(event);
  }
  return boundHistory(result);
}

function boundHistory(events: RunEvent[]): RunEvent[] {
  return boundRunHistory(events);
}
