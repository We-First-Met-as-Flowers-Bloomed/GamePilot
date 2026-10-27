import type { ArknightsProfiles } from "../../games/arknights/config";
import { validateRoutine, type Routine } from "./routine";
import { validOnmyojiEvidence } from "./onmyoji-evidence";
import { canonicalChannelDeviceKey } from "./account-channel";
import {
  validateOnmyojiIdentityBinding,
  validOnmyojiIdentityEvidence,
} from "./onmyoji-identity";
export type RunStatus =
  "queued" | "running" | "stopping" | "succeeded" | "failed" | "cancelled";
export interface Skill {
  maintenanceOnly?: boolean;
  id: string;
  title: string;
  description: string;
  ready: boolean;
  weekdays?: number[];
  position?: "first" | "last";
}
export interface Game {
  id: string;
  name: string;
  subtitle: string;
  skills: Skill[];
}
export interface Plan {
  gameId: string;
  skillIds: string[];
  mode: "rehearsal" | "live";
}
/** One game account; the backing DeviceLane may also configure other games. */
export interface GameSlotTarget {
  laneId: string;
  gameId: "arknights" | "onmyoji";
}
export interface Settings {
  adbPath: string;
  address: string;
  modelEndpoint: string;
  modelName: string;
}
export interface Device {
  name: string;
  adbPath: string;
  address: string;
}
export interface EngineInfo {
  version: string;
  connected: boolean;
  address?: string;
}
export interface SkillResult {
  /** Structured adapter facts; legacy summaries are never converted into these fields. */
  skipReason?:
    | "already-completed"
    | "not-open"
    | "user-excluded"
    | "unavailable"
    | "unknown"
    | "nothing-to-claim";
  goalSatisfied?: boolean | null;
  evidenceTimestamp?: string;
  evidenceReference?: string;
  arknights?: import("../../games/arknights/evidence").ArknightsExecutionEvidence;
  onmyoji?: import("./onmyoji-evidence").OnmyojiExecutionEvidence;
  onmyojiIdentity?: import("./onmyoji-identity").OnmyojiIdentityEvidence;
  status?: "succeeded" | "skipped";
  summary?: string;
  outcome?: string;
  observedAt?: string;
  nextRunAt?: string;
}
export function validStructuredSkillOutcome(
  input: SkillResult | undefined,
): boolean {
  if (!input) return true;
  if (
    input.onmyojiIdentity !== undefined &&
    !validOnmyojiIdentityEvidence(input.onmyojiIdentity)
  )
    return false;
  if (
    input.onmyoji !== undefined &&
    (!validOnmyojiEvidence(input.onmyoji) ||
      (input.goalSatisfied === true && input.onmyoji.phase !== "confirmed"))
  )
    return false;
  if (
    input.goalSatisfied !== undefined &&
    input.goalSatisfied !== null &&
    typeof input.goalSatisfied !== "boolean"
  )
    return false;
  if (
    input.skipReason !== undefined &&
    ![
      "already-completed",
      "not-open",
      "user-excluded",
      "unavailable",
      "unknown",
      "nothing-to-claim",
    ].includes(input.skipReason)
  )
    return false;
  if (
    input.goalSatisfied === true &&
    ["not-open", "user-excluded", "unavailable", "unknown"].includes(
      input.skipReason ?? "",
    )
  )
    return false;
  if (
    input.evidenceTimestamp !== undefined &&
    (typeof input.evidenceTimestamp !== "string" ||
      !Number.isFinite(Date.parse(input.evidenceTimestamp)))
  )
    return false;
  if (
    input.evidenceReference !== undefined &&
    (typeof input.evidenceReference !== "string" ||
      !input.evidenceReference ||
      input.evidenceReference.length > 512 ||
      /[\x00-\x1f]/.test(input.evidenceReference))
  )
    return false;
  if (
    input.goalSatisfied !== undefined &&
    (!input.evidenceTimestamp || !input.evidenceReference)
  )
    return false;
  return true;
}
export interface RunEvent {
  stepControl?: import("./step-control").PauseAfterStepReceipt;
  executionSource?: import("./execution").ExecutionRequest["source"];
  executionId?: string;
  /** Execution plan and outcomes; never inferred from human-readable logs. */
  plan?: Plan;
  stepStatus?: "running" | "succeeded" | "skipped" | "failed" | "cancelled";
  stepEvidence?: "adapter-return" | "adapter-result" | "rehearsal";
  resultUncertain?: boolean;
  fault?: import("./fault").FailureEvidence;
  laneName?: string;
  instance?: number;
  profileId?: string;
  planKey?: string;
  startedAt?: string;
  maintenance?: boolean;
  laneId?: string;
  batchId?: string;
  gameId?: string;
  runId: string;
  type: "status" | "step" | "log" | "engine";
  message: string;
  at: string;
  status?: RunStatus;
  skillId?: string;
  result?: SkillResult;
}
export interface Snapshot {
  plannerPreview?: boolean;
  executions?: import("./execution").ExecutionRecord[];
  runs?: import("./task-record").TaskRecord[];
  taskRecordError?: string;
  events?: RunEvent[];
  games: Game[];
  settings: Settings;
  engine: EngineInfo | null;
  engineError?: string;
}
export interface DesktopAPI {
  arknightsActivity?(input: {
    clientType: "Official" | "Bilibili";
    refresh?: boolean;
  }): Promise<import("./arknights-activity").ArknightsActivityCatalog>;
  importMaaSettings?(input: { profileId: string }): Promise<{
    config: import("../../games/arknights/config").ArknightsConfig;
    warnings: string[];
  } | null>;
  goalSnapshot?(sessionId?: string): Promise<import("./agent-goal").GoalView>;
  onGoalState?(
    listener: (view: import("./agent-goal").GoalView) => void,
  ): () => void;
  cancelGoal?(input: {
    goalId: string;
    sessionId: string;
  }): Promise<import("./agent-goal").GoalRun>;
  reviewChatIntent(
    input: import("./chat-commands").ChatIntentReviewInput,
  ): Promise<import("./chat-commands").ChatCommandView>;
  chatCommands(
    sessionId?: string,
  ): Promise<import("./chat-commands").ChatCommandView[]>;
  reviewChatCommand(
    input: import("./chat-commands").ChatCommandReviewInput,
  ): Promise<import("./chat-commands").ChatCommandView>;
  confirmChatCommand(
    input: import("./chat-commands").ChatCommandConfirmation,
  ): Promise<import("./chat-commands").ChatCommandView>;
  pauseAfterStep(input: {
    sessionId: string;
    requestId: string;
    revision: 1;
  }): Promise<import("./step-control").PauseAfterStepReceipt>;
  archiveChat(
    input: import("./agent-chat").ChatArchiveInput,
  ): Promise<import("./agent-chat").ChatView>;
  restoreArchivedChat(
    input: import("./agent-chat").RestoreArchivedChatInput,
  ): Promise<import("./agent-chat").ChatView>;
  deleteChat(
    input: import("./agent-chat").DeleteChatInput,
  ): Promise<import("./agent-chat").ChatView>;
  listArchivedChats(
    input?: import("./agent-chat").ChatArchivePageInput,
  ): Promise<import("./agent-chat").ChatArchivePage>;
  loadArchivedChat(
    input: import("./agent-chat").ChatArchiveLoadInput,
  ): Promise<import("./agent-chat").ChatArchiveTurnsPage>;
  agentEvents(
    input?: import("./agent-events").AgentEventQuery,
  ): Promise<import("./agent-events").AgentEventPage>;
  onAgentEvent(
    listener: (event: import("./agent-events").AgentEvent) => void,
  ): () => void;
  onAgentError(listener: (message: string) => void): () => void;
  onPlannerState(
    listener: (state: import("./agent-planner").PlannerViewState) => void,
  ): () => void;
  onPlannerStream(
    listener: (value: {
      requestId: string;
      event: import("./agent-planner").PlannerStreamEvent;
    }) => void,
  ): () => void;
  onChatState(
    listener: (state: import("./agent-chat").ChatView) => void,
  ): () => void;
  newChat(): Promise<import("./agent-chat").ChatView>;
  selectChat(id: string): Promise<import("./agent-chat").ChatView>;
  chatSnapshot(): Promise<import("./agent-chat").ChatView>;
  sendChat(
    input: import("./agent-chat").ChatInput,
  ): Promise<import("./agent-chat").ChatView>;
  cancelChat(
    input: import("./agent-chat").ChatTurnTarget,
  ): Promise<import("./agent-chat").ChatView>;
  executionProgress(
    id: string,
  ): Promise<import("./execution-progress").ExecutionProgress>;
  previewContinuation(
    id: string,
  ): Promise<import("./continuation").ContinuationPreview>;
  startContinuation(
    input: import("./continuation").ContinuationInput,
  ): Promise<{ requestId: string; batchId: string }>;
  executionDetail(
    id: string,
  ): Promise<import("./execution-detail").ExecutionDetail>;
  modelProvider(): Promise<import("./model-provider").ModelProviderView>;
  saveModelProvider(
    input: import("./model-provider").ModelProviderInput,
  ): Promise<import("./model-provider").ModelProviderView>;
  testModelProvider(): Promise<import("./model-provider").ModelConnectionTest>;
  failureEvidence(
    id: string,
  ): Promise<import("./failure-view").FailureEvidenceSummary[]>;
  readFailureImage(
    input: import("./failure-view").FailureEvidenceTarget,
  ): Promise<import("./failure-view").FailureImageView>;
  deleteFailureImage(
    input: import("./failure-view").FailureEvidenceTarget,
  ): Promise<void>;
  plannerSnapshot(): Promise<import("./agent-planner").PlannerViewState>;
  incidentAgentSnapshot(): Promise<
    import("./incident-agent").IncidentAgentView
  >;
  onIncidentAgentState(
    listener: (view: import("./incident-agent").IncidentAgentView) => void,
  ): () => void;
  diagnoseFailure(
    input: import("./incident-agent").IncidentAgentInput,
  ): Promise<import("./incident-agent").IncidentAgentView>;
  cancelFailureDiagnosis(
    id: string,
  ): Promise<import("./incident-agent").IncidentAgentView>;
  confirmFailureContinuation(
    id: string,
  ): Promise<import("./incident-agent").IncidentAgentView>;
  agentExecutionSnapshot(): Promise<
    import("./agent-execution").AgentExecutionView
  >;
  reviewAgentExecution(
    input: import("./agent-execution").AgentExecutionTarget,
  ): Promise<import("./agent-execution").AgentExecutionView>;
  confirmAgentExecution(
    input: import("./agent-execution").AgentExecutionConfirmation,
  ): Promise<import("./agent-execution").AgentExecutionView>;
  cancelAgentExecution(
    requestId: string,
  ): Promise<import("./agent-execution").AgentExecutionView>;
  startPlanner(
    input: import("./agent-planner").PlannerInput,
  ): Promise<import("./agent-planner").PlannerViewState>;
  cancelPlanner(
    requestId: string,
  ): Promise<import("./agent-planner").PlannerViewState>;
  reviewExecution(id: string): Promise<import("./recovery").RecoveryAssessment>;
  inspectExecution(id: string): Promise<import("./recovery").DeviceInspection>;
  resolveExecution(input: {
    id: string;
    note: string;
  }): Promise<import("./execution").ExecutionRecord>;
  deviceLanes(): Promise<DeviceLanes>;
  copyChannels?(
    input: import("./channel").ChannelCopyInput,
  ): Promise<import("./channel").ChannelCopyResult>;
  saveDeviceLanes(input: DeviceLanes): Promise<DeviceLanes>;
  inspectOnmyojiIdentity(
    laneId: string,
  ): Promise<import("./onmyoji-identity").OnmyojiIdentityInspection>;
  mumuInstances(managerPath?: string): Promise<MuMuInstance[]>;
  startGameSlot(
    input: GameSlotTarget & { requestId?: string },
  ): Promise<{ batchId: string }>;
  stopGameSlot(input: GameSlotTarget): Promise<void>;
  startLane(laneId: string, requestId?: string): Promise<{ batchId: string }>;
  startLanes(requestId?: string): Promise<{
    batchId: string;
    issues?: { laneId: string; message: string }[];
  }>;
  stopLane(laneId: string): Promise<void>;
  stopLanes(): Promise<void>;
  arknights(): Promise<ArknightsProfiles>;
  onmyojiAutomation?(): Promise<
    import("./onmyoji-automation").OnmyojiAutomationConfig
  >;
  saveOnmyojiAutomation?(
    input: import("./onmyoji-automation").OnmyojiAutomationConfig,
  ): Promise<import("./onmyoji-automation").OnmyojiAutomationConfig>;
  runOnmyojiJob?(
    input: import("./onmyoji-automation").RunOnmyojiJobInput,
  ): Promise<{ batchId: string }>;
  arknightsAutomation?(): Promise<
    import("./arknights-automation").ArknightsAutomationConfig
  >;
  saveArknightsAutomation?(
    input: import("./arknights-automation").ArknightsAutomationConfig,
  ): Promise<import("./arknights-automation").ArknightsAutomationConfig>;
  runArknightsJob?(
    input: import("./arknights-automation").RunArknightsJobInput,
  ): Promise<{ batchId: string }>;
  saveArknights(input: ArknightsProfiles): Promise<ArknightsProfiles>;
  probeArknights(): Promise<{ version: string }>;
  searchCopilot(input: {
    stage: string;
    limit: number;
  }): Promise<
    import("../../games/arknights/copilot-library").CopilotJobSummary[]
  >;
  prepareCopilot(
    input: import("./copilot").CopilotPreparationInput,
  ): Promise<import("./copilot").PreparedCopilotPlan>;
  confirmCopilot(
    input: import("./copilot").CopilotConfirmation,
  ): Promise<{ batchId: string; requestId: string; laneId: string }>;
  cancelCopilot(input: {
    batchId: string;
    requestId: string;
    laneId: string;
  }): Promise<{ stopped: boolean; message: string }>;
  quit(): Promise<void>;
  testNotification(): Promise<string>;
  automation(): Promise<AutomationSettings>;
  saveAutomation(input: AutomationSettings): Promise<AutomationSettings>;
  detectMuMu(): Promise<MuMuInstallation[]>;
  snapshot(): Promise<Snapshot>;
  saveSettings(settings: Settings): Promise<Settings>;
  discover(): Promise<Device[]>;
  connect(device: Device): Promise<EngineInfo>;
  capture(): Promise<string>;
  captureLanePreview(
    laneId: string,
  ): Promise<import("./lane-preview").LanePreviewFrame>;
  start(plan: Plan, requestId?: string): Promise<{ runId: string }>;
  stop(): Promise<void>;
  onEvent(listener: (event: RunEvent) => void): () => void;
}

export const MAX_DEVICE_LANES = 64;

export interface DeviceLane {
  id: string;
  name: string;
  managerPath: string;
  instance: number;
  enabled: boolean;
  /** Read-only provenance. Original requests and task receipts keep their own IDs. */
  legacyBinding?: { laneId: string; instance: number; scope: string };
  arknights: { enabled: boolean; profileId: string; routine?: Routine };
  /** New copied channels must bind their own identity before enabling. */
  identityRequired?: boolean;
  onmyoji: {
    enabled: boolean;
    routine?: Routine;
    identity?: import("./onmyoji-identity").OnmyojiIdentityBinding;
  };
  /**
   * 按游戏覆盖 MuMu 实例号（渠道化：同一账号的方舟与阴阳师可能装在不同实例上）。
   * 缺省时退回 instance；资源锁/准入仍以 lane 为单位，这里只影响设备寻址。
   */
  deviceInstances?: { arknights?: number; onmyoji?: number };
  closeEmulatorAfterSuccess: boolean;
}

export interface DeviceLanes {
  version: 1 | 2;
  lanes: DeviceLane[];
}

/** Identifies the visible plan without changing automatic once-per-day scheduling. */
export function deviceLanePlanKey(lane: DeviceLane): string {
  const key: unknown[] = [
    lane.managerPath.toLowerCase().replaceAll("\\", "/"),
    lane.instance,
    lane.arknights.enabled,
    lane.arknights.profileId,
    lane.arknights.routine ?? null,
    lane.onmyoji.enabled,
    lane.onmyoji.routine ?? null,
  ];
  if (lane.onmyoji.identity)
    key.push([lane.onmyoji.identity.roleId, lane.onmyoji.identity.serverName]);
  return JSON.stringify(key);
}

type LegacyLaneSettings = Pick<
  AutomationSettings,
  "managerPath" | "instance" | "closeEmulatorAfterSuccess"
>;

export function defaultDeviceLanes(legacy: LegacyLaneSettings): DeviceLanes {
  return {
    version: 1,
    lanes: [
      {
        id: "lane-a",
        name: `MuMu ${legacy.instance}`,
        managerPath: legacy.managerPath,
        instance: legacy.instance,
        enabled: true,
        arknights: { enabled: true, profileId: "default" },
        onmyoji: { enabled: true },
        closeEmulatorAfterSuccess: legacy.closeEmulatorAfterSuccess,
      },
    ],
  };
}

export function validateDeviceLanes(input: unknown): DeviceLanes {
  const value = record(input, ["version", "lanes"]);
  if (
    (value.version !== 1 && value.version !== 2) ||
    !Array.isArray(value.lanes) ||
    value.lanes.length < 1 ||
    value.lanes.length > MAX_DEVICE_LANES
  )
    throw new Error("设备槽位配置无效");
  const lanes = value.lanes.map((inputLane) => {
    if (
      !inputLane ||
      typeof inputLane !== "object" ||
      Array.isArray(inputLane) ||
      Object.keys(inputLane).some(
        (key) =>
          ![
            "id",
            "name",
            "managerPath",
            "instance",
            "deviceInstances",
            "legacyBinding",
            "identityRequired",
            "enabled",
            "arknights",
            "onmyoji",
            "closeEmulatorAfterSuccess",
          ].includes(key),
      )
    )
      throw new Error("不支持的设备槽位字段");
    const lane = record(inputLane, [
      "id",
      "name",
      "managerPath",
      "instance",
      "deviceInstances",
      "legacyBinding",
      "identityRequired",
      "enabled",
      "arknights",
      "onmyoji",
      "closeEmulatorAfterSuccess",
    ]);
    if (
      typeof lane.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(lane.id)
    )
      throw new Error("设备槽位编号无效");
    if (
      typeof lane.name !== "string" ||
      !lane.name.trim() ||
      lane.name.trim().length > 40 ||
      /[\x00-\x1f]/.test(lane.name)
    )
      throw new Error("设备槽位名称无效");
    if (
      typeof lane.managerPath !== "string" ||
      lane.managerPath.length > 2048 ||
      /[\x00-\x1f]/.test(lane.managerPath) ||
      (lane.managerPath &&
        !/^[A-Za-z]:[\\/].*[\\/]MuMuManager\.exe$/i.test(lane.managerPath))
    )
      throw new Error("设备槽位 MuMu 路径无效");
    if (
      !Number.isInteger(lane.instance) ||
      Number(lane.instance) < 0 ||
      Number(lane.instance) > 999
    )
      throw new Error("设备槽位实例编号无效");
    if (
      lane.identityRequired !== undefined &&
      typeof lane.identityRequired !== "boolean"
    )
      throw Error("渠道身份绑定选项无效");
    const deviceInstances =
      lane.deviceInstances === undefined
        ? undefined
        : record(lane.deviceInstances, ["arknights", "onmyoji"]);
    const legacyBinding =
      lane.legacyBinding === undefined
        ? undefined
        : record(lane.legacyBinding, ["laneId", "instance", "scope"]);
    if (
      legacyBinding &&
      (typeof legacyBinding.laneId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(legacyBinding.laneId) ||
        !Number.isInteger(legacyBinding.instance) ||
        Number(legacyBinding.instance) < 0 ||
        Number(legacyBinding.instance) > 999 ||
        typeof legacyBinding.scope !== "string" ||
        legacyBinding.scope.length > 4096 ||
        /[\x00-\x1f]/.test(legacyBinding.scope))
    )
      throw new Error("渠道来源绑定无效");
    for (const gameInstance of Object.values(deviceInstances ?? {})) {
      if (gameInstance === undefined) continue;
      if (
        !Number.isInteger(gameInstance) ||
        Number(gameInstance) < 0 ||
        Number(gameInstance) > 999
      )
        throw new Error("设备渠道实例号无效");
    }
    const arknights = record(lane.arknights, [
      "enabled",
      "profileId",
      "routine",
    ]);
    const onmyoji = record(lane.onmyoji, ["enabled", "routine", "identity"]);
    if (
      typeof arknights.enabled !== "boolean" ||
      typeof arknights.profileId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(arknights.profileId) ||
      typeof onmyoji.enabled !== "boolean" ||
      typeof lane.enabled !== "boolean" ||
      typeof lane.closeEmulatorAfterSuccess !== "boolean"
    )
      throw new Error("设备槽位开关或账号档案无效");
    if (lane.enabled && !arknights.enabled && !onmyoji.enabled)
      throw new Error("启用的设备槽位至少启用一个游戏");
    if (
      value.version === 2 &&
      (Number(arknights.enabled) + Number(onmyoji.enabled) !== 1 ||
        lane.deviceInstances !== undefined)
    )
      throw new Error("账号渠道必须只绑定一个游戏和一个设备实例");
    return {
      id: lane.id,
      name: lane.name.trim(),
      managerPath: lane.managerPath,
      instance: lane.instance as number,
      enabled: lane.enabled,
      ...(legacyBinding === undefined
        ? {}
        : {
            legacyBinding: {
              laneId: legacyBinding.laneId as string,
              instance: legacyBinding.instance as number,
              scope: legacyBinding.scope as string,
            },
          }),
      ...(lane.identityRequired === undefined
        ? {}
        : { identityRequired: lane.identityRequired as boolean }),
      arknights: {
        enabled: arknights.enabled,
        profileId: arknights.profileId,
        ...(arknights.routine === undefined
          ? {}
          : { routine: validateRoutine(arknights.routine) }),
      },
      onmyoji: {
        enabled: onmyoji.enabled,
        ...(onmyoji.identity === undefined
          ? {}
          : { identity: validateOnmyojiIdentityBinding(onmyoji.identity) }),
        ...(onmyoji.routine === undefined
          ? {}
          : { routine: validateRoutine(onmyoji.routine) }),
      },
      ...(deviceInstances === undefined
        ? {}
        : {
            deviceInstances: {
              ...(deviceInstances.arknights === undefined
                ? {}
                : { arknights: Number(deviceInstances.arknights) }),
              ...(deviceInstances.onmyoji === undefined
                ? {}
                : { onmyoji: Number(deviceInstances.onmyoji) }),
            },
          }),
      closeEmulatorAfterSuccess: lane.closeEmulatorAfterSuccess,
    } satisfies DeviceLane;
  });
  if (new Set(lanes.map((lane) => lane.id)).size !== lanes.length)
    throw new Error("设备槽位编号不能重复");
  if (
    value.version === 1 &&
    new Set(lanes.map((lane) => lane.instance)).size !== lanes.length
  )
    throw new Error("MuMu 实例不能重复");
  if (
    value.version === 2 &&
    new Set(
      lanes.map((lane) =>
        JSON.stringify([
          canonicalChannelDeviceKey(lane.managerPath, lane.instance),
          lane.arknights.enabled ? "arknights" : "onmyoji",
        ]),
      ),
    ).size !== lanes.length
  )
    throw new Error("同游戏渠道的 MuMu 实例不能重复");
  return { version: value.version, lanes };
}
export interface AutomationSettings {
  scheduleEnabled: boolean;
  scheduleTime: string;
  secondScheduleEnabled: boolean;
  secondScheduleTime: string;
  fosterScheduleEnabled: boolean;
  closeToTray: boolean;
  notifyResults: boolean;
  closeEmulatorAfterSuccess: boolean;
  managerPath: string;
  instance: number;
  launchEmulator: boolean;
  runOnLaunch: boolean;
  openAtLogin: boolean;
  /** 每次运行前跟随 maa-cli 解析出的当前活动关卡（活动换期自动适配）。 */
  followActivityStage: boolean;
}
export interface MuMuInstallation {
  managerPath: string;
  adbPath: string;
}
export interface MuMuInstance {
  instance: number;
  name: string;
  running: boolean;
  ready: boolean;
  address: string;
  arknights: "Official" | "Bilibili" | null;
  onmyoji: boolean;
  /** 当前 app 已具备自动化能力的游戏（方舟已就绪；阴阳师底层技能开发中）。 */
  supportedGames?: Array<"arknights" | "onmyoji">;
  /** 该渠道此刻是否可直接开跑自动化：running 且有 supportedGames。 */
  automationReady?: boolean;
}
export function validateAutomation(input: unknown): AutomationSettings {
  const value = record(input, [
    "scheduleEnabled",
    "scheduleTime",
    "secondScheduleEnabled",
    "secondScheduleTime",
    "fosterScheduleEnabled",
    "closeToTray",
    "notifyResults",
    "closeEmulatorAfterSuccess",
    "managerPath",
    "instance",
    "launchEmulator",
    "runOnLaunch",
    "openAtLogin",
    "followActivityStage",
  ]);
  const result = {
    scheduleEnabled: false,
    scheduleTime: "08:00",
    secondScheduleEnabled: false,
    secondScheduleTime: "20:00",
    fosterScheduleEnabled: false,
    closeToTray: false,
    notifyResults: false,
    closeEmulatorAfterSuccess: false,
    managerPath: "",
    instance: 0,
    launchEmulator: false,
    runOnLaunch: false,
    openAtLogin: false,
    followActivityStage: false,
    ...value,
  };
  if (
    typeof result.managerPath !== "string" ||
    result.managerPath.length > 2048 ||
    /[\x00-\x1f]/.test(result.managerPath) ||
    (result.managerPath &&
      !/^[A-Za-z]:[\\/].*[\\/]MuMuManager\.exe$/i.test(result.managerPath))
  )
    throw new Error("请指定完整 MuMuManager.exe 路径");
  if (
    !Number.isInteger(result.instance) ||
    Number(result.instance) < 0 ||
    Number(result.instance) > 999
  )
    throw new Error("实例编号必须是 0 至 999 的整数");
  for (const time of [result.scheduleTime, result.secondScheduleTime])
    if (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
      throw new Error("定时时间必须为 HH:mm");
  if (
    result.secondScheduleEnabled &&
    String(result.secondScheduleTime) <= String(result.scheduleTime)
  )
    throw new Error("第二轮时间必须晚于第一轮");
  for (const key of [
    "launchEmulator",
    "runOnLaunch",
    "openAtLogin",
    "followActivityStage",
    "scheduleEnabled",
    "secondScheduleEnabled",
    "fosterScheduleEnabled",
    "closeToTray",
    "notifyResults",
    "closeEmulatorAfterSuccess",
  ] as const)
    if (typeof result[key] !== "boolean") throw new Error("自动化开关无效");
  return result as AutomationSettings;
}
declare global {
  interface Window {
    gamepilot?: DesktopAPI;
  }
}

function record(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("参数必须是对象");
  if (Object.keys(input).some((key) => !keys.includes(key)))
    throw new Error("包含不支持的字段");
  return input as Record<string, unknown>;
}
export function validatePlan(input: unknown, games: Game[]): Plan {
  const value = record(input, ["gameId", "skillIds", "mode"]);
  const game = games.find((g) => g.id === value.gameId);
  if (!game) throw new Error("未知游戏");
  if (value.mode !== "live" && value.mode !== "rehearsal")
    throw new Error("执行模式无效");
  if (
    !Array.isArray(value.skillIds) ||
    !value.skillIds.length ||
    value.skillIds.length > 32
  )
    throw new Error("请选择 1 至 32 项技能");
  const ids = value.skillIds;
  if (new Set(ids).size !== ids.length) throw new Error("技能不能重复");
  for (const id of ids) {
    const skill = game.skills.find((s) => s.id === id);
    if (!skill) throw new Error("未知技能");
    if (value.mode === "live" && !skill.ready)
      throw new Error(`${skill.title} 尚未完成实机适配`);
  }
  return { gameId: game.id, skillIds: [...ids], mode: value.mode };
}
export function validateSettings(input: unknown): Settings {
  const keys = ["adbPath", "address", "modelEndpoint", "modelName"];
  const value = record(input, keys);
  for (const key of keys)
    if (
      typeof value[key] !== "string" ||
      (value[key] as string).length > 2048 ||
      /[\x00-\x1f]/.test(value[key] as string)
    )
      throw new Error(`设置字段 ${key} 无效`);
  const settings = Object.fromEntries(
    keys.map((k) => [k, (value[k] as string).trim()]),
  ) as unknown as Settings;
  if (settings.modelEndpoint) {
    const url = new URL(settings.modelEndpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("模型地址必须是 HTTP(S) 地址且不能包含凭据");
  }
  return settings;
}
export function validateDevice(input: unknown): Device {
  const value = record(input, ["name", "adbPath", "address"]);
  for (const key of ["name", "adbPath", "address"])
    if (
      typeof value[key] !== "string" ||
      !(value[key] as string).trim() ||
      (value[key] as string).length > 2048 ||
      /[\x00-\x1f]/.test(value[key] as string)
    )
      throw new Error("设备名称、ADB 路径和地址不能为空或包含控制字符");
  return {
    name: (value.name as string).trim(),
    adbPath: (value.adbPath as string).trim(),
    address: (value.address as string).trim(),
  };
}
