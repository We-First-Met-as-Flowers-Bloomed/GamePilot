import {
  OnmyojiAutomationService,
  OnmyojiAutomationStore,
  freezeOnmyojiJob,
} from "./onmyoji-automation";
import {
  defaultOnmyojiAutomation,
  validateOnmyojiAutomation,
  type OnmyojiJob,
} from "../../../packages/protocol/onmyoji-automation";
import { createAutomationRun } from "./game-automation-host";
import { createGameAutomationControl } from "./game-automation-control";
import { registerGameAutomationIpc } from "./ipc/game-automation";
import {
  dailyLaneScope,
  maintenanceLanes,
  validateLaneProfiles,
} from "./daily-policy";
import {
  createChannelDailyScheduleStore,
  createChannelFosterScheduleStore,
} from "./channel-schedule-store";
import { arknightsDailySkills } from "../../../games/arknights/daily-plan";
import { resolveArknightsTaskOptions } from "../../../games/arknights/task-options";
import { launchIndependentLanes } from "./lane-batch";
import { validateArknightsCapabilities } from "../../../games/arknights/capabilities";
import { arknightsGameDay } from "../../../games/arknights/result-policy";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  powerMonitor,
  safeStorage,
} from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { registerArknightsAutomationIpc } from "./ipc/arknights-automation";
import { dailySkills, games } from "../../../games/registry";
import { ArknightsStore } from "./arknights-settings";
import { CopilotService } from "./copilot-service";
import { withCopilotReadTools } from "../../../packages/agent/copilot-tools";
import {
  copilotBinding,
  copilotConfigurationRevision,
  freezeCopilotExecution,
} from "./copilot-admission";
import { resolveCopilotStage } from "../../../games/arknights/copilot-stage";
import engineContract from "../../../games/arknights/engine-contract.json";
import {
  validateCopilotConfirmation,
  validateCopilotPreparation,
} from "../../../packages/protocol/copilot";
import { copilotReviewFromPlan } from "../../../packages/protocol/copilot-review";
import {
  activeArknightsConfig,
  validateArknightsProfiles,
} from "../../../games/arknights/config";
import {
  validateDevice,
  validateDeviceLanes,
  validatePlan,
  type EngineInfo,
  type RunEvent,
  type Device,
} from "../../../packages/protocol";
import { SettingsStore } from "./settings";
import { HistoryStore } from "./history";
import { RunLedger } from "./run-ledger";
import { FailureEvidenceService } from "./failure-evidence-service";
import { IncidentAgentService } from "./incident-agent";
import { IncidentContext } from "./incident-context";
import {
  diagnoseIncident,
  diagnoseIncidentWithCodex,
} from "../../../packages/agent/incident-diagnosis";
import { findCodexExecutable } from "../../../packages/agent/codex/discovery";
import { boundedRead } from "../../../packages/agent/read-file";
import { replaceFile } from "./replace-file";
import { AgentToolError, agentObject } from "../../../packages/protocol/agent";
import { ExecutionDetailService } from "./execution-detail";
import { ExecutionProgressService } from "./execution-progress";
import { ContinuationService } from "./continuation-service";
import { startupFaultFrom } from "../../../packages/protocol/startup-fault";
import { RecoveryService, recoveryDevice } from "./recovery-service";
import type { DeviceInspection } from "../../../packages/protocol/recovery";
import {
  ExecutionCoordinator,
  type ExecutionLease,
  mumuResource,
} from "./execution-coordinator";
import { validateRequestId } from "../../../packages/protocol/execution";
import {
  freezeLaneExecution,
  freezeLaneExecutionForGame,
  scheduledGames,
  type LaneExecutionSnapshot,
} from "./lane-snapshot";
import { freezeLaneDevice } from "./lane-device";
import { WorkerClient } from "./worker-client";
import { assertMaintenanceClear } from "./maintenance-guard";
import { registerSettingsIpc } from "./ipc/settings";
import { AutomationStore } from "./automation";
import { currentMuMuDevice, detectMuMu } from "./mumu";
import {
  DevicePreparationService,
  type PreparedMuMuDevice,
} from "./device-preparation";
import { initializeProfile } from "./profile";
import { validateAutomation, type Plan } from "../../../packages/protocol";
import { createHash, randomUUID } from "node:crypto";
import {
  DailyScheduler,
  IntervalScheduler,
  IntervalScheduleStore,
  ScheduleStore,
} from "./scheduler";
import { DesktopPresence } from "./presence";
import { closeOwnedMuMu, type OwnedMuMu } from "./mumu";
import { gameDay } from "../../../games/onmyoji/policy";
import type {
  AutomationSettings,
  DeviceLane,
} from "../../../packages/protocol";
import { DeviceLaneStore } from "./device-lanes";
import { LaneRuntimeManager, type LaneWorker } from "./lane-runtime";
import { LanePreviewService } from "./lane-preview";
import { resolveMuMuPreviewTarget } from "./lane-preview-target";
import { executeLanePlan, runWorkerPlan } from "./lane-plan";
import { resolveRunStage } from "./activity-stage-sync";
import { InternalActivityStageResolver } from "./internal-activity-stage";
import {
  ArknightsAutomationService,
  ArknightsAutomationStore,
} from "./arknights-automation";
import {
  defaultArknightsAutomation,
  type ArknightsJob,
} from "../../../packages/protocol/arknights-automation";
import { freezeArknightsJob } from "./arknights-job-snapshot";
import { createArknightsAutomationRun } from "./arknights-automation-host";
import { SkillResultQueue, findFosterLane } from "./skill-results";
import { discoverMuMuInstances } from "./mumu";
import { runBudget, runFailure } from "../../../packages/runtime/run-budget";
import { RunObservationStore } from "./run-observations";
import { version as appVersion } from "../../../package.json";
import { deviceLanePlanKey } from "../../../packages/protocol";
import { PlannerService } from "./agent-planner";
import { ChatService } from "./agent-chat";
import { chatArchiveFiles } from "./chat-archive-files";
import { ChatCommandService } from "./chat-commands";
import { ChatIntentReviewService } from "./chat-intent-review";
import { createLocalControlServer } from "./local-control";
import { AgentEventJournal } from "./agent-events";
import { agentEventFiles } from "./agent-event-files";
import {
  modelEventReceipt,
  plannerStateReceipt,
} from "./agent-event-presentation";
import { readConfiguredSnapshot } from "../../../packages/agent/configured";
import { runPlannerUiSmoke, plannerUiFixture } from "./planner-ui-smoke";
import { desktopLaunchMode } from "./launch-mode";
import { failureEvidenceUiSmoke } from "./failure-evidence-ui-smoke";
import { ModelProviderStore } from "./model-provider";
import { testCompatibleConnection } from "../../../packages/agent/openai-compatible/adapter";
import { plannerActive } from "../../../packages/protocol/agent-planner";
import { canonical } from "../../../packages/acceptance/files";
import { AgentExecutionService } from "./agent-execution";
import {
  guardSavedDailyHistory,
  prepareAgentExecution,
} from "./agent-execution-policy";
import { launchAgentBatch } from "./agent-execution-batch";
import { assertDailyHistoryClear } from "./daily-history-guard";
import {
  scheduledStartupRetry,
  unsubmittedStartupFailure,
} from "./scheduled-startup-retry";
import { releaseMaintenancePauses } from "./maintenance-resume";
import { gameAgentCatalog } from "../../../games/agent";
import {
  frozenAdmissionPolicy,
  type FrozenIdentity,
} from "./frozen-admission-policy";
import { compiledCapabilityEffects } from "../../../games/agent-skills";
import { withTrackedAdmission } from "./tracked-admission";
import { GoalService, type PreparedGoal } from "./agent-goals";
import { agentGoalFiles } from "./agent-goal-files";
import { createGoalRuntime, frozenGoalScopes } from "./agent-goal-runtime";
import { createGoalObserver } from "./agent-goal-observer";
import { createAgentTools } from "../../../packages/agent/tools";
import { planWithDsh } from "../../../packages/agent/dsh-planner";
import { createDshTurnContext } from "./dsh-turn-context";
import { goalResultReport } from "../../../games/goal-report";
import {
  prepareCompiledAgentExecution,
  pureArknightsLogin,
  type StartupInspectionPermit,
} from "./agent-execution-policy";
import { verifyNativeExecutorExit } from "./native-executor-exit";
import { StartupReconciliationStore } from "./startup-reconciliation-store";
import {
  recordStartupReconciliations,
  verifiedStartupFacts,
} from "./startup-reconciliation";
import type {
  GoalRun,
  GoalRecoveryReference,
} from "../../../packages/protocol/agent-goal";
import { AgentGoalPreferencesService } from "./agent-goal-preferences";
import { createGoalInspection } from "./agent-goal-inspection";
import { goalContinuationScopes } from "../../../games/goal-continuation";
import { createGoalStartupRecovery } from "./agent-startup-recovery";
import { assertAgentExecutionAccounts } from "../../../games/agent-message-scope";
import { goalOutcomeCriteriaForPrompt } from "../../../games/goal-outcome";
import { createDailyContinuationPreparation } from "./agent-daily-continuation";

const { plannerUiTest, plannerPreview, smoke } = desktopLaunchMode(
  process.argv,
);
if (smoke)
  app.setPath(
    "userData",
    join(
      app.getAppPath(),
      "artifacts",
      plannerPreview ? "planner-preview-profile" : "smoke-profile",
    ),
  );
app.setName("GamePilot");
app.setAppUserModelId("GamePilot");
initializeProfile(app);
const modelProvider = new ModelProviderStore(
  join(app.getPath("userData"), "model-provider.json"),
  safeStorage,
);
let modelOperation: AbortController | undefined;
let goals: GoalService | undefined;
let goalRuntime: ReturnType<typeof createGoalRuntime> | undefined;
let copilotToolBinding:
  | ((
      binding: import("../../../packages/protocol/agent-runtime").AgentRuntimeToolBinding,
      principal: import("../../../packages/protocol/agent-runtime").AgentRuntimePrincipal,
      requestId: string,
      snapshot: import("../../../packages/protocol/agent").AgentSnapshot,
    ) => import("../../../packages/protocol/agent-runtime").AgentRuntimeToolBinding)
  | undefined;
let goalTimer: ReturnType<typeof setInterval> | undefined;
const goalNotifications = new Set<AbortController>();
const goalNotificationJobs = new Set<Promise<void>>();
let agentExecution: AgentExecutionService | undefined;
let window: BrowserWindow | undefined;
const plannerModelTest =
  plannerUiTest && process.argv.includes("--planner-model-test");
const plannerConfiguredTest =
  plannerUiTest && process.argv.includes("--planner-configured-test");
const plannerRecordedTest =
  plannerUiTest && process.argv.includes("--planner-recorded-test");
const planner =
  plannerUiTest && !plannerModelTest
    ? plannerUiFixture()
    : new PlannerService({
        runtimeRun: async ({ snapshot, principal, requestId, ...options }) => {
          const baseBinding =
            principal &&
            snapshot.source !== "disk" &&
            goalRuntime?.bind(principal, requestId, snapshot.source);
          const binding =
            baseBinding && principal && copilotToolBinding
              ? copilotToolBinding(baseBinding, principal, requestId, snapshot)
              : baseBinding;
          return planWithDsh(createAgentTools(snapshot), {
            ...options,
            binding: binding || undefined,
            ...createDshTurnContext({
              prompt: options.prompt,
              principal,
              requestId,
              goals: principal
                ? goals?.snapshot(principal.sessionId).goals
                : undefined,
            }),
            runtime: {
              directory: app.isPackaged
                ? join(process.resourcesPath, "gamepilot-dsh-runtime")
                : join(
                    app.getAppPath(),
                    "integrations/deepseek-harness/runtime",
                  ),
              home: join(app.getPath("userData"), "dsh-runtime"),
            },
          });
        },
        modelConnection: modelProvider,
        readConfigured: (history) =>
          readConfiguredSnapshot(
            plannerPreview
              ? join(app.getPath("home"), ".gamepilot")
              : app.getPath("userData"),
            { history },
          ),
      });
let worker: WorkerClient;
let laneRuntime: LaneRuntimeManager | undefined;
let lanePreview: LanePreviewService | undefined;
let history: HistoryStore;
let runLedger: RunLedger;
let executions: ExecutionCoordinator;
let quitting = false;
let closeToTray = false;
let presence: DesktopPresence | undefined;
let scheduleTimer: ReturnType<typeof setInterval> | undefined;
let arknightsAutomation: ArknightsAutomationService | undefined;
let onmyojiAutomation: OnmyojiAutomationService | undefined;
let incidentAgent: IncidentAgentService | undefined;
let chat: ChatService | undefined;
let agentJournal: AgentEventJournal | undefined;
let chatCommands: ChatCommandService | undefined;
let localControl:
  Awaited<ReturnType<typeof createLocalControlServer>> | undefined;
const executionChatOwners = new Map<string, string>();
const commandChatOwners = new Map<string, string>();
let incidentTimer: ReturnType<typeof setInterval> | undefined;
let cancelPreparation: () => void = () => {};
let lastEngine: EngineInfo | null = null;
let engineError: string | undefined;
const rendererFile = join(__dirname, "../renderer/index.html");
const rendererUrl = pathToFileURL(rendererFile).href;

async function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 660,
    title: "GamePilot",
    backgroundColor: "#faf9f6",
    autoHideMenuBar: true,
    show: !process.argv.includes("--hidden") && (!smoke || plannerPreview),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: !smoke,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.on("close", (event) => {
    if (!quitting && closeToTray && presence && !smoke) {
      event.preventDefault();
      window?.hide();
    }
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  await window.loadFile(rendererFile);
}

const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
}

if (ownsInstance)
  app
    .whenReady()
    .then(async () => {
      const dataDir = app.getPath("userData");
      agentJournal = new AgentEventJournal(
        agentEventFiles(join(dataDir, "agent-events")),
      );
      const sendObservation = (channel: string, value: unknown) => {
        if (window && !window.isDestroyed())
          window.webContents.send(channel, value);
      };
      agentJournal.subscribe((event) =>
        sendObservation("gp:agent-event", event),
      );
      const recordAgent = async (
        event: import("../../../packages/protocol/agent-events").AgentEventInput,
      ) => {
        let parentRequestId: string | undefined;
        try {
          parentRequestId = (
            executions?.get(event.requestId).snapshot.agent as
              { requestId?: string } | undefined
          )?.requestId;
        } catch {
          /* Model requests do not have a game admission. */
        }
        const target = chat?.requestTarget(parentRequestId ?? event.requestId);
        const goal = !target
          ? goals
              ?.snapshot()
              .goals.find((g) => g.id === (parentRequestId ?? event.requestId))
          : undefined;
        const command =
          !target && !goal
            ? (await chatCommands?.snapshot())?.find(
                (view) =>
                  view.reviewId === (parentRequestId ?? event.requestId),
              )
            : undefined;
        try {
          return await agentJournal!.append({
            ...event,
            ...(parentRequestId ? { parentRequestId } : {}),
            ...target,
            ...(goal ? { sessionId: goal.sessionId, turnId: goal.turnId } : {}),
            ...(command
              ? {
                  sessionId: command.sessionId,
                  ...(command.sessionContext?.split(":").at(-1) !== "empty"
                    ? { turnId: command.sessionContext?.split(":").at(-1) }
                    : {}),
                }
              : {}),
          });
        } catch (error) {
          sendObservation(
            "gp:agent-error",
            "Agent过程记录保存失败，新Agent执行已暂停；请核对原任务账本。",
          );
          throw error;
        }
      };
      let lastPlannerStatus = "";
      planner.subscribe((state) => {
        sendObservation("gp:planner-state", state);
        const key = `${state.requestId}:${state.status}`;
        const receipt = plannerStateReceipt(state);
        if (receipt && key !== lastPlannerStatus) {
          lastPlannerStatus = key;
          void recordAgent(receipt).catch(() =>
            sendObservation("gp:agent-error", "Agent事件保存失败"),
          );
        }
      });
      if (
        "subscribeStream" in planner &&
        typeof planner.subscribeStream === "function"
      )
        planner.subscribeStream(
          (
            id: string,
            event: import("../../../packages/protocol/agent-planner").PlannerStreamEvent,
          ) => {
            sendObservation("gp:planner-stream", { requestId: id, event });
            const receipt = modelEventReceipt(id, event);
            if (receipt)
              void recordAgent(receipt).catch(() =>
                sendObservation("gp:agent-error", "Agent事件保存失败"),
              );
          },
        );
      const observations = new RunObservationStore(
        join(dataDir, "run-observations"),
      );
      history = new HistoryStore(join(dataDir, "history.json"));
      runLedger = new RunLedger(join(dataDir, "task-runs"));
      await runLedger.load();
      executions = new ExecutionCoordinator(
        join(dataDir, "execution-requests"),
      );
      await executions.load();
      const startupFacts = new StartupReconciliationStore(
        join(dataDir, "startup-reconciliation"),
      );
      await startupFacts
        .load()
        .catch((error) => console.error("启动对账事实读取失败", error));
      const readStartupFacts = () =>
        verifiedStartupFacts(
          startupFacts,
          executions.snapshot(Number.MAX_SAFE_INTEGER),
          runLedger.snapshot(Number.MAX_SAFE_INTEGER),
        );
      await history.load();
      lanePreview = new LanePreviewService({
        readLanes: () => deviceLanes.read(),
        resolveIdleTarget: async (lane) => {
          if (quitting || laneRuntime?.isRunning(lane.id)) return undefined;
          return resolveMuMuPreviewTarget(lane).catch(() => undefined);
        },
      });
      await observations.recoverInterrupted(history.snapshot());
      let starting = false;
      let connecting = false;
      let finishing = false;
      let automaticReserved = false;
      let startupInspectionRunning = false;
      let configuring = false;
      let configuringGamePlans = false;
      let connectedDevice: Device | undefined;
      const laneDailySchedulers = new Map<string, DailyScheduler>();
      const laneFosterSchedulers = new Map<string, IntervalScheduler>();
      const legacyFosterScheduler = new IntervalScheduler(
        new IntervalScheduleStore(join(dataDir, "foster-scheduler.json")),
        6 * 60 * 60_000,
        30 * 60_000,
        async () => "cancelled",
      );
      const getLaneFosterScheduler = (lane: DeviceLane) => {
        let scheduler = laneFosterSchedulers.get(lane.id);
        if (!scheduler) {
          scheduler = new IntervalScheduler(
            createChannelFosterScheduleStore(dataDir, lane),
            6 * 60 * 60_000,
            30 * 60_000,
            async () => {
              const current = (await deviceLanes.read()).lanes.find(
                (item) => item.id === lane.id,
              );
              if (!current || !maintenanceLanes([current]).length)
                return "cancelled";
              const { job } = await launchLane(
                current,
                randomUUID(),
                true,
                automaticCycle?.signal,
              );
              await job;
              return "succeeded";
            },
          );
          laneFosterSchedulers.set(lane.id, scheduler);
        }
        return scheduler;
      };
      /**
       * 重新检查维护暂停；原未知请求须处置或被新的现场证据覆盖才解除。
       *
       * 这是唯一不依赖“新的寄养观测”的出口：日常流程已不含 foster
       * （`compileDailyPlan` 会过滤 maintenanceOnly 技能），`calibrate()` 可能
       * 永远等不到观测，闸门一旦落下就是永久死锁。调用方必须先确认现场。
       */
      const releaseMaintenancePause = async () => {
        return releaseMaintenancePauses({
          lanes: (await deviceLanes.read()).lanes,
          requests: executions.snapshot(Number.MAX_SAFE_INTEGER),
          tasks: runLedger.snapshot(Number.MAX_SAFE_INTEGER),
          getScheduler: getLaneFosterScheduler,
        });
      };
      type Context = {
        executionId: string;
        lease: ExecutionLease;
        plan: Plan;
        config: AutomationSettings;
        owned?: OwnedMuMu;
        done: Promise<string>;
        resolve: (status: string) => void;
        scope: string;
        results: SkillResultQueue;
      };
      let context: Context | undefined;
      const settings = new SettingsStore(join(dataDir, "settings.json"));
      const arknights = new ArknightsStore(join(dataDir, "arknights.json"));
      const automation = new AutomationStore(join(dataDir, "automation.json"));
      const devicePreparation = new DevicePreparationService();
      const activityStageResolver = new InternalActivityStageResolver(
        join(dataDir, "activity-stage-cache.json"),
      );
      process.env.GAMEPILOT_MAA_ACTIVITY_ROOT = join(dataDir, "maa-activity");
      const deviceLanes = new DeviceLaneStore(
        join(dataDir, "device-lanes.json"),
        async () => {
          const legacy = await automation.read();
          return {
            managerPath: legacy.managerPath,
            instance: legacy.instance,
            closeEmulatorAfterSuccess: legacy.closeEmulatorAfterSuccess,
          };
        },
      );
      let preparing: AbortController | undefined;
      cancelPreparation = () => preparing?.abort();
      const publish = async (event: RunEvent) => {
        event = {
          ...event,
          executionId:
            event.executionId ??
            (event.laneId ? undefined : context?.executionId),
          gameId: event.gameId ?? context?.plan.gameId ?? "onmyoji",
        };
        try {
          await runLedger.append(event);
        } catch (error) {
          const failed: RunEvent = {
            ...event,
            type: "status",
            status: "failed",
            resultUncertain: true,
            plan: undefined,
            stepStatus: undefined,
            message: "任务记录保存失败，结果未确认：" + String(error),
          };
          // A broken ledger must not leave the UI showing an endless running task.
          await history.append(failed);
          if (window && !window.isDestroyed())
            window.webContents.send("gp:event", failed);
          throw error;
        }
        await history.append(event);
        if (event.stepControl)
          await recordAgent({
            requestId: event.executionId || event.runId,
            runId: event.runId,
            kind: "correction",
            status:
              event.stepControl.status === "applied" ? "succeeded" : "running",
            text:
              event.stepControl.status === "applied"
                ? "当前步骤已完成，后续步骤已暂停；原进度保留"
                : "步骤边界暂停已排队，当前步骤继续",
          });
        if (
          (event.type === "step" && event.stepStatus) ||
          (event.type === "status" &&
            event.status &&
            !["queued", "running", "stopping"].includes(event.status))
        ) {
          await recordAgent({
            requestId: event.executionId || event.runId,
            runId: event.runId,
            ...(event.laneId ? { laneId: event.laneId } : {}),
            ...(event.gameId ? { gameId: event.gameId } : {}),
            ...(event.skillId ? { stepId: event.skillId } : {}),
            kind: event.type === "step" ? "game-step" : "game-result",
            status: event.resultUncertain
              ? "unknown"
              : event.type === "step"
                ? event.stepStatus === "skipped"
                  ? "succeeded"
                  : event.stepStatus!
                : (event.status as "succeeded" | "failed" | "cancelled"),
            text: event.message.slice(0, 4000),
          });
        }
        if (window && !window.isDestroyed())
          window.webContents.send("gp:event", event);
        presence?.update(
          starting || finishing || history.active,
          event.message,
        );
      };
      const scopeOf = async (c: AutomationSettings) => {
        if (c.launchEmulator)
          return c.managerPath.toLowerCase() + "#" + c.instance;
        const target = connectedDevice ?? (await settings.read());
        return "adb:" + target.adbPath.toLowerCase() + "@" + target.address;
      };
      const finish = async (current: Context, event: RunEvent) => {
        if (!(await current.results.owns(event.runId))) return;
        finishing = true;
        let finalStatus = "failed";
        try {
          try {
            await current.results.flush();
            await runLedger.flush();
          } catch (error) {
            event = {
              ...event,
              status: "failed",
              message: "任务结果保存失败：" + String(error),
            };
          }
          if (current.plan.mode === "live") {
            if (event.status === "succeeded") {
              if (current.config.closeEmulatorAfterSuccess && current.owned) {
                try {
                  const closed = await closeOwnedMuMu(current.owned);
                  if (closed) {
                    lastEngine = await worker.request<EngineInfo>("disconnect");
                    connectedDevice = undefined;
                    engineError = undefined;
                  }
                  await publish({
                    runId: event.runId,
                    type: "log",
                    message: closed
                      ? "已关闭本次启动的 MuMu"
                      : "保留已有或已更换的 MuMu 实例",
                    at: new Date().toISOString(),
                  });
                } catch (error) {
                  await publish({
                    runId: event.runId,
                    type: "log",
                    message: "任务已完成，关闭模拟器未完成：" + String(error),
                    at: new Date().toISOString(),
                  });
                }
              }
            }
            if (current.config.notifyResults) {
              try {
                presence?.notify(
                  event.status === "succeeded"
                    ? "任务已完成，结果已验证。"
                    : event.message,
                  event.status === "failed",
                );
              } catch {
                /* System notification settings do not change game results. */
              }
            }
          }
          try {
            await current.lease.finish(
              event.resultUncertain
                ? "unknown"
                : event.status === "succeeded"
                  ? "succeeded"
                  : event.status === "cancelled"
                    ? "cancelled"
                    : "failed",
              event.message,
            );
          } catch (error) {
            event = {
              ...event,
              status: "failed",
              resultUncertain: true,
              message: "执行请求收尾失败：" + String(error),
            };
          }
          await publish(event);
          finalStatus = event.status ?? "failed";
        } finally {
          await current.lease
            .finish("unknown", "结果收尾未确认")
            .catch(console.error);
          finishing = false;
          if (context === current) context = undefined;
          current.resolve(finalStatus);
          presence?.update(false, event.message);
        }
      };
      const loginOptions = {
        name: "GamePilot",
        path: process.execPath,
        args: app.isPackaged
          ? ["--autostart"]
          : [app.getAppPath(), "--autostart"],
      };
      if (
        smoke &&
        process.env.GAMEPILOT_SMOKE_ADB &&
        process.env.GAMEPILOT_SMOKE_ADDRESS
      ) {
        await settings.save({
          adbPath: process.env.GAMEPILOT_SMOKE_ADB,
          address: process.env.GAMEPILOT_SMOKE_ADDRESS,
          modelEndpoint: "",
          modelName: "",
        });
      }
      worker = new WorkerClient(
        join(__dirname, "../worker/index.cjs"),
        dataDir,
      );
      executions.trackWorker(worker, () => ["*"]);
      laneRuntime = new LaneRuntimeManager(
        join(__dirname, "../worker/index.cjs"),
        dataDir,
        undefined,
        (engine, resources) => executions.trackWorker(engine, resources),
        {
          maxConcurrent: 4,
          minFreeMemoryBytes: 1024 ** 3,
          waitTimeoutMs: 30 * 60_000,
        },
      );
      laneRuntime.on("event", (event: RunEvent) => {
        void publish(event).catch((error) => {
          console.error("设备槽位记录保存失败", error);
          if (event.laneId)
            void laneRuntime!.stop(event.laneId).catch(console.error);
          if (window && !window.isDestroyed())
            window.webContents.send("gp:event", {
              ...event,
              type: "engine",
              status: undefined,
              stepStatus: undefined,
              plan: undefined,
              message: "任务记录保存失败，已请求停止：" + String(error),
            });
        });
      });
      worker.on("event", (event: RunEvent) => {
        context?.results.accept(event);
        if (
          context &&
          event.status &&
          ["succeeded", "failed", "cancelled"].includes(event.status)
        ) {
          void finish(context, event).catch((error) =>
            console.error("任务结果保存失败", error),
          );
          return;
        }
        void publish(event).catch((error) => {
          console.error("执行记录保存失败", error);
          void worker.request("stop", undefined, 70000).catch(console.error);
          if (window && !window.isDestroyed())
            window.webContents.send("gp:event", {
              runId: "",
              type: "engine",
              message: "任务记录保存失败，已请求停止：" + String(error),
              at: new Date().toISOString(),
            });
        });
      });
      worker.on("exit", () => {
        connectedDevice = undefined;
        lastEngine = null;
        engineError = "执行器已停止，请重新连接";
        if (window && !window.isDestroyed())
          window.webContents.send("gp:event", {
            runId: "",
            type: "engine",
            message: engineError,
            at: new Date().toISOString(),
          } satisfies RunEvent);
      });
      const handle = (
        channel: string,
        handler: (payload: unknown) => unknown,
      ) =>
        ipcMain.handle(channel, (event, payload) => {
          if (
            !window ||
            event.sender !== window.webContents ||
            event.senderFrame !== window.webContents.mainFrame ||
            event.senderFrame.url !== rendererUrl
          )
            throw new Error("拒绝非应用页面的请求");
          if (
            plannerPreview &&
            [
              "gp:start",
              "gp:lane-start",
              "gp:game-slot-start",
              "gp:game-slot-stop",
              "gp:arknights-job-run",
              "gp:continuation-start",
              "gp:lanes-start",
              "gp:connect",
              "gp:capture",
              "gp:execution-inspect",
              "gp:agent-execution-confirm",
              "gp:incident-agent-start",
              "gp:incident-agent-confirm",
            ].includes(channel)
          )
            throw new Error(
              "AI 规划开发预览不连接或操作真实游戏，请使用正式版执行日常",
            );
          return handler(payload);
        });
      handle("gp:planner-snapshot", () => planner.verifiedSnapshot());
      handle("gp:agent-events", (input) =>
        agentJournal!.page(
          input as
            | import("../../../packages/protocol/agent-events").AgentEventQuery
            | undefined,
        ),
      );
      handle("gp:planner-start", async (input) => {
        await agentJournal!.assertReady();
        if (modelOperation || agentExecution?.active || chatCommands?.busy)
          throw new Error("模型配置或已确认任务正在处理，请稍后生成草稿");
        return planner.start(input);
      });
      handle("gp:planner-cancel", (id) => planner.cancel(id));
      const chatFile = join(dataDir, "agent-chat.json");
      chat = new ChatService({
        ...chatArchiveFiles(join(dataDir, "agent-chat-archives")),
        readCommands: (id) => chatCommands?.snapshot(id) ?? Promise.resolve([]),
        canArchive: (id) =>
          !chatCommands?.busy &&
          !goals
            ?.snapshot(id)
            .goals.some((g) =>
              [
                "preparing",
                "running",
                "waiting",
                "recovering",
                "cancelling",
              ].includes(g.status),
            ) &&
          !executions.snapshot(Number.MAX_SAFE_INTEGER).some((request) => {
            const origin = (
              request.snapshot.agent as { requestId?: string } | undefined
            )?.requestId;
            return (
              request.status === "running" &&
              (executionChatOwners.get(request.id) === id ||
                (origin &&
                  (commandChatOwners.get(origin) === id ||
                    chat?.requestTarget(origin)?.sessionId === id)))
            );
          }),
        planner,
        available: () => !modelOperation && !chatCommands?.busy && !quitting,
        load: async () => {
          try {
            const stored = JSON.parse(
              await boundedRead(chatFile, 8 * 1024 * 1024),
            );
            if (stored.version !== 1) throw Error("会话记录版本不支持");
            return stored.view;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              return undefined;
            throw error;
          }
        },
        save: async (view) => {
          await writeFile(
            chatFile + ".tmp",
            JSON.stringify({ version: 1, view }),
            "utf8",
          );
          await replaceFile(chatFile + ".tmp", chatFile, { atomicOnly: true });
        },
      });
      handle("gp:chat-snapshot", () => chat!.snapshot());
      chat.subscribe((view) => sendObservation("gp:chat-state", view));
      handle("gp:chat-new", () => chat!.newChat());
      handle("gp:chat-select", (id) => chat!.select(id));
      handle("gp:chat-archive", (input) => chat!.archive(input));
      handle("gp:chat-archive-restore", (input) =>
        chat!.restoreArchived(input),
      );
      handle("gp:chat-delete", (input) => chat!.delete(input));
      handle("gp:chat-archives", (input) => chat!.listArchived(input));
      handle("gp:chat-archive-load", (input) => chat!.loadArchived(input));
      handle("gp:chat-send", async (input) => {
        await agentJournal!.assertReady();
        if (modelOperation || chatCommands?.busy || quitting)
          throw new Error("模型配置或任务受理正在处理，请稍后发送需求");
        return chat!.send(input);
      });
      handle("gp:chat-cancel", (input) => chat!.cancel(input));
      handle("gp:model-provider", () => modelProvider.read());
      const withModelOperation = async (
        action: (signal: AbortSignal) => Promise<unknown>,
      ) => {
        if (
          modelOperation ||
          chat?.busy ||
          plannerActive(planner.snapshot()) ||
          starting ||
          agentExecution?.active ||
          chatCommands?.busy
        )
          throw new Error("请等待模型规划、保存或测试完成后再修改连接");
        const controller = new AbortController();
        modelOperation = controller;
        try {
          return await action(controller.signal);
        } finally {
          if (modelOperation === controller) modelOperation = undefined;
        }
      };
      handle("gp:model-provider-save", (input) =>
        withModelOperation(async () => modelProvider.save(input)),
      );
      handle("gp:model-provider-test", () =>
        withModelOperation(async (signal) => {
          const connection = await modelProvider.resolve();
          if (connection.provider !== "compatible" || !connection.apiKey)
            throw new Error("请选择兼容 API 并保存密钥后测试连接");
          const result = await testCompatibleConnection(
            {
              baseUrl: connection.baseUrl,
              model: connection.model,
              apiKey: connection.apiKey,
            },
            signal,
          );
          if ((await modelProvider.read()).revision !== connection.revision)
            throw new Error("模型配置已变化，请使用新配置重新测试");
          return result;
        }),
      );
      const recovery = new RecoveryService(
        executions,
        runLedger,
        appVersion,
        async (record) => {
          const device = await recoveryDevice(
            record,
            await deviceLanes.read(),
            await automation.read(),
            await settings.read(),
          );
          const inspector = new WorkerClient(
            join(__dirname, "../worker/index.cjs"),
            join(dataDir, "inspection"),
          );
          executions.trackWorker(inspector, () => record.resources);
          try {
            const arkConfig = record.snapshot.arknightsPlan
              ? record.snapshot.profile
              : (record.snapshot.plan as { gameId?: string } | undefined)
                    ?.gameId === "arknights"
                ? record.snapshot.arknights
                : undefined;
            const {
              id: _id,
              name: _name,
              ...inspectionConfig
            } = (arkConfig ?? {}) as Record<string, unknown>;
            return await inspector.request<DeviceInspection>(
              arkConfig ? "inspect-arknights" : "inspect-device",
              arkConfig ? { device, config: inspectionConfig } : device,
              60000,
            );
          } finally {
            await inspector.closeAndWait();
          }
        },
      );
      handle("gp:execution-review", (id) =>
        recovery.review(validateRequestId(id)),
      );
      const executionDetail = new ExecutionDetailService(executions, runLedger);
      const executionProgress = new ExecutionProgressService(
        executions,
        runLedger,
        executionDetail,
        readStartupFacts,
      );
      handle("gp:execution-progress", (id) => executionProgress.get(id));
      handle("gp:execution-detail", (id) => executionDetail.get(id));
      const failureEvidence = new FailureEvidenceService(
        dataDir,
        executions,
        runLedger,
      );
      handle("gp:failure-evidence", (id) =>
        failureEvidence.list(validateRequestId(id)),
      );
      handle("gp:failure-image", (input) => failureEvidence.read(input));
      handle("gp:failure-image-delete", (input) =>
        failureEvidence.remove(input),
      );
      handle("gp:execution-inspect", (id) => {
        if (
          starting ||
          connecting ||
          configuring ||
          finishing ||
          automaticReserved ||
          startupInspectionRunning ||
          !!context
        )
          throw Error("请在设备任务及设置操作结束后核对现场");
        return recovery.capture(validateRequestId(id));
      });
      handle("gp:execution-resolve", (input) => {
        const value = input as { id?: unknown; note?: unknown } | null;
        if (!value || typeof value.note !== "string")
          throw Error("请填写处置说明");
        return recovery.resolve(validateRequestId(value.id), value.note);
      });
      handle("gp:snapshot", async () => {
        try {
          if (!startupInspectionRunning)
            lastEngine = await worker.request<EngineInfo>("info");
          engineError = undefined;
        } catch (error) {
          lastEngine = null;
          engineError = error instanceof Error ? error.message : String(error);
        }
        return {
          events: history.snapshot(),
          plannerPreview,
          runs: runLedger.snapshot(),
          executions: executions.snapshot(),
          taskRecordError: runLedger.error ?? executions.error,
          games: games,
          settings: await settings.read(),
          engine: lastEngine,
          engineError,
        };
      });
      handle("gp:lane-preview-capture", async (input) => {
        if (
          smoke ||
          plannerPreview ||
          quitting ||
          configuring ||
          startupInspectionRunning
        )
          throw Error("当前环境暂不读取执行设备画面");
        const frame = await lanePreview!.capture(input);
        const suffix = `:${frame.laneId}`;
        const batchId = frame.requestId?.endsWith(suffix)
          ? frame.requestId.slice(0, -suffix.length)
          : undefined;
        return batchId && laneRuntime?.isRunningBatch(frame.laneId, batchId)
          ? frame
          : { ...frame, requestId: undefined, gameId: undefined };
      });
      handle("gp:onmyoji-identity-inspect", async (input) => {
        if (typeof input !== "string") throw Error("设备槽位编号无效");
        const configuredLane = (await deviceLanes.read()).lanes.find(
          (l) => l.id === input,
        );
        if (!configuredLane) throw Error("设备槽位不存在");
        const lane = freezeLaneDevice(configuredLane, ["onmyoji"]);
        if (
          starting ||
          connecting ||
          finishing ||
          configuring ||
          automaticReserved ||
          startupInspectionRunning ||
          executions.active ||
          history.active ||
          laneRuntime!.isRunning(lane.id)
        )
          throw Error("请在任务结束后核对角色页面");
        configuring = true;
        try {
          return await executions.inspect(
            [mumuResource(lane.managerPath, lane.instance)],
            async () => {
              const device = await currentMuMuDevice(
                lane.managerPath,
                lane.instance,
              );
              const reader = new WorkerClient(
                join(__dirname, "../worker/index.cjs"),
                join(dataDir, "identity-inspection", randomUUID()),
              );
              executions.trackWorker(reader, () => [
                mumuResource(lane.managerPath, lane.instance),
              ]);
              try {
                await reader.request("connect", device, 60000);
                const result = await reader.request<{
                  inspection: import("../../../packages/protocol/onmyoji-identity").OnmyojiIdentityInspection;
                }>(
                  "inspect-onmyoji-identity",
                  { config: { identity: lane.onmyoji.identity } },
                  10000,
                );
                return result.inspection;
              } finally {
                await reader.closeAndWait();
              }
            },
          );
        } finally {
          configuring = false;
        }
      });
      registerSettingsIpc({
        register: (channel, handler) => handle(channel, handler),
        busy: () => ({
          starting,
          connecting,
          finishing,
          configuring,
          automaticReserved,
          startupInspectionRunning,
          chatBusy: chatCommands?.busy === true,
          executionsActive: executions.active,
          historyActive: history.active,
        }),
        withConfiguring: async (action) => {
          configuring = true;
          try {
            return await action();
          } finally {
            configuring = false;
          }
        },
        anyLaneRunning: (lanes) =>
          lanes.lanes.some((lane) => laneRuntime!.isRunning(lane.id)),
        validateDeviceLanes,
        deviceLanes: {
          read: () => deviceLanes.read(),
          save: (value) => deviceLanes.save(value),
        },
        arknights: {
          read: () => arknights.read(),
          save: (value) => arknights.save(value),
        },
        settings: { save: (input) => settings.save(input) },
        automation: { read: () => automation.read() },
        invalidatePreview: () => lanePreview?.invalidateAll(),
        discoverInstances: (managerPath) => discoverMuMuInstances(managerPath),
        probeArknights: () =>
          executions.inspect(["*"], () =>
            worker.request("arknights-probe", undefined, 60000),
          ),
      });
      handle("gp:quit", () => {
        setImmediate(() => app.quit());
        return null;
      });
      handle("gp:automation", async () => ({
        ...(await automation.read()),
        openAtLogin: smoke
          ? false
          : app.getLoginItemSettings(loginOptions).openAtLogin,
      }));
      handle("gp:automation-save", async (input) => {
        if (
          starting ||
          chatCommands?.busy ||
          connecting ||
          finishing ||
          configuring ||
          automaticReserved ||
          startupInspectionRunning ||
          executions.active ||
          history.active
        )
          throw new Error("任务执行期间不能修改启动设置");
        configuring = true;
        try {
          const value = validateAutomation(input);
          // 重新启用只重新检查暂停条件；原未知记录须先处置或有新观测，不能由设置隐式改写。
          const fosterReenabled =
            value.fosterScheduleEnabled &&
            !(await automation.read()).fosterScheduleEnabled;
          const releaseIfRequested = async () => {
            if (!fosterReenabled) return;
            const result = await releaseMaintenancePause();
            if ((await automation.read()).notifyResults) {
              if (result.released.length)
                presence?.notify(
                  `已解除寄养维护暂停：${result.released.join("、")}。下一次检查会重新开始。`,
                  false,
                );
              for (const blocked of result.blocked)
                presence?.notify(
                  `${blocked.laneName} 的寄养仍暂停：${blocked.message}`,
                  true,
                );
            }
          };
          if (
            value.launchEmulator &&
            !(await detectMuMu(value.managerPath)).some(
              (i) =>
                i.managerPath.toLowerCase() === value.managerPath.toLowerCase(),
            )
          )
            throw new Error("MuMu 管理器或 ADB 不存在，请先检测并选择安装位置");
          if (!smoke) {
            const previous = app.getLoginItemSettings(loginOptions).openAtLogin;
            app.setLoginItemSettings({
              ...loginOptions,
              openAtLogin: value.openAtLogin,
            });
            try {
              if (
                app.getLoginItemSettings(loginOptions).openAtLogin !==
                value.openAtLogin
              )
                throw new Error(
                  "Windows 启动项设置未生效，请检查系统启动应用设置",
                );
              const saved = await automation.save(value);
              closeToTray = saved.closeToTray;
              await releaseIfRequested();
              return saved;
            } catch (error) {
              app.setLoginItemSettings({
                ...loginOptions,
                openAtLogin: previous,
              });
              throw error;
            }
          }
          const saved = await automation.save(value);
          await releaseIfRequested();
          return saved;
        } finally {
          configuring = false;
        }
      });
      handle("gp:mumu-detect", async () =>
        detectMuMu(
          (await automation.read()).managerPath,
          (await settings.read()).adbPath,
        ),
      );
      handle(
        "gp:notification-test",
        () => presence?.test() ?? "当前为测试模式，未发送系统通知",
      );
      handle("gp:discover", async () => {
        if (startupInspectionRunning) throw new Error("正在核验执行器退出");
        return executions.inspect(["*"], async () =>
          worker.request("discover", (await settings.read()).adbPath),
        );
      });
      handle("gp:connect", async (input) => {
        if (
          starting ||
          connecting ||
          finishing ||
          configuring ||
          automaticReserved ||
          startupInspectionRunning ||
          executions.active ||
          history.active
        )
          throw new Error("任务执行或连接期间不能切换设备");
        const device = validateDevice(input);
        connecting = true;
        try {
          return await executions.inspect(["*"], async () => {
            lastEngine = null;
            lastEngine = await worker.request<EngineInfo>(
              "connect",
              device,
              60000,
            );
            connectedDevice = device;
            engineError = undefined;
            const saved = await settings.read();
            await settings.save({
              ...saved,
              adbPath: device.adbPath,
              address: device.address,
            });
            return lastEngine;
          });
        } finally {
          connecting = false;
        }
      });
      handle("gp:capture", () => {
        if (finishing || startupInspectionRunning)
          throw Error("正在完成任务收尾，请稍后");
        return executions.inspect(["*"], () => worker.request("capture"));
      });
      const startPlan = async (input: unknown, waitForCompletion = false) => {
        if (startupInspectionRunning) throw new Error("正在核验执行器退出");
        if (executions.hasUnconfirmedExit())
          throw new Error("故障执行器退出尚未确认，暂不接收设备输入");
        runLedger.assertHealthy();
        executions.assertHealthy();
        const envelope =
          input && typeof input === "object" && "plan" in input
            ? (input as { plan: unknown; requestId?: unknown })
            : { plan: input };
        const requestId =
          envelope.requestId === undefined
            ? randomUUID()
            : validateRequestId(envelope.requestId);
        const plan = validatePlan(envelope.plan, games);
        if (laneRuntime?.active || executions.active)
          throw new Error("已有设备任务正在运行");
        if (
          !!context ||
          starting ||
          connecting ||
          finishing ||
          configuring ||
          (automaticReserved && !waitForCompletion) ||
          history.active
        )
          throw new Error("已有任务执行或设备连接正在进行");
        starting = true;
        const startController = new AbortController();
        preparing = startController;
        presence?.update(true, "准备执行任务");
        let submitted = false;
        let lease: ExecutionLease | undefined;
        let startError: unknown;
        try {
          const config = await automation.read();
          const arkConfig =
            plan.gameId === "arknights"
              ? activeArknightsConfig(await arknights.read())
              : undefined;
          if (
            arkConfig &&
            dailySkills("arknights").every((id) => plan.skillIds.includes(id))
          )
            plan.skillIds = arknightsDailySkills(arkConfig);
          if (arkConfig && plan.mode === "live")
            validateArknightsCapabilities(arkConfig, plan.skillIds);
          const savedDevice = await settings.read();
          lease = await executions.begin(
            {
              id: requestId,
              source: "single",
              resources: ["*"],
              snapshot: {
                appVersion,
                plan,
                automation: config,
                arknights: arkConfig,
                device: {
                  adbPath: savedDevice.adbPath,
                  address: savedDevice.address,
                },
              },
            },
            startController.signal,
          );
          let owned: OwnedMuMu | undefined;
          if (plan.mode === "live") {
            if (config.launchEmulator) {
              const runId = randomUUID();
              const emit = async (
                message: string,
                status?: RunEvent["status"],
              ) => {
                const event: RunEvent = {
                  runId,
                  gameId: plan.gameId,
                  type: status ? "status" : "log",
                  message,
                  at: new Date().toISOString(),
                  ...(status ? { status } : {}),
                };
                await publish(event);
              };
              await emit("准备模拟器", "running");
              try {
                const prepared = await devicePreparation.prepareMuMu({
                  name: "MuMu",
                  managerPath: config.managerPath,
                  adbPath: (await settings.read()).adbPath,
                  instance: config.instance,
                  worker,
                  signal: startController.signal,
                  log: emit,
                  onResolved: async (managerPath) => {
                    if (config.managerPath !== managerPath) {
                      config.managerPath = managerPath;
                      await automation.save(config);
                    }
                  },
                });
                owned = prepared.owned;
                lastEngine = prepared.engine;
                connectedDevice = prepared.device;
                await settings.save({
                  ...(await settings.read()),
                  adbPath: prepared.device.adbPath,
                  address: prepared.device.address,
                });
                await emit("模拟器已就绪", "succeeded");
              } catch (error) {
                await emit(
                  preparing.signal.aborted ? "已取消模拟器准备" : String(error),
                  preparing.signal.aborted ? "cancelled" : "failed",
                );
                throw error;
              }
            }
            const connected = await devicePreparation.ensureConnected({
              worker,
              signal: startController.signal,
              readDevice: () => settings.read(),
            });
            lastEngine = connected.engine;
            if (connected.device) connectedDevice = connected.device;
            engineError = undefined;
          }
          let resolve!: (status: string) => void;
          const done = new Promise<string>((r) => {
            resolve = r;
          });
          const scope = await scopeOf(config);
          const results = new SkillResultQueue(plan, async (event) => {
            if (
              event.gameId !== "onmyoji" ||
              event.skillId !== "foster" ||
              !event.result
            )
              return;
            const target = await findFosterLane(
              (await deviceLanes.read()).lanes,
              config,
              connectedDevice?.address,
              discoverMuMuInstances,
            );
            if (target)
              await getLaneFosterScheduler(target).calibrate(
                event.result,
                dailyLaneScope(target),
              );
            else await legacyFosterScheduler.calibrate(event.result, scope);
          });
          context = {
            executionId: requestId,
            lease,
            plan,
            config,
            owned,
            done,
            resolve,
            scope,
            results,
          };
          if (arkConfig) await worker.request("arknights-config", arkConfig);
          startController.signal.throwIfAborted();
          const result = await worker.request<{ runId: string }>("start", plan);
          results.bind(result.runId);
          submitted = true;
          if (startController.signal.aborted)
            await worker.request("stop", undefined, 70000);
          await runLedger.flush();
          await history.flush();
          return {
            ...result,
            ...(waitForCompletion ? { status: await done } : {}),
          };
        } catch (error) {
          startError = error;
          throw error;
        } finally {
          if (!submitted) {
            context?.results.bind("");
            context = undefined;
            await lease
              ?.finish(
                startController.signal.aborted ? "cancelled" : "unknown",
                "启动未确认，未自动重放：" + String(startError),
                startController.signal.aborted
                  ? undefined
                  : startupFaultFrom(startError),
              )
              .catch(console.error);
          }
          if (preparing === startController) preparing = undefined;
          starting = false;
          presence?.update(
            finishing || history.active,
            history.active ? "正在执行任务" : "等待任务",
          );
        }
      };
      handle("gp:start", startPlan);
      const lanePreparations = new Map<string, AbortController>();
      const cancelledLaneCycles = new Set<string>();
      let automaticCycle: AbortController | undefined;
      const automaticLaneIds = new Set<string>();
      const deferMaintenance = async (ids: string[]) => {
        if (!ids.length) return;
        for (const id of ids) cancelledLaneCycles.add(id);
        for (const lane of (await deviceLanes.read()).lanes.filter((lane) =>
          ids.includes(lane.id),
        ))
          await getLaneFosterScheduler(lane).defer(
            new Date(),
            dailyLaneScope(lane),
          );
      };
      const executeDeviceLane = async (
        frozen: LaneExecutionSnapshot,
        laneWorker: LaneWorker,
        batchId: string,
        signal: AbortSignal,
        lease: ExecutionLease,
        maintenance = false,
        scheduleScope = dailyLaneScope(frozen.lane),
        custom = false,
        scheduled = false,
        continuation = false,
        dailySlot?: import("./scheduler").DailySlot,
      ) => {
        const { lane, profile, arknightsPlan, onmyojiPlan } = frozen;
        // A reused worker must not attribute preparation frames to its previous batch.
        lanePreview?.unregister(lane.id, laneWorker);
        const startedAt = new Date(frozen.startedAt);
        let activeGameId = lane.arknights.enabled ? "arknights" : "onmyoji";
        let budget: ReturnType<typeof runBudget> | undefined;
        let owned: PreparedMuMuDevice["owned"] | undefined;
        const saveObservation = (
          status: "succeeded" | "failed" | "cancelled",
          message: string,
        ) =>
          observations.save({
            version: 1,
            id: batchId,
            laneId: lane.id,
            startedAt: startedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            status,
            message,
            appVersion,
            gameId: activeGameId,
            ...(profile
              ? {
                  profileId: profile.id,
                  stage: profile.stage,
                  mail: profile.mail,
                }
              : {}),
          });
        const emit = async (message: string, status?: RunEvent["status"]) => {
          await publish({
            runId: batchId,
            startedAt: startedAt.toISOString(),
            planKey: continuation
              ? `${deviceLanePlanKey(lane)}:continuation:${batchId}`
              : deviceLanePlanKey(lane),
            executionSource: maintenance
              ? "maintenance"
              : custom && !continuation
                ? "single"
                : "daily",
            maintenance,
            batchId,
            laneId: lane.id,
            gameId: activeGameId,
            type: status ? "status" : "log",
            message,
            at: new Date().toISOString(),
            ...(status ? { status } : {}),
          });
          if (status === "failed" || status === "succeeded") {
            try {
              if ((await automation.read()).notifyResults)
                presence?.notify(message, status === "failed");
            } catch {
              // Notification delivery must not alter the confirmed game result.
            }
          }
        };
        try {
          if (profile) {
            budget = runBudget(
              signal,
              startedAt.getTime() + profile.maxRunMinutes * 60_000,
            );
            signal = budget.signal;
          }
          signal.throwIfAborted();
          await emit(`${lane.name} 开始执行`, "running");
          const result = await executeLanePlan(
            lane,
            {
              gameStarted: (gameId) => {
                activeGameId = gameId;
                lanePreview?.updateContext(lane.id, laneWorker, {
                  requestId: `${batchId}:${lane.id}`,
                  gameId,
                });
              },
              prepare: async () => {
                const controller = new AbortController();
                const cancel = () => controller.abort(signal.reason);
                signal.addEventListener("abort", cancel, { once: true });
                if (signal.aborted) controller.abort(signal.reason);
                lanePreparations.set(lane.id, controller);
                try {
                  const prepared = await devicePreparation.prepareMuMu({
                    name: lane.name,
                    managerPath: lane.managerPath,
                    instance: lane.instance,
                    worker: laneWorker,
                    signal: controller.signal,
                    log: emit,
                    preview: lanePreview
                      ? {
                          lane,
                          service: lanePreview,
                          isQuitting: () => quitting,
                          requestId: `${batchId}:${lane.id}`,
                          gameId: activeGameId,
                        }
                      : undefined,
                  });
                  owned = prepared.owned;
                } finally {
                  lanePreparations.delete(lane.id);
                  signal.removeEventListener("abort", cancel);
                }
              },
              arknights: async () => {
                if (!profile)
                  throw new Error(`${lane.name} 的明日方舟账号档案不存在`);
                const { id: _id, name: _name, ...runtimeConfig } = profile;
                // P1-2：跟随当前活动关卡（活动换期自动适配）；解析失败回退档案关卡，不猜。
                const followed = await resolveRunStage({
                  enabled:
                    runtimeConfig.taskOptions?.fight?.followActivity ?? false,
                  clientType: runtimeConfig.clientType,
                  configuredStage: runtimeConfig.stage,
                  resolver: activityStageResolver,
                  // 活动结束/无活动关时回退经验本 LS-5（与 daily-arknights.ps1 的 -FallbackStage 一致）
                  fallbackStage: resolveArknightsTaskOptions(
                    runtimeConfig.taskOptions,
                  ).fight.fallbackStage,
                });
                await emit(followed.note, "running");
                const effectiveConfig =
                  followed.stage !== runtimeConfig.stage
                    ? { ...runtimeConfig, stage: followed.stage }
                    : runtimeConfig;
                await laneWorker.request("arknights-config", effectiveConfig);
                await runWorkerPlan(
                  laneWorker,
                  arknightsPlan!,
                  signal,
                  undefined,
                  frozen.copilot
                    ? () =>
                        laneWorker.request("execute-copilot", {
                          prepared: frozen.copilot,
                          config: effectiveConfig,
                        })
                    : undefined,
                );
                await runLedger.flush();
              },
              closeArknights: async () => {
                if (!profile) throw new Error("明日方舟账号档案尚未加载");
                const exit = await laneWorker.request<
                  import("../../../packages/protocol/execution-observation").WorkerExitObservation
                >("arknights-close", undefined, 70000);
                signal.throwIfAborted();
                if (
                  !owned ||
                  exit.device.adbPath !== owned.adbPath ||
                  exit.device.address !== owned.address
                )
                  throw Error("退出观察设备与本次连接不一致，不能交接下一游戏");
                if (!lease.observe)
                  throw Error("退出观察存储未就绪，不能交接下一游戏");
                await lease.observe(exit);
                budget?.dispose();
                await emit("已确认明日方舟退出");
              },
              onmyoji: async () => {
                await laneWorker.request("onmyoji-config", {
                  identity: lane.onmyoji.identity,
                });
                await runWorkerPlan(
                  laneWorker,
                  onmyojiPlan!,
                  signal,
                  async (event) => {
                    if (event.skillId === "foster" && event.result)
                      await getLaneFosterScheduler(lane).calibrate(
                        event.result,
                        scheduleScope,
                      );
                  },
                );
                await runLedger.flush();
              },
            },
            signal,
          );
          if (lane.closeEmulatorAfterSuccess && owned) {
            const closed = await closeOwnedMuMu(owned);
            await emit(closed ? "已关闭本次启动的 MuMu" : "保留已有 MuMu 实例");
          }
          const completionMessage = `${lane.name} ${frozen.copilot ? "本次临时作业已通过原生逐场结果及返回主页核验" : maintenance ? "本次寄养维护已完成" : continuation ? "本次续跑已完成" : custom ? "本次单项请求已完成" : "本次日常计划已完成"}`;
          if (!maintenance && !custom)
            await saveObservation("succeeded", completionMessage);
          if (!maintenance && !custom && !scheduled)
            await laneDailySchedulers
              .get(lane.id)
              ?.complete(
                startedAt,
                scheduleScope,
                await automation.read(),
                dailySlot,
              );
          await lease.finish("succeeded", completionMessage);
          await emit(completionMessage, "succeeded");
          return result;
        } catch (caught) {
          const error = runFailure(caught, signal);
          const cancelled =
            error instanceof Error && error.name === "AbortError";
          let message = cancelled
            ? `${lane.name} 已取消`
            : `${lane.name}：${String(error)}`;
          if (!maintenance && !custom) {
            try {
              await saveObservation(
                cancelled ? "cancelled" : "failed",
                message,
              );
            } catch (saveError) {
              message += `；运行观察记录保存失败：${String(saveError)}`;
            }
          }
          await lease
            .finish(
              cancelled
                ? "cancelled"
                : unsubmittedStartupFailure(
                      error,
                      `${batchId}:${lane.id}`,
                      runLedger.snapshot(Number.MAX_SAFE_INTEGER),
                    )
                  ? "failed"
                  : "unknown",
              message,
              cancelled ? undefined : startupFaultFrom(error),
            )
            .catch((saveError) => {
              message += "；执行请求记录保存失败：" + String(saveError);
            });
          await emit(message, cancelled ? "cancelled" : "failed");
          await runLedger.flush();
          if (
            !cancelled &&
            !maintenance &&
            (!custom ||
              goals
                ?.snapshot()
                .goals.some((g) =>
                  g.attempts.some((a) =>
                    a.submission.requestIds.includes(`${batchId}:${lane.id}`),
                  ),
                )) &&
            !smoke
          )
            await incidentAgent
              ?.enqueue(`${batchId}:${lane.id}`)
              .catch(() => {});
          throw error;
        } finally {
          budget?.dispose();
        }
      };
      const assertLaneCanStart = async (lane: DeviceLane) => {
        validateLaneProfiles([lane], await arknights.read());
        if (startupInspectionRunning)
          throw new Error("正在核验原生执行器退出，请稍后再试");
        if (
          executions.hasUnconfirmedExit([
            mumuResource(lane.managerPath, lane.instance),
          ])
        )
          throw new Error("此设备恢复执行器退出尚未确认，暂不接收新任务");
        runLedger.assertHealthy();
        executions.assertHealthy();
        if (!lane.enabled) throw new Error(`${lane.name} 未启用`);
        if (laneRuntime!.isRunning(lane.id))
          throw new Error(`${lane.name} 正在运行`);
        if (
          lane.arknights.enabled &&
          !(await arknights.read()).profiles.some(
            (profile) => profile.id === lane.arknights.profileId,
          )
        )
          throw new Error(`${lane.name} 的明日方舟账号档案不存在，请重新绑定`);
        if (starting || connecting || finishing || configuring || !!context)
          throw new Error("单设备任务或设置操作正在进行，请等待结束");
      };
      const laneJobs = new Map<string, Promise<unknown>>();
      // Only explicit single-game starts own this capability. Legacy mixed
      // requests and automatic cycles cannot be cancelled through a slot button.
      const gameSlotRuns = new Map<
        string,
        {
          gameId: "arknights" | "onmyoji";
          batchId: string;
          controller: AbortController;
          done: Promise<void>;
        }
      >();
      const prepareStartupInspection = async (
        resources: string[],
        signal: AbortSignal,
      ): Promise<StartupInspectionPermit> => {
        signal.throwIfAborted();
        startupFacts.assertHealthy();
        runLedger.assertHealthy();
        executions.assertHealthy();
        if (
          startupInspectionRunning ||
          laneJobs.size ||
          lanePreparations.size ||
          executions.active ||
          laneRuntime!.active ||
          automaticReserved ||
          starting ||
          connecting ||
          finishing ||
          configuring ||
          context ||
          !resources.length ||
          resources.includes("*")
        )
          throw new AgentToolError(
            "STARTUP_INSPECTION_BUSY",
            "设备或执行器仍在使用，不能开始独立登录核验",
          );
        startupInspectionRunning = true;
        try {
          await laneRuntime!.disposeIdle();
          await worker.closeAndWait();
          const proof = await verifyNativeExecutorExit(signal);
          return { ...proof, resources: [...resources] };
        } finally {
          startupInspectionRunning = false;
        }
      };
      const continuationService = new ContinuationService({
        executions,
        ledger: runLedger,
        details: executionDetail,
        lanes: () => deviceLanes.read(),
        profiles: () => arknights.read(),
        appVersion,
        startupFacts: readStartupFacts,
        assertCanStart: async (lane) => {
          if (automaticReserved)
            throw new Error("自动计划正在执行，请等待完成或停止全部任务");
          await assertLaneCanStart(lane);
          if (laneJobs.has(lane.id))
            throw new Error(`${lane.name} 正在启动或运行`);
        },
      });
      const startupGoalRecovery =
        createGoalStartupRecovery(continuationService);
      handle("gp:continuation-preview", (id) => {
        if (typeof id !== "string") throw new Error("请求编号无效");
        return continuationService.preview(id);
      });
      const startContinuation = async (
        input: unknown,
        externalSignal?: AbortSignal,
        hostOrigin?: { requestId: string; kind: "continue" },
        goalBatchId?: string,
      ) => {
        const value =
          input as import("../../../packages/protocol/continuation").ContinuationInput;
        if (!value || typeof value.parentId !== "string")
          throw new Error("续跑参数无效");
        const laneId = executions.get(value.parentId).laneId;
        if (!laneId || laneJobs.has(laneId) || lanePreparations.has(laneId))
          throw new Error("此设备正在启动或运行，不能继续旧请求");
        const admission = new AbortController();
        const cancelAdmission = () => admission.abort();
        externalSignal?.addEventListener("abort", cancelAdmission, {
          once: true,
        });
        if (externalSignal?.aborted) admission.abort();
        lanePreparations.set(laneId, admission);
        try {
          const start = goalBatchId
            ? (
                value: import("../../../packages/protocol/continuation").ContinuationInput,
                launch: Parameters<ContinuationService["start"]>[1],
                signal?: AbortSignal,
              ) =>
                continuationService.startForGoal(value, launch, signal, {
                  batchId: goalBatchId,
                  origin: hostOrigin,
                })
            : continuationService.start.bind(continuationService);
          return await start(
            value,
            async (frozen, batchId, lease) => {
              admission.signal.throwIfAborted();
              if (lanePreparations.get(laneId) === admission)
                lanePreparations.delete(laneId);
              const job = laneRuntime!.run(
                frozen.lane,
                (_selected, laneWorker, signal) =>
                  executeDeviceLane(
                    frozen,
                    laneWorker,
                    batchId,
                    signal,
                    lease,
                    false,
                    dailyLaneScope(frozen.lane),
                    true,
                    false,
                    true,
                  ),
                batchId,
              );
              laneJobs.set(frozen.lane.id, job);
              try {
                return await job;
              } finally {
                if (laneJobs.get(frozen.lane.id) === job)
                  laneJobs.delete(frozen.lane.id);
                if (goalBatchId && hostOrigin && goals)
                  void startupGoalRecovery
                    .settled(goals, hostOrigin.requestId)
                    .catch(() => {});
              }
            },
            admission.signal,
            hostOrigin,
          );
        } finally {
          externalSignal?.removeEventListener("abort", cancelAdmission);
          if (lanePreparations.get(laneId) === admission)
            lanePreparations.delete(laneId);
        }
      };
      handle("gp:continuation-start", (input) => startContinuation(input));
      const incidentContext = new IncidentContext({
        executions,
        details: executionDetail,
        evidence: failureEvidence,
        continuations: continuationService,
        readConfigured: () =>
          readConfiguredSnapshot(dataDir, { history: true }),
        readAdmissionFingerprint: async (id) => {
          const target = executions.get(id);
          const requests = executions
            .snapshot(Number.MAX_SAFE_INTEGER)
            .filter(
              (r) =>
                r.id === id ||
                r.laneId === target.laneId ||
                r.resources.some(
                  (resource) =>
                    resource === "*" || target.resources.includes(resource),
                ),
            );
          const ids = new Set(requests.map((r) => r.id));
          const tasks = runLedger
            .snapshot(Number.MAX_SAFE_INTEGER)
            .filter(
              (t) =>
                (t.executionId && ids.has(t.executionId)) ||
                t.laneId === target.laneId,
            );
          return createHash("sha256")
            .update(
              canonical({
                configuration: (
                  await readConfiguredSnapshot(dataDir, { history: false })
                ).fingerprint,
                requests,
                tasks,
              }),
            )
            .digest("hex");
        },
        navigation: {
          withLease: async (id, signal, work) => {
            signal.throwIfAborted();
            const record = executions.get(id);
            if (executions.hasUnconfirmedExit(record.resources))
              throw new Error("故障执行器退出尚未确认，设备暂不可操作");
            return executions.inspect(record.resources, async () => {
              const device = await recoveryDevice(
                record,
                await deviceLanes.read(),
                await automation.read(),
                await settings.read(),
              );
              signal.throwIfAborted();
              return work(device.address);
            });
          },
          inspect: (id, signal) => incidentNavigation(id, signal, false),
          returnHome: (id, signal) => incidentNavigation(id, signal, true),
        },
        recognize: async (image, signal, gameId) => {
          signal.throwIfAborted();
          const reader = new WorkerClient(
            join(__dirname, "../worker/index.cjs"),
            join(dataDir, "incident-ocr"),
          );
          const cancel = () => reader.close();
          signal.addEventListener("abort", cancel, { once: true });
          try {
            return await reader.request<
              import("../../../packages/protocol/incident-agent").IncidentScreen
            >("recognize-failure-image", { image, gameId }, 60000);
          } finally {
            signal.removeEventListener("abort", cancel);
            reader.close();
          }
        },
      });
      async function incidentNavigation(
        id: string,
        signal: AbortSignal,
        navigate: boolean,
      ): Promise<DeviceInspection> {
        await agentJournal!.assertReady();
        signal.throwIfAborted();
        const record = executions.get(id);
        const device = await recoveryDevice(
          record,
          await deviceLanes.read(),
          await automation.read(),
          await settings.read(),
        );
        const raw = record.snapshot.arknightsPlan
          ? record.snapshot.profile
          : record.snapshot.arknights;
        const {
          id: _id,
          name: _name,
          ...config
        } = (raw ?? {}) as Record<string, unknown>;
        const inspector = new WorkerClient(
          join(__dirname, "../worker/index.cjs"),
          join(dataDir, "incident-navigation"),
        );
        executions.trackWorker(inspector, () => record.resources);
        let stopping: Promise<unknown> | undefined;
        const cancel = () => {
          stopping ??= inspector
            .request("stop", undefined, 70000)
            .catch(() => {});
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          signal.throwIfAborted();
          const result = navigate
            ? (
                await inspector.request<{ capture: DeviceInspection }>(
                  "return-arknights-home",
                  { device, config },
                  180000,
                )
              ).capture
            : await inspector.request<DeviceInspection>(
                "inspect-arknights",
                { device, config },
                60000,
              );
          signal.throwIfAborted();
          return result;
        } finally {
          signal.removeEventListener("abort", cancel);
          await stopping;
          try {
            await inspector.closeAndWait();
          } catch (error) {
            await recordAgent({
              requestId: id,
              kind: "recovery",
              status: "unknown",
              text: "恢复执行器退出未确认；目标设备已暂停新输入",
            });
            throw error;
          }
        }
      }
      const incidentFile = join(dataDir, "incident-agent.json");
      const incidentEventCursors = new Map<string, number>();
      incidentAgent = new IncidentAgentService({
        prepare: async (id, signal) => {
          const goal = goals
            ?.snapshot()
            .goals.find((g) =>
              g.attempts.some((a) => a.submission.requestIds.includes(id)),
            );
          if (goal) await goals!.refresh(goal.id);
          return incidentContext.prepare(id, signal);
        },
        hostManagedRecovery: (id) => {
          const goal = goals
            ?.snapshot()
            .goals.find((g) =>
              g.attempts.some((a) => a.submission.requestIds.includes(id)),
            );
          // Ownership selects the protected route. Missing proof must be rejected
          // by GoalService; it must never fall back to navigation before admission.
          return !!goal;
        },
        currentFingerprint: (id) => incidentContext.fingerprint(id),
        recover: (id, action, signal) =>
          incidentContext.recover(id, action, signal),
        canDiagnose: () =>
          !smoke && !plannerPreview && !quitting && !modelOperation,
        canRecover: (id) => {
          const target = executions.get(id);
          const goal = goals
            ?.snapshot()
            .goals.find((g) =>
              g.attempts.some((a) => a.submission.requestIds.includes(id)),
            );
          return (
            !smoke &&
            !plannerPreview &&
            !quitting &&
            !modelOperation &&
            !context &&
            !starting &&
            !connecting &&
            !configuring &&
            !finishing &&
            (!goal ||
              (!goal.cancelledAt &&
                !goal.grant.revokedAt &&
                goal.retryCount < goal.grant.maxRetries &&
                Date.now() < Date.parse(goal.grant.expiresAt))) &&
            !executions.hasUnconfirmedExit(target.resources) &&
            (!target.laneId ||
              (!laneJobs.has(target.laneId) &&
                !lanePreparations.has(target.laneId)))
          );
        },
        available: () =>
          !smoke &&
          !plannerPreview &&
          !quitting &&
          !automaticReserved &&
          !context &&
          !starting &&
          !connecting &&
          !configuring &&
          !finishing &&
          !laneJobs.size &&
          !lanePreparations.size &&
          !chat?.busy &&
          !plannerActive(planner.snapshot()),
        diagnose: async (bundle, signal) => {
          const journalRequestId =
            incidentAgent
              ?.snapshot()
              .sessions.find((s) => s.status === "running")?.requestId ??
            `incident:${bundle.incident.run.requestId}`;
          const c = await modelProvider.resolve();
          if (c.provider === "compatible" && !c.apiKey)
            throw new AgentToolError(
              "MODEL_UNAVAILABLE",
              "故障诊断需要已配置的OpenAI兼容模型接口与密钥",
            );
          const onEvent = (
            event: import("../../../packages/protocol/agent-planner").PlannerStreamEvent,
          ) => {
            const receipt = modelEventReceipt(journalRequestId, event);
            if (receipt) void recordAgent(receipt).catch(() => {});
          };
          const result =
            c.provider === "compatible"
              ? await diagnoseIncident(
                  { baseUrl: c.baseUrl, model: c.model, apiKey: c.apiKey! },
                  bundle,
                  signal,
                  onEvent,
                )
              : await diagnoseIncidentWithCodex(
                  {
                    executable: await findCodexExecutable({ signal }),
                    model: c.model,
                  },
                  bundle,
                  signal,
                  onEvent,
                );
          if ((await modelProvider.read()).revision !== c.revision)
            throw new AgentToolError(
              "MODEL_CONFIG_CHANGED",
              "模型连接已变化，请重新诊断",
            );
          return result;
        },
        resume: async (input, signal) => {
          const goal = goals
            ?.snapshot()
            .goals.find((g) =>
              g.attempts.some((a) =>
                a.submission.requestIds.includes(input.parentId),
              ),
            );
          if (!goal) return startContinuation(input, signal);
          signal.throwIfAborted();
          await goals!.refresh(goal.id);
          const recovered = await goals!.recover(goal.id, {
            sessionId: goal.sessionId,
            turnId: goal.turnId,
          });
          if (
            !recovered.receipt ||
            recovered.submission?.parentRequestId !== input.parentId ||
            !["waiting", "running"].includes(recovered.status)
          )
            throw new AgentToolError(
              "GOAL_RECOVERY_BLOCKED",
              recovered.message,
            );
          return { requestId: recovered.receipt.requestIds[0] };
        },
        load: async () => {
          try {
            const stored = JSON.parse(
              await boundedRead(incidentFile, 2 * 1024 * 1024),
            );
            if (stored.version !== 1) throw Error("故障会话文件版本不支持");
            for (const session of stored.view.sessions ?? [])
              incidentEventCursors.set(
                session.requestId,
                session.events?.at(-1)?.seq ?? 0,
              );
            return stored.view;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT")
              return undefined;
            throw e;
          }
        },
        save: async (view) => {
          await writeFile(
            incidentFile + ".tmp",
            JSON.stringify({ version: 1, view }),
            "utf8",
          );
          await replaceFile(incidentFile + ".tmp", incidentFile, {
            atomicOnly: true,
          });
          if (window && !window.isDestroyed())
            window.webContents.send("gp:incident-agent-state", view);
          for (const session of view.sessions) {
            const cursor = incidentEventCursors.get(session.requestId) ?? 0;
            for (const event of session.events.filter(
              (event) => event.seq > cursor,
            ))
              await recordAgent({
                requestId: session.requestId,
                kind: "recovery",
                status: ["partial", "manual", "waiting"].includes(event.status)
                  ? "unknown"
                  : (event.status as
                      | "running"
                      | "succeeded"
                      | "failed"
                      | "unknown"
                      | "cancelled"),
                text: `故障处理：${event.text}`.slice(0, 4000),
              });
            incidentEventCursors.set(
              session.requestId,
              session.events.at(-1)?.seq ?? cursor,
            );
          }
        },
        successorResult: (id) => {
          const r = executions.get(id);
          if (r.status === "running") return;
          const p = executionProgress.get(id);
          return {
            outcome:
              r.status === "succeeded" && !p.wholePlanComplete
                ? ("partial" as const)
                : r.status,
            wholePlanComplete: p.wholePlanComplete,
            summary: p.wholePlanComplete
              ? "原计划已补齐（账本确认）；原失败保留。"
              : `后续请求${r.status}，仍需核对原计划剩余步骤。`,
            evidenceRefs: [`execution:${id}`],
          };
        },
      });
      handle("gp:incident-agent-snapshot", () => incidentAgent!.snapshot());
      handle("gp:incident-agent-start", (input) => {
        const v = agentObject(input, ["requestId", "feedback"]);
        return incidentAgent!.enqueue(
          validateRequestId(v.requestId),
          v.feedback as string | undefined,
          false,
        );
      });
      handle("gp:incident-agent-cancel", (id) =>
        incidentAgent!.cancel(validateRequestId(id)),
      );
      handle("gp:incident-agent-confirm", (id) =>
        incidentAgent!.confirm(validateRequestId(id)),
      );
      if (!smoke && !plannerPreview)
        incidentTimer = setInterval(
          () => void incidentAgent?.tick().catch(() => {}),
          1000,
        );
      const launchLane = async (
        lane: DeviceLane,
        batchId: string,
        maintenance = false,
        cycleSignal?: AbortSignal,
        occurrence?: import("./scheduler").DailyOccurrence,
        /** P1a'：只跑这个游戏（「槽位 × 游戏」= 一个账号级执行单元）。省略则保持旧行为。 */
        game?: string,
        gameSlot?: import("../../../packages/protocol").GameSlotTarget,
        automationJob?: ArknightsJob | OnmyojiJob,
      ) => {
        const scheduleScope = dailyLaneScope(lane);
        const completesWholeChannel =
          !gameSlot ||
          (lane[gameSlot.gameId].enabled &&
            lane.arknights.enabled !== lane.onmyoji.enabled);
        const frozen = automationJob
          ? game === "onmyoji"
            ? freezeOnmyojiJob(
                lane,
                await arknights.read(),
                automationJob as OnmyojiJob,
              )
            : freezeArknightsJob(
                lane,
                await arknights.read(),
                automationJob as ArknightsJob,
              )
          : game
            ? freezeLaneExecutionForGame(
                lane,
                await arknights.read(),
                game,
                maintenance,
                new Date(),
                occurrence?.slot,
              )
            : freezeLaneExecution(
                lane,
                await arknights.read(),
                maintenance,
                new Date(),
                occurrence?.slot,
              );
        if (!frozen)
          throw new Error(`槽位 ${lane.id} 的 ${game} 不在本次执行范围内`);
        lane = frozen.lane;
        cycleSignal?.throwIfAborted();
        await assertLaneCanStart(lane);
        if (!maintenance) {
          await runLedger.flush();
          executions.assertHealthy();
          runLedger.assertHealthy();
          // 2026-10-25（用户要求去臃肿）：用户**主动点槽位运行**时，不再被"历史不确定/未完记录"拦下。
          // 仍保留：正在运行中的互斥（assertLaneCanStart）与账本健康检查；定时任务照旧走完整历史闸门。
          if (!gameSlot)
            assertDailyHistoryClear(
              frozen,
              executions.snapshot(Number.MAX_SAFE_INTEGER),
              runLedger.snapshot(Number.MAX_SAFE_INTEGER),
              new Date(),
              readStartupFacts(),
              occurrence,
            );
        }
        if (maintenance)
          assertMaintenanceClear(
            lane,
            executions.snapshot(Number.MAX_SAFE_INTEGER),
            runLedger.snapshot(Number.MAX_SAFE_INTEGER),
          );
        cycleSignal?.throwIfAborted();
        if (cycleSignal && cancelledLaneCycles.has(lane.id))
          throw new DOMException("已停止此设备计划", "AbortError");
        if (laneJobs.has(lane.id) || lanePreparations.has(lane.id))
          throw new Error(`${lane.name} 正在运行`);
        const admission = new AbortController();
        lanePreparations.set(lane.id, admission);
        let settleSlot: (() => void) | undefined;
        const slotRun = gameSlot
          ? {
              gameId: gameSlot.gameId,
              batchId,
              controller: admission,
              done: new Promise<void>((resolve) => {
                settleSlot = resolve;
              }),
            }
          : undefined;
        if (slotRun) gameSlotRuns.set(lane.id, slotRun);
        const releaseSlot = () => {
          if (slotRun && gameSlotRuns.get(lane.id) === slotRun)
            gameSlotRuns.delete(lane.id);
          settleSlot?.();
        };
        let lease: ExecutionLease;
        try {
          lease = await executions.begin(
            {
              id: `${batchId}:${lane.id}`,
              source: maintenance ? "maintenance" : "daily",
              resources: [mumuResource(lane.managerPath, lane.instance)],
              laneId: lane.id,
              batchId,
              snapshot: {
                appVersion,
                ...frozen,
                ...(gameSlot
                  ? { gameSlot: { laneId: lane.id, gameId: gameSlot.gameId } }
                  : {}),
                ...(occurrence
                  ? {
                      schedule: {
                        origin: "scheduler",
                        slot: occurrence.slot,
                        dueAt: occurrence.dueAt.toISOString(),
                        ...(automationJob
                          ? {
                              jobId: automationJob.id,
                              name: automationJob.name,
                            }
                          : {}),
                      },
                    }
                  : {}),
              },
            },
            admission.signal,
          );
        } catch (error) {
          if (lanePreparations.get(lane.id) === admission)
            lanePreparations.delete(lane.id);
          releaseSlot();
          throw error;
        }
        const job = (async () => {
          try {
            admission.signal.throwIfAborted();
            cycleSignal?.throwIfAborted();
            if (cancelledLaneCycles.has(lane.id) && cycleSignal)
              throw new DOMException("已停止此设备计划", "AbortError");
            lanePreparations.delete(lane.id);
            const result = await laneRuntime!.run(
              lane,
              (_selected, laneWorker, signal) =>
                executeDeviceLane(
                  frozen,
                  laneWorker,
                  batchId,
                  signal,
                  lease,
                  maintenance,
                  scheduleScope,
                  false,
                  // A game-only subset cannot complete a mixed predecessor;
                  // a V2 channel owns exactly this full saved game plan.
                  !!occurrence || !!automationJob || !completesWholeChannel,
                ),
              batchId,
              maintenance,
              slotRun?.controller.signal ?? cycleSignal,
            );
            return result;
          } catch (error) {
            await lease.finish(
              error instanceof Error && error.name === "AbortError"
                ? "cancelled"
                : "unknown",
              String(error),
            );
            throw error;
          } finally {
            if (lanePreparations.get(lane.id) === admission)
              lanePreparations.delete(lane.id);
            releaseSlot();
          }
        })();
        laneJobs.set(lane.id, job);
        void job
          .finally(() => {
            if (laneJobs.get(lane.id) === job) laneJobs.delete(lane.id);
          })
          .catch(() => {});
        return { job };
      };
      const automationResource = async (
        job: { laneId: string },
        gameId: "arknights" | "onmyoji",
      ) => {
        const lane = (await deviceLanes.read()).lanes.find(
          (item) => item.id === job.laneId,
        );
        if (!lane) throw Error("计划绑定的账号不存在");
        const selected = freezeLaneDevice(lane, [gameId]);
        return mumuResource(selected.managerPath, selected.instance);
      };
      const automationEligible = async (
        job: { laneId: string },
        gameId: "arknights" | "onmyoji",
      ) => {
        const lane = (await deviceLanes.read()).lanes.find(
          (item) => item.id === job.laneId,
        );
        if (
          !lane?.enabled ||
          !lane[gameId].enabled ||
          laneRuntime?.isRunning(lane.id) ||
          laneJobs.has(lane.id) ||
          lanePreparations.has(lane.id)
        )
          return false;
        if (
          gameId === "arknights" &&
          !(await arknights.read()).profiles.some(
            (profile) => profile.id === lane.arknights.profileId,
          )
        )
          return false;
        return executions.canStart([await automationResource(job, gameId)]);
      };
      arknightsAutomation = new ArknightsAutomationService({
        store: new ArknightsAutomationStore(
          join(dataDir, "arknights-automation.json"),
          defaultArknightsAutomation((await deviceLanes.read()).lanes),
        ),
        isBusy: () =>
          quitting ||
          starting ||
          connecting ||
          finishing ||
          (configuring && !configuringGamePlans) ||
          startupInspectionRunning ||
          !!history.active ||
          !!context ||
          !!chatCommands?.busy,
        onError: (error) => console.error("方舟计划结果落盘失败", error),
        canRunJob: (job) => automationEligible(job, "arknights"),
        resourceKey: (job) => automationResource(job, "arknights"),
        run: createArknightsAutomationRun({
          readLanes: async () => (await deviceLanes.read()).lanes,
          launchLane,
          readExecution: (id) => executions.get(id),
          isPreview: () => smoke || plannerPreview,
        }),
      });
      onmyojiAutomation = new OnmyojiAutomationService({
        store: new OnmyojiAutomationStore(
          join(dataDir, "onmyoji-automation.json"),
          defaultOnmyojiAutomation((await deviceLanes.read()).lanes),
        ),
        isBusy: () =>
          quitting ||
          starting ||
          connecting ||
          finishing ||
          (configuring && !configuringGamePlans) ||
          startupInspectionRunning ||
          !!history.active ||
          !!context ||
          !!chatCommands?.busy,
        onError: (error) => console.error("阴阳师计划结果落盘失败", error),
        canRunJob: (job) => automationEligible(job, "onmyoji"),
        resourceKey: (job) => automationResource(job, "onmyoji"),
        run: createAutomationRun<
          import("../../../packages/protocol/onmyoji-automation").OnmyojiAutomationSkill
        >(
          {
            readLanes: async () => (await deviceLanes.read()).lanes,
            launchLane,
            readExecution: (id) => executions.get(id),
            isPreview: () => smoke || plannerPreview,
          },
          "onmyoji",
        ),
      });
      registerGameAutomationIpc({
        prefix: "onmyoji",
        register: handle,
        service: onmyojiAutomation,
        validate: validateOnmyojiAutomation,
        validateJob: async (job) => {
          const lane = (await deviceLanes.read()).lanes.find(
            (item) => item.id === job.laneId,
          );
          if (!lane?.onmyoji.enabled) throw Error("计划绑定的阴阳师账号不存在");
          if (job.enabled)
            freezeOnmyojiJob(
              { ...lane, enabled: true },
              await arknights.read(),
              job,
            );
        },
        busy: () =>
          automaticReserved ||
          executions.active ||
          !!laneRuntime?.active ||
          configuring ||
          quitting ||
          starting ||
          connecting ||
          finishing ||
          startupInspectionRunning ||
          !!history.active ||
          !!context ||
          !!chatCommands?.busy,
        runBusy: () => automaticReserved || configuring || quitting,
        withConfiguring: async (action) => {
          configuring = true;
          configuringGamePlans = true;
          try {
            return await action();
          } finally {
            configuring = false;
            configuringGamePlans = false;
          }
        },
      });
      registerArknightsAutomationIpc({
        register: handle,
        dataDir,
        service: arknightsAutomation,
        activity: activityStageResolver,
        readLanes: async () => (await deviceLanes.read()).lanes,
        readProfiles: () => arknights.read(),
        busy: () =>
          automaticReserved ||
          executions.active ||
          !!laneRuntime?.active ||
          configuring ||
          quitting ||
          starting ||
          connecting ||
          finishing ||
          startupInspectionRunning ||
          !!history.active ||
          !!context ||
          !!chatCommands?.busy,
        runBusy: () => automaticReserved || configuring || quitting,
        withConfiguring: async (action, purpose) => {
          configuring = true;
          configuringGamePlans = purpose === "plans";
          try {
            return await action();
          } finally {
            configuring = false;
            configuringGamePlans = false;
          }
        },
        chooseMaaFile: async () => {
          const choice = await dialog.showOpenDialog(window!, {
            title: "导入 MAA 配置",
            properties: ["openFile"],
            filters: [{ name: "MAA JSON 配置", extensions: ["json"] }],
          });
          return !choice.canceled && choice.filePaths.length === 1
            ? choice.filePaths[0]
            : undefined;
        },
      });
      handle("gp:game-slot-start", async (input) => {
        const value = agentObject(input, ["laneId", "gameId", "requestId"]);
        if (
          typeof value.laneId !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.laneId)
        )
          throw new Error("账号渠道编号无效");
        if (value.gameId !== "arknights" && value.gameId !== "onmyoji")
          throw new Error("游戏槽位范围无效");
        if (automaticReserved)
          throw new Error("自动计划正在执行，请等待完成或停止全部任务");
        const batchId =
          value.requestId === undefined
            ? randomUUID()
            : validateRequestId(value.requestId);
        const lane = (await deviceLanes.read()).lanes.find(
          (item) => item.id === value.laneId,
        );
        if (!lane) throw new Error("账号渠道不存在");
        const frozenDevice = freezeLaneDevice(lane, [value.gameId]);
        try {
          await launchLane(
            lane,
            batchId,
            false,
            undefined,
            undefined,
            value.gameId,
            { laneId: lane.id, gameId: value.gameId },
          );
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError")
            throw new Error(
              `槽位「${lane.name}」的运行被中止（可能点了停止，或执行前检查未通过）；请确认模拟器实例 ${frozenDevice.instance} 正常后再试`,
            );
          throw error;
        }
        return { batchId };
      });
      handle("gp:game-slot-stop", async (input) => {
        const value = agentObject(input, ["laneId", "gameId"]);
        if (
          typeof value.laneId !== "string" ||
          (value.gameId !== "arknights" && value.gameId !== "onmyoji")
        )
          throw new Error("游戏槽位停止范围无效");
        const owner = gameSlotRuns.get(value.laneId);
        if (!owner || owner.gameId !== value.gameId)
          throw new Error(
            "没有此游戏槽位的活动请求归属；原账号计划请使用对应停止入口",
          );
        const record = executions.get(`${owner.batchId}:${value.laneId}`);
        const scope = record.snapshot.gameSlot as
          import("../../../packages/protocol").GameSlotTarget | undefined;
        const plan = record.snapshot[`${value.gameId}Plan`] as Plan | undefined;
        const otherPlan =
          record.snapshot[
            value.gameId === "arknights" ? "onmyojiPlan" : "arknightsPlan"
          ];
        if (
          record.laneId !== value.laneId ||
          record.batchId !== owner.batchId ||
          scope?.laneId !== value.laneId ||
          scope.gameId !== value.gameId ||
          plan?.gameId !== value.gameId ||
          otherPlan !== undefined ||
          record.snapshot.plan !== undefined
        )
          throw new Error("游戏槽位停止范围与原请求归属不一致");
        if (record.status !== "running") return null;
        // Abort this admission/runtime signal before awaiting persistence or IPC.
        // Never use stopLanes here: it cancels unrelated chat, goal and cycle work.
        owner.controller.abort();
        const stopping = laneRuntime!.isRunningBatch(
          value.laneId,
          owner.batchId,
        )
          ? laneRuntime!.stop(value.laneId)
          : Promise.resolve();
        // A failed transport must surface promptly so it can be retried; the
        // ownership and lease remain until the actual engine job settles.
        await stopping;
        await owner.done;
        return null;
      });
      handle("gp:lane-start", async (input) => {
        if (automaticReserved)
          throw new Error("自动计划正在执行，请等待完成或停止全部任务");
        const value =
          typeof input === "string"
            ? { laneId: input }
            : (input as { laneId?: unknown; requestId?: unknown } | null);
        if (!value || typeof value.laneId !== "string")
          throw new Error("设备槽位编号无效");
        const batchId =
          value.requestId === undefined
            ? randomUUID()
            : validateRequestId(value.requestId);
        const lane = (await deviceLanes.read()).lanes.find(
          (item) => item.id === value.laneId,
        );
        if (!lane) throw new Error("设备槽位不存在");
        await launchLane(lane, batchId);
        return { batchId };
      });
      handle("gp:lanes-start", async (input) => {
        const batchId =
          input === undefined ? randomUUID() : validateRequestId(input);
        if (automaticReserved)
          throw new Error("自动计划正在执行，请等待完成或停止全部任务");
        const lanes = (await deviceLanes.read()).lanes.filter(
          (lane) => lane.enabled,
        );
        if (!lanes.length) throw new Error("请先启用至少一个设备账号");
        await Promise.all(lanes.map(assertLaneCanStart));
        return launchIndependentLanes(lanes, batchId, launchLane);
      });
      const stopLanes = async (ids?: string[]) => {
        arknightsAutomation?.cancelActive(ids);
        onmyojiAutomation?.cancelActive(ids);
        chatCommands?.cancelPending();
        const selected = ids ?? [
          ...new Set([
            ...laneJobs.keys(),
            ...lanePreparations.keys(),
            ...automaticLaneIds,
          ]),
        ];
        for (const id of selected) {
          cancelledLaneCycles.add(id);
          lanePreparations.get(id)?.abort();
        }
        if (!ids) automaticCycle?.abort();
        // Send device cancellation before waiting for any diagnosis or ledger persistence.
        const stopping = Promise.allSettled(
          selected.map((id) => laneRuntime!.stop(id)),
        );
        const goalStopping = Promise.allSettled(
          (goals?.snapshot().goals ?? [])
            .filter(
              (g) =>
                [
                  "preparing",
                  "running",
                  "waiting",
                  "recovering",
                  "cancelling",
                ].includes(g.status) &&
                (!ids || g.grant.scopes.some((s) => ids.includes(s.laneId))),
            )
            .map((g) => goals!.cancel(g.id, { sessionId: g.sessionId })),
        );
        const agentStopping =
          !ids && agentExecution?.active
            ? agentExecution.cancel(agentExecution.snapshot().requestId)
            : Promise.resolve();
        const incidentStopping: Promise<unknown>[] = [];
        for (const s of incidentAgent?.snapshot().sessions ?? []) {
          if (
            !ids ||
            ids.includes(
              executions.snapshot().find((r) => r.id === s.requestId)?.laneId ??
                "",
            )
          )
            if (["queued", "running"].includes(s.status))
              incidentStopping.push(
                incidentAgent!.cancel(s.requestId).catch(() => {}),
              );
        }
        await deferMaintenance(selected).catch((error) =>
          console.error("寄养延后记录未保存", error),
        );
        const results = await stopping;
        await goalStopping;
        await agentStopping;
        await Promise.allSettled(incidentStopping);
        await Promise.allSettled(
          selected.flatMap((id) =>
            laneJobs.has(id) ? [laneJobs.get(id)!] : [],
          ),
        );
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      };
      handle("gp:lane-stop", async (input) => {
        if (typeof input !== "string") throw new Error("设备槽位编号无效");
        await stopLanes([input]);
        return null;
      });
      handle("gp:lanes-stop", async () => {
        await stopLanes();
        return null;
      });
      const launchFrozen = async (
        snapshots: LaneExecutionSnapshot[],
        batchId: string,
        signal: AbortSignal,
        identity: FrozenIdentity,
      ) => {
        runLedger.assertHealthy();
        executions.assertHealthy();
        if (
          snapshots.some(
            (s) => laneJobs.has(s.lane.id) || laneRuntime!.isRunning(s.lane.id),
          )
        )
          throw new Error("目标账号正在执行任务");
        const startupInspection =
          identity.kind === "custom" &&
          snapshots.length &&
          snapshots.every(pureArknightsLogin)
            ? await prepareStartupInspection(
                snapshots.map((s) =>
                  mumuResource(s.lane.managerPath, s.lane.instance),
                ),
                signal,
              )
            : undefined;
        return withTrackedAdmission(
          snapshots,
          signal,
          lanePreparations,
          (admissionSignal) =>
            launchAgentBatch(snapshots, batchId, admissionSignal, {
              admit: (frozen, id, admissionSignal) =>
                executions.begin(
                  {
                    id: `${id}:${frozen.lane.id}`,
                    source: frozenAdmissionPolicy(identity, frozen).source,
                    batchId: id,
                    laneId: frozen.lane.id,
                    resources: [
                      mumuResource(
                        frozen.lane.managerPath,
                        frozen.lane.instance,
                      ),
                    ],
                    snapshot: {
                      appVersion,
                      ...frozen,
                      ...(startupInspection ? { startupInspection } : {}),
                      ...(identity.daily
                        ? {
                            schedule: {
                              origin: "agent",
                              slot: identity.daily.slot,
                              dueAt: frozen.startedAt,
                              scope: frozenAdmissionPolicy(identity, frozen)
                                .scope,
                            },
                          }
                        : {}),
                      agent: {
                        ...identity,
                      },
                    },
                  },
                  admissionSignal,
                ),
              run: async (frozen, lease, id, batchSignal) => {
                const lane = frozen.lane;
                const job = laneRuntime!.run(
                  lane,
                  (_selected, laneWorker, laneSignal) => {
                    return executeDeviceLane(
                      frozen,
                      laneWorker,
                      id,
                      laneSignal,
                      lease,
                      false,
                      frozenAdmissionPolicy(identity, frozen).scope,
                      frozenAdmissionPolicy(identity, frozen).custom,
                      false,
                      false,
                      frozenAdmissionPolicy(identity, frozen).slot,
                    );
                  },
                  id,
                  false,
                  batchSignal,
                );
                laneJobs.set(lane.id, job);
                try {
                  const result = await job;
                  if (startupInspection) {
                    await runLedger.flush();
                    const facts = await recordStartupReconciliations(
                      startupFacts,
                      startupInspection,
                      `${id}:${lane.id}`,
                      executions.snapshot(Number.MAX_SAFE_INTEGER),
                      runLedger.snapshot(Number.MAX_SAFE_INTEGER),
                      new Date(),
                    );
                    if (facts.length)
                      await recordAgent({
                        requestId: identity.requestId,
                        kind: "recovery",
                        status: "succeeded",
                        text: `账号登录与 UID 核验通过，已为 ${facts.length} 条旧启动记录保存独立对账事实；旧失败结果保留。`,
                      });
                  }
                  return result;
                } finally {
                  if (laneJobs.get(lane.id) === job) laneJobs.delete(lane.id);
                }
              },
            }),
        );
      };
      agentExecution = new AgentExecutionService({
        validate: async (target) => {
          await agentJournal!.assertReady();
          if (executions.hasUnconfirmedExit())
            throw new Error("故障执行器退出尚未确认，请先核对设备");
          if (smoke)
            throw new AgentToolError(
              "PREVIEW_READONLY",
              "开发预览只读，不能确认真实游戏任务",
            );
          runLedger.assertHealthy();
          executions.assertHealthy();
          const state = await planner.verifiedSnapshot();
          if (
            state.requestId !== target.requestId ||
            state.result?.draft?.planHash !== target.planHash
          )
            throw new AgentToolError(
              "DRAFT_CHANGED",
              "当前草稿已变化或失效，请重新规划",
            );
          const source = state.source === "recorded";
          const configured = await readConfiguredSnapshot(dataDir, {
            history: source,
          });
          const lanes = await deviceLanes.read();
          const profiles = await arknights.read();
          const after = await readConfiguredSnapshot(dataDir, {
            history: source,
          });
          const verified = await planner.verifiedSnapshot();
          if (
            configured.fingerprint !== after.fingerprint ||
            verified.status !== "completed" ||
            verified.requestId !== target.requestId
          )
            throw new AgentToolError(
              "CONFIGURATION_CHANGED",
              "账号或草稿已变化，请重新规划",
            );
          const requests = executions.snapshot(Number.MAX_SAFE_INTEGER);
          const tasks = runLedger.snapshot(Number.MAX_SAFE_INTEGER);
          const snapshots = prepareAgentExecution(
            verified,
            {
              configured,
              lanes,
              profiles,
              requests,
              tasks,
              startupFacts: readStartupFacts(),
            },
            new Date(),
          );
          const model = await modelProvider.read();
          return {
            snapshots,
            fingerprint: createHash("sha256")
              .update(
                canonical({
                  target,
                  configuration: configured.fingerprint,
                  model: model.revision,
                  requests,
                  tasks,
                  snapshots: snapshots.map(
                    ({ startedAt: _time, ...snapshot }) => snapshot,
                  ),
                }),
              )
              .digest("hex"),
          };
        },
        launch: (snapshots, batchId, signal) =>
          launchFrozen(snapshots, batchId, signal, {
            requestId: agentExecution!.snapshot().requestId!,
            planHash: agentExecution!.snapshot().planHash,
          }),
        stop: async (ids, batchId) => {
          const owned = ids.filter((id) =>
            laneRuntime!.isRunningBatch(id, batchId),
          );
          for (const id of owned) lanePreparations.get(id)?.abort();
          const stopped = await Promise.allSettled(
            owned.map((id) => laneRuntime!.stop(id)),
          );
          if (stopped.some((s) => s.status === "rejected"))
            throw new Error("停止请求未完全送达，请检查账号运行状态");
        },
      });
      handle("gp:agent-execution-snapshot", () => agentExecution!.snapshot());
      const copilotServices = new Map<
        string,
        CopilotService<{ batchId: string; requestId: string; laneId: string }>
      >();
      const copilotPreparations = new Map<
        string,
        CopilotService<{ batchId: string; requestId: string; laneId: string }>
      >();
      const copilotOwners = new Map<
        string,
        {
          principal: import("../../../packages/protocol/agent-runtime").AgentRuntimePrincipal;
          requestId: string;
        }
      >();
      const assertCopilotConfirmationOwner = async (preparedId: string) => {
        const owner = copilotOwners.get(preparedId);
        if (!owner) return;
        const state = await chat!.snapshot(),
          turn = state.sessions
            .find((s) => s.id === owner.principal.sessionId)
            ?.turns.at(-1),
          live = planner.snapshot();
        if (
          state.selectedSessionId !== owner.principal.sessionId ||
          turn?.id !== owner.principal.turnId ||
          turn.prompt !== owner.principal.prompt ||
          turn.planner.requestId !== owner.requestId ||
          turn.planner.status !== "completed" ||
          live.requestId !== owner.requestId ||
          live.status !== "completed" ||
          turn.planner.result?.copilot?.preparedId !== preparedId
        )
          throw Error("作业准备所属会话或指令已变化，请重新发送需求并确认");
      };
      const readCopilotConfiguration = async () => {
        const [lanes, profiles] = await Promise.all([
          deviceLanes.read(),
          arknights.read(),
        ]);
        return {
          lanes,
          profiles,
          revision: copilotConfigurationRevision(
            lanes,
            profiles,
            engineContract,
          ),
        };
      };
      const resolveStage = async (code: string) => {
        const resource = join(
          __dirname,
          `../resources/maa-${engineContract.version}/resource`,
        );
        const [stages, tiles] = await Promise.all([
          boundedRead(join(resource, "stages.json"), 16 * 1024 * 1024),
          boundedRead(
            join(resource, "Arknights-Tile-Pos/overview.json"),
            32 * 1024 * 1024,
          ),
        ]);
        return resolveCopilotStage(JSON.parse(stages), JSON.parse(tiles), code);
      };
      const createCopilotService = (cacheDir: string) =>
        new CopilotService({
          cacheDir,
          resolveStage,
          revision: async () => (await readCopilotConfiguration()).revision,
          account: async (profileId: string) => {
            const c = await readCopilotConfiguration(),
              { profile } = copilotBinding(c.lanes, c.profiles, profileId);
            return {
              profileId,
              expectedUid: profile.expectedUid,
              clientType: profile.clientType,
              revision: c.revision,
            };
          },
          execute: async (prepared) => {
            if (smoke || plannerPreview) throw Error("预览不能执行真实作业");
            if (
              starting ||
              connecting ||
              finishing ||
              configuring ||
              automaticReserved ||
              startupInspectionRunning ||
              context ||
              modelOperation ||
              chat?.busy ||
              plannerActive(planner.snapshot())
            )
              throw Error("任务或配置操作正在进行，请结束后重新准备");
            await assertCopilotConfirmationOwner(prepared.preparedId);
            const c = await readCopilotConfiguration();
            const frozen = freezeCopilotExecution(
              prepared,
              c.lanes,
              c.profiles,
              engineContract,
              executions.snapshot(Number.MAX_SAFE_INTEGER),
              runLedger.snapshot(Number.MAX_SAFE_INTEGER),
            );
            await assertLaneCanStart(frozen.lane);
            if (
              starting ||
              connecting ||
              finishing ||
              configuring ||
              automaticReserved ||
              startupInspectionRunning ||
              context ||
              modelOperation ||
              chat?.busy ||
              plannerActive(planner.snapshot())
            )
              throw Error("受理前任务或配置操作已变化，请重新准备");
            // Configuration writes are guarded during durable admission, before any device work.
            starting = true;
            try {
              if (
                (await readCopilotConfiguration()).revision !==
                prepared.revision
              )
                throw Error("受理前配置已变化，请重新准备作业");
              const batchId = `copilot-${prepared.preparedId}`,
                controller = new AbortController();
              const { jobs } = await launchFrozen(
                [frozen],
                batchId,
                controller.signal,
                {
                  kind: "custom",
                  requestId: prepared.preparedId,
                  planHash: prepared.planHash,
                },
              );
              for (const { job } of jobs)
                void job.catch((error) =>
                  console.error("临时作业结果请核对原记录", String(error)),
                );
              return {
                batchId,
                requestId: `${batchId}:${frozen.lane.id}`,
                laneId: frozen.lane.id,
              };
            } finally {
              starting = false;
            }
          },
        });
      const copilotSearch = createCopilotService(dataDir);
      handle("gp:copilot-search", (input) => copilotSearch.search(input));
      const prepareCopilot = async (input: unknown, signal?: AbortSignal) => {
        const request = validateCopilotPreparation(input),
          c = await readCopilotConfiguration(),
          { lane } = copilotBinding(c.lanes, c.profiles, request.profileId);
        if (copilotPreparations.size >= 256)
          throw Error("准备记录已达上限，请重启应用重新准备");
        let service = copilotServices.get(lane.id);
        if (!service) {
          service = createCopilotService(join(dataDir, "lanes", lane.id));
          copilotServices.set(lane.id, service);
        }
        const prepared = await service.prepare(request, signal);
        copilotPreparations.set(prepared.preparedId, service);
        return prepared;
      };
      handle("gp:copilot-prepare", (input) => prepareCopilot(input));
      copilotToolBinding = (binding, principal, requestId, snapshot) =>
        withCopilotReadTools(binding, {
          assertCurrent: async () => {
            if (snapshot.source === "fixture")
              throw Error("演练不能读取或准备真实作业");
            await assertGoalMessage(principal, requestId);
          },
          search: (input, signal) => copilotSearch.search(input, signal),
          prepare: async (input, signal) => {
            const configured = await readConfiguredSnapshot(dataDir),
              c = await readCopilotConfiguration();
            if (
              canonical({
                lanes: configured.snapshot.lanes,
                profiles: configured.snapshot.profiles,
              }) !==
              canonical({ lanes: snapshot.lanes, profiles: snapshot.profiles })
            )
              throw Error("本轮账号目录已变化，请重新查询");
            const index = configured.snapshot.lanes!.lanes.findIndex(
                (l) => l.id === input.laneId,
              ),
              lane = c.lanes.lanes[index];
            if (index < 0 || !lane) throw Error("作业账号槽位不存在");
            const plan = await prepareCopilot(
              {
                profileId: lane.arknights.profileId,
                stage: input.stage,
                count: input.count,
                skipStory: true,
              },
              signal,
            );
            copilotOwners.set(plan.preparedId, {
              principal: structuredClone(principal),
              requestId,
            });
            return copilotReviewFromPlan(plan, `槽位 ${index + 1}`);
          },
        });
      handle("gp:copilot-confirm", async (input) => {
        const request = validateCopilotConfirmation(input),
          service = copilotPreparations.get(request.preparedId);
        if (!service) throw Error("临时作业准备记录不存在，请重新准备");
        await assertCopilotConfirmationOwner(request.preparedId);
        return service.confirm(request);
      });
      handle("gp:copilot-cancel", async (input) => {
        const value = agentObject(input, ["batchId", "requestId", "laneId"]),
          batchId = validateRequestId(value.batchId),
          requestId = validateRequestId(value.requestId),
          laneId = validateRequestId(value.laneId);
        if (
          Object.keys(value).some(
            (k) => !["batchId", "requestId", "laneId"].includes(k),
          )
        )
          throw Error("作业停止范围无效");
        const record = executions.get(requestId);
        if (
          record.batchId !== batchId ||
          record.laneId !== laneId ||
          !record.snapshot.copilot
        )
          throw Error("作业停止范围与执行记录不一致");
        if (
          record.status !== "running" ||
          !laneRuntime!.isRunningBatch(laneId, batchId)
        )
          return {
            stopped: false,
            message: "本次作业已结束，未停止其他任务。",
          };
        lanePreparations.get(laneId)?.abort();
        await laneRuntime!.stop(laneId);
        const job = laneJobs.get(laneId);
        if (job) await Promise.allSettled([job]);
        return {
          stopped: true,
          message: "本次作业停止已送达，请核对原执行记录。",
        };
      });
      handle("gp:agent-execution-review", (input) =>
        agentExecution!.review(input),
      );
      handle("gp:agent-execution-confirm", async (input) => {
        if (smoke) throw new Error("开发预览不能执行真实游戏任务");
        const previous = agentExecution!.existingConfirmation(input);
        if (previous) return previous;
        if (
          starting ||
          connecting ||
          finishing ||
          configuring ||
          automaticReserved ||
          startupInspectionRunning ||
          context ||
          modelOperation ||
          chat?.busy ||
          plannerActive(planner.snapshot())
        )
          throw new Error("任务或配置操作正在进行，请结束后重新检查");
        starting = true;
        try {
          return await agentExecution!.confirm(input);
        } finally {
          starting = false;
        }
      });
      handle("gp:agent-execution-cancel", (id) => agentExecution!.cancel(id));
      const stop = async () => {
        const wasPreparing = !!preparing;
        preparing?.abort();
        const done = context?.done;
        const legacyStop = wasPreparing
          ? Promise.resolve()
          : worker.request(
              "stop",
              undefined,
              context?.plan.gameId === "arknights" ? 70000 : 8000,
            );
        const results = await Promise.allSettled([stopLanes(), legacyStop]);
        await done;
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      };
      handle("gp:stop", stop);
      const validateChatSession = async (id: string) => {
        const state = await chat!.snapshot();
        const session = state.sessions.find((s) => s.id === id);
        if (!session || state.selectedSessionId !== id)
          throw new Error(
            "请在当前选中的会话发送指令；旧会话或归档不能影响新任务",
          );
        return `${session.id}:${session.turns.at(-1)?.id ?? "empty"}`;
      };
      const assertControlOwner = (sessionId: string, requestId: string) => {
        const request = executions.get(requestId);
        const origin = (
          request.snapshot.agent as { requestId?: string } | undefined
        )?.requestId;
        const owner =
          executionChatOwners.get(requestId) ??
          (origin
            ? (commandChatOwners.get(origin) ??
              chat?.requestTarget(origin)?.sessionId)
            : undefined);
        if (owner && owner !== sessionId)
          throw new Error(
            "此任务属于另一条会话，请切回原会话再控制；紧急停止全部任务仍可使用",
          );
      };
      const commandFile = join(dataDir, "agent-commands.json");
      let chatIntents: ChatIntentReviewService;
      const commandHost: ConstructorParameters<typeof ChatCommandService>[0] = {
        validateSession: validateChatSession,
        validateOrigin: (view) => chatIntents.assertCurrent(view),
        load: async () => {
          try {
            return JSON.parse(await boundedRead(commandFile, 8 * 1024 * 1024));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              return undefined;
            throw error;
          }
        },
        save: async (store) => {
          await writeFile(commandFile + ".tmp", JSON.stringify(store), "utf8");
          await replaceFile(commandFile + ".tmp", commandFile, {
            atomicOnly: true,
          });
          for (const view of store.entries) {
            commandChatOwners.set(view.reviewId, view.sessionId);
            view.receipt?.requestIds.forEach((id) =>
              executionChatOwners.set(id, view.sessionId),
            );
          }
        },
        record: async (view) => {
          await recordAgent({
            requestId: view.reviewId,
            sessionId: view.sessionId,
            ...(view.origin
              ? {
                  parentRequestId: view.origin.plannerRequestId,
                  turnId: view.origin.turnId,
                }
              : {}),
            kind: "command",
            status:
              view.status === "review"
                ? "running"
                : view.status === "submitted"
                  ? "succeeded"
                  : view.status === "blocked"
                    ? "blocked"
                    : "unknown",
            text:
              view.status === "review"
                ? "已保存日常指令检查，等待本轮确认"
                : view.message!,
          });
        },
        prepare: async (command) => {
          await agentJournal!.assertReady();
          runLedger.assertHealthy();
          executions.assertHealthy();
          if (command.kind === "continue") {
            assertControlOwner(
              command.sessionId,
              validateRequestId(command.parentId),
            );
            const preview = await continuationService.preview(
              validateRequestId(command.parentId),
            );
            if (
              !preview.canContinue ||
              preview.reasons.length ||
              preview.successorId
            )
              throw new Error(
                preview.reasons.join("；") ||
                  "原请求不能再次续跑，请查看精确回执",
              );
            const input = {
              parentId: preview.parentId,
              fingerprint: preview.fingerprint,
              selections: preview.defaults,
              acknowledgePartial: false,
            };
            return {
              fingerprint: preview.fingerprint,
              needsAcknowledgement: preview.needsAcknowledgement,
              summary: [
                {
                  laneName: preview.laneName,
                  games: preview.defaults.map((selection) => ({
                    gameId: selection.gameId,
                    title:
                      games.find((g) => g.id === selection.gameId)?.name ??
                      selection.gameId,
                    steps: selection.skillIds.map(
                      (skillId) =>
                        games
                          .find((g) => g.id === selection.gameId)
                          ?.skills.find((s) => s.id === skillId)?.title ??
                        skillId,
                    ),
                  })),
                },
              ],
              payload: input,
            };
          }
          const before = await readConfiguredSnapshot(dataDir, {
            history: false,
          });
          const lanes = (await deviceLanes.read()).lanes.filter(
            (lane) => lane.enabled,
          );
          const profiles = await arknights.read();
          validateLaneProfiles(lanes, profiles);
          if (!lanes.length) throw new Error("请先启用设备账号");
          const now = new Date();
          const slot =
            command.text === "运行双游戏日常"
              ? "primary"
              : now.getHours() >= 20
                ? "secondary"
                : "primary";
          const snapshots = lanes.map((lane) =>
            freezeLaneExecution(lane, profiles, false, now, slot),
          );
          const requests = executions.snapshot(Number.MAX_SAFE_INTEGER);
          const commandContext = {
            configured: before,
            lanes: { version: 1 as const, lanes },
            profiles,
            requests,
            tasks: runLedger.snapshot(Number.MAX_SAFE_INTEGER),
            startupFacts: readStartupFacts(),
          };
          for (const snapshot of snapshots) {
            await assertLaneCanStart(snapshot.lane);
            guardSavedDailyHistory(snapshot, commandContext, now, slot);
            if (snapshot.arknightsPlan && !snapshot.profile?.expectedUid)
              throw new Error("先绑定明日方舟账号 UID，再确认日常");
            const resource = mumuResource(
              snapshot.lane.managerPath,
              snapshot.lane.instance,
            );
            if (resource === "*") throw new Error("请先固定模拟器路径");
          }
          if (
            before.fingerprint !==
            (await readConfiguredSnapshot(dataDir, { history: false }))
              .fingerprint
          )
            throw new Error("配置变化，请重新检查");
          const summary = snapshots.map((snapshot) => ({
            laneName: snapshot.lane.name,
            games: [snapshot.arknightsPlan, snapshot.onmyojiPlan]
              .filter((plan): plan is Plan => !!plan)
              .map((plan) => ({
                gameId: plan.gameId,
                title: games.find((g) => g.id === plan.gameId)!.name,
                steps: plan.skillIds.map((skillId) => {
                  const effects = compiledCapabilityEffects(
                    plan.gameId,
                    [skillId],
                    snapshot.profile ? { ...snapshot.profile } : {},
                  ).filter((effect) => effect.enabled);
                  const title = games
                    .find((g) => g.id === plan.gameId)!
                    .skills.find((s) => s.id === skillId)!.title;
                  return `${title}${skillId === "fight" && snapshot.profile ? `（${snapshot.profile.stage}）` : ""}：${effects.map((effect) => effect.label).join("；")}`.slice(
                    0,
                    200,
                  );
                }),
              })),
          }));
          const fingerprint = createHash("sha256")
            .update(
              canonical({
                configuration: before.fingerprint,
                day: [arknightsGameDay(now), gameDay(now)],
                slot,
                requests,
                snapshots: snapshots.map(
                  ({ startedAt: _at, ...snapshot }) => snapshot,
                ),
              }),
            )
            .digest("hex");
          return {
            fingerprint,
            summary,
            payload: {
              snapshots,
              slot,
              scopes: Object.fromEntries(
                lanes.map((lane) => [lane.id, dailyLaneScope(lane)]),
              ),
            },
          };
        },
        launch: async (prepared, view) => {
          if (
            smoke ||
            plannerPreview ||
            quitting ||
            modelOperation ||
            agentExecution?.active ||
            plannerActive(planner.snapshot())
          )
            throw new Error("当前不能受理新的设备任务");
          if (view.kind === "continue") {
            const receipt = await startContinuation(
              prepared.payload,
              undefined,
              { requestId: view.reviewId, kind: "continue" },
            );
            return {
              batchId: receipt.batchId,
              requestIds: [receipt.requestId],
            };
          }
          const { snapshots, slot, scopes } = prepared.payload as {
            snapshots: LaneExecutionSnapshot[];
            slot: import("./scheduler").DailySlot;
            scopes: Record<string, string>;
          };
          const result = await launchFrozen(
            snapshots,
            view.reviewId,
            new AbortController().signal,
            {
              requestId: view.reviewId,
              kind: "saved-daily",
              daily: { slot, scopes },
            },
          );
          for (const { job } of result.jobs) void job.catch(() => {});
          return {
            batchId: view.reviewId,
            requestIds: snapshots.map(
              (snapshot) => `${view.reviewId}:${snapshot.lane.id}`,
            ),
          };
        },
      };
      chatCommands = new ChatCommandService(commandHost);
      const goalOwnerForRequest = (id: string) =>
        goals
          ?.snapshot()
          .goals.find((g) =>
            g.attempts.some((a) => a.submission.requestIds.includes(id)),
          );
      const goalRecoveryPreparations = new Map<
        string,
        Awaited<ReturnType<IncidentContext["prepare"]>>
      >();
      const preparedContinuation = (
        goal: GoalRun,
        recovery: GoalRecoveryReference,
        p: Awaited<ReturnType<IncidentContext["prepare"]>>,
      ): PreparedGoal => {
        const scopes = goalContinuationScopes(p.preview, recovery.laneId);
        return {
          fingerprint: p.preview.fingerprint,
          summary: [
            {
              laneName: p.preview.laneName,
              games: scopes.map((selection) => ({
                gameId: selection.gameId,
                title:
                  games.find((g) => g.id === selection.gameId)?.name ??
                  selection.gameId,
                steps: selection.skillIds,
              })),
            },
          ],
          scopes,
          frozenPlan: {
            kind: "continuation",
            hash: p.preview.fingerprint,
            parentRequestId: recovery.requestId,
          },
          payload: {
            continuation: {
              parentId: recovery.requestId,
              fingerprint: p.preview.fingerprint,
              selections: p.preview.defaults,
              acknowledgePartial: true,
            },
            recovery: p.recovery,
            recoveryFingerprint: p.fingerprint,
          },
        };
      };
      const goalObserver = createGoalObserver({
        executions,
        ledger: runLedger,
        startupFacts: readStartupFacts,
        criteria: (goal) => goalOutcomeCriteriaForPrompt(goal.prompt),
        findRecovery: async ({ goal, candidateRequestIds }) => {
          if (goal.retryCount >= 2 || quitting || smoke || plannerPreview)
            return;
          const startup = await startupGoalRecovery.find(
            goal,
            candidateRequestIds,
          );
          if (startup) return startup;
          for (const id of candidateRequestIds) {
            try {
              const p = await incidentContext.prepare(
                id,
                new AbortController().signal,
              );
              if (
                p.manualReason ||
                !(p.automaticAllowed || p.recovery) ||
                !p.preview.canContinue ||
                p.preview.reasons.length ||
                p.preview.successorId ||
                !p.preview.defaults.length
              )
                continue;
              const request = executions.get(id);
              if (!request.laneId) continue;
              const remainingScopes = goalContinuationScopes(
                p.preview,
                request.laneId,
              );
              const first = remainingScopes[0];
              const ref: GoalRecoveryReference = {
                requestId: id,
                reference: `incident:${id}:${p.preview.fingerprint}`,
                laneId: request.laneId,
                gameId: first.gameId,
                skillIds: [...first.skillIds],
                resources: { medicine: 0, stone: 0, expiringMedicine: 0 },
                remainingScopes,
                safety: {
                  kind: p.recovery
                    ? "bounded-navigation"
                    : "native-not-submitted",
                  fingerprint: p.fingerprint,
                  observedAt: new Date().toISOString(),
                  nativeSubmission: p.recovery ? "known" : "not-submitted",
                  accountProof: "login-gate-before-effects",
                },
              };
              goalRecoveryPreparations.set(ref.reference, p);
              return ref;
            } catch {
              /* An unproven recovery stays stopped with its original evidence. */
            }
          }
        },
        prepareRecovery: async ({ goal }, ref) => {
          if (startupGoalRecovery.owns(goal, ref))
            return startupGoalRecovery.prepare(goal, ref);
          const p = await incidentContext.prepare(
            ref.requestId,
            new AbortController().signal,
          );
          const old = goalRecoveryPreparations.get(ref.reference);
          if (
            !old ||
            !(p.automaticAllowed || p.recovery) ||
            p.manualReason ||
            old.fingerprint !== p.fingerprint ||
            old.preview.fingerprint !== p.preview.fingerprint ||
            canonical(p.recovery ?? null) !== canonical(old.recovery ?? null) ||
            !p.preview.canContinue ||
            p.preview.reasons.length ||
            p.preview.successorId
          )
            throw new AgentToolError(
              "RECOVERY_CHANGED",
              "原设备、提交状态或剩余步骤已变化，不执行旧恢复",
            );
          return preparedContinuation(goal, ref, p);
        },
      });
      goals = new GoalService({
        ...agentGoalFiles(join(dataDir, "agent-goals.json")),
        prepare: (goal) => goalRuntime!.prepare(goal),
        observe: goalObserver.observe,
        recover: goalObserver.recover,
        submit: async (goal, prepared, signal) => {
          if (
            smoke ||
            plannerPreview ||
            quitting ||
            modelOperation ||
            executions.hasUnconfirmedExit()
          )
            throw new Error("当前不能受理真实游戏目标");
          const batchId = goal.submission!.batchId;
          const payload = prepared.payload as {
            snapshots?: LaneExecutionSnapshot[];
            slot?: import("./scheduler").DailySlot;
            scopes?: Record<string, string>;
            continuation?: import("../../../packages/protocol/continuation").ContinuationInput;
            recovery?: import("../../../packages/protocol/incident-agent").IncidentRecoveryAction;
          };
          if (payload.continuation) {
            if (payload.recovery) {
              await recordAgent({
                requestId: goal.id,
                sessionId: goal.sessionId,
                turnId: goal.turnId,
                kind: "recovery",
                status: "running",
                text: "恢复受理已保存：在原设备租约内复查双帧，仅返回已知主页，业务继续前重新核验 UID。",
              });
              await incidentContext.recover(
                payload.continuation.parentId,
                payload.recovery,
                signal!,
              );
              await recordAgent({
                requestId: goal.id,
                sessionId: goal.sessionId,
                turnId: goal.turnId,
                kind: "recovery",
                status: "succeeded",
                text: "原设备已确认返回主页，现提交原剩余步骤；返回动作不证明任务完成。",
              });
            }
            const receipt = await startContinuation(
              payload.continuation,
              signal,
              { requestId: goal.id, kind: "continue" },
              batchId,
            );
            executionChatOwners.set(receipt.requestId, goal.sessionId);
            return {
              batchId: receipt.batchId,
              requestIds: [receipt.requestId],
            };
          }
          const snapshots = payload.snapshots!;
          for (const s of snapshots) await assertLaneCanStart(s.lane);
          const result = await launchFrozen(snapshots, batchId, signal!, {
            requestId: goal.id,
            ...(goal.selection.kind === "saved-daily"
              ? {
                  kind: "saved-daily",
                  daily: { slot: payload.slot!, scopes: payload.scopes! },
                }
              : { kind: "custom", planHash: goal.selection.planHash }),
          });
          for (const { job } of result.jobs)
            void job
              .finally(() => startupGoalRecovery.settled(goals!, goal.id))
              .catch(() => {});
          for (const id of goal.submission!.requestIds)
            executionChatOwners.set(id, goal.sessionId);
          return { batchId, requestIds: goal.submission!.requestIds };
        },
        stop: async (goal) => {
          const ids = new Set(
            goal.attempts.flatMap((a) => a.submission.requestIds),
          );
          const stopJobs: Promise<unknown>[] = [];
          for (const id of ids)
            if (
              incidentAgent
                ?.snapshot()
                .sessions.some(
                  (s) =>
                    s.requestId === id &&
                    ["queued", "running", "awaiting-user"].includes(s.status),
                )
            ) {
              // Send cancellation immediately. Never await the diagnosis here: its
              // pending Goal recovery may itself be awaiting this stop receipt.
              void incidentAgent.cancel(id).catch(() => {});
            }
          for (const request of executions
            .snapshot(Number.MAX_SAFE_INTEGER)
            .filter((r) => ids.has(r.id) && r.status === "running")) {
            if (!request.laneId) continue;
            lanePreparations.get(request.laneId)?.abort();
            if (
              request.batchId &&
              laneRuntime!.isRunningBatch(request.laneId, request.batchId)
            )
              stopJobs.push(laneRuntime!.stop(request.laneId));
            if (laneJobs.has(request.laneId))
              stopJobs.push(laneJobs.get(request.laneId)!);
          }
          const stopped = await Promise.allSettled(stopJobs);
          const observation = await goalObserver.observe(goal);
          const actual = executions.snapshot(Number.MAX_SAFE_INTEGER);
          if (
            ids.size &&
            stopped.every((r) => r.status === "fulfilled") &&
            [...ids].every((id) => {
              const request = actual.find((r) => r.id === id);
              return (
                !!request &&
                request.status !== "running" &&
                !!request.laneId &&
                !!request.batchId &&
                !laneRuntime!.isRunningBatch(request.laneId, request.batchId) &&
                !lanePreparations.has(request.laneId) &&
                !executions.hasUnconfirmedExit(request.resources)
              );
            })
          )
            observation.stopVerification = {
              verified: true,
              requestIds: [...ids],
              observedAt: new Date().toISOString(),
              evidenceReference: `${goal.id}:all-accepted-workers-stopped`,
            };
          return observation;
        },
      });
      const assertGoalMessage = async (
        principal: import("../../../packages/protocol/agent-runtime").AgentRuntimePrincipal,
        requestId?: string,
      ) => {
        const view = await chat!.snapshot();
        const turn = view.sessions
          .find((s) => s.id === principal.sessionId)
          ?.turns.at(-1);
        if (
          quitting ||
          smoke ||
          plannerPreview ||
          !turn ||
          turn.id !== principal.turnId ||
          turn.prompt !== principal.prompt ||
          (requestId && turn.planner.requestId !== requestId) ||
          turn.planner.requestId !== planner.snapshot().requestId ||
          planner.snapshot().status !== "running"
        )
          throw new AgentToolError(
            "GOAL_MESSAGE_CHANGED",
            "当前会话消息或运行状态已变化，旧轮次不能操作游戏",
          );
      };
      const goalPreferences = new AgentGoalPreferencesService({
        assertCurrent: assertGoalMessage,
        readConfigured: () =>
          readConfiguredSnapshot(dataDir, {
            history: planner.snapshot().source === "recorded",
          }),
        readLanes: () => deviceLanes.read(),
        saveLanes: (value) => deviceLanes.save(value),
        readProfiles: () => arknights.read(),
        saveProfiles: (value) => arknights.save(value),
      });
      const goalInspection = createGoalInspection({
        executions,
        blocked: (request) =>
          starting ||
          connecting ||
          configuring ||
          finishing ||
          !!context ||
          quitting ||
          executions.hasUnconfirmedExit(request.resources) ||
          (!!request.laneId &&
            (lanePreparations.has(request.laneId) ||
              laneRuntime!.isRunning(request.laneId))),
        capture: (id, signal) => incidentNavigation(id, signal, false),
      });
      const prepareDailyContinuation = createDailyContinuationPreparation({
        read: async () => {
          await agentJournal!.assertReady();
          await runLedger.flush();
          runLedger.assertHealthy();
          executions.assertHealthy();
          const [lanes, profiles] = await Promise.all([
            deviceLanes.read(),
            arknights.read(),
          ]);
          return {
            requests: executions.snapshot(Number.MAX_SAFE_INTEGER),
            tasks: runLedger.snapshot(Number.MAX_SAFE_INTEGER),
            startupFacts: readStartupFacts(),
            lanes: lanes.lanes,
            profiles,
            goals: goals!.snapshot().goals,
          };
        },
        preview: (id) => continuationService.preview(id),
        assertOwner: assertControlOwner,
      });
      goalRuntime = createGoalRuntime({
        goals,
        accountLanes: async () => (await deviceLanes.read()).lanes,
        assertCurrent: assertGoalMessage,
        prepareContinuation: prepareDailyContinuation,
        prepareSaved: async (scope) => {
          const p = await commandHost.prepare({
            kind: "saved-daily",
            text: scope === "both" ? "运行双游戏日常" : "运行保存的日常",
            sessionId: "host-goal",
          });
          const snapshots = (
            p.payload as { snapshots: LaneExecutionSnapshot[] }
          ).snapshots;
          return {
            ...p,
            scopes: frozenGoalScopes(snapshots),
            frozenPlan: { kind: "saved-daily", hash: p.fingerprint },
          };
        },
        prepareDraft: async (draft, requestId) => {
          const configured = await readConfiguredSnapshot(dataDir, {
            history: planner.snapshot().source === "recorded",
          });
          const [lanes, profiles] = await Promise.all([
            deviceLanes.read(),
            arknights.read(),
          ]);
          const startupInspection =
            draft.lanes.length &&
            draft.lanes.every(
              (entry) =>
                entry.games.length === 1 &&
                entry.games[0].plan.gameId === "arknights" &&
                entry.games[0].plan.skillIds.length === 1 &&
                entry.games[0].plan.skillIds[0] === "login",
            )
              ? await prepareStartupInspection(
                  draft.lanes.map((entry) => {
                    const index = configured.snapshot.lanes!.lanes.findIndex(
                      (l) => l.id === entry.laneId,
                    );
                    const lane = lanes.lanes[index];
                    if (!lane) throw new Error("设备绑定已变化");
                    const deviceLane = freezeLaneDevice(lane, ["arknights"]);
                    return mumuResource(
                      deviceLane.managerPath,
                      deviceLane.instance,
                    );
                  }),
                  new AbortController().signal,
                )
              : undefined;
          const snapshots = prepareCompiledAgentExecution(
            draft,
            {
              configured,
              lanes,
              profiles,
              requests: executions.snapshot(Number.MAX_SAFE_INTEGER),
              tasks: runLedger.snapshot(Number.MAX_SAFE_INTEGER),
              startupInspection,
              startupFacts: readStartupFacts(),
            },
            new Date(),
          );
          for (const s of snapshots) await assertLaneCanStart(s.lane);
          if (
            configured.fingerprint !==
            (
              await readConfiguredSnapshot(dataDir, {
                history: planner.snapshot().source === "recorded",
              })
            ).fingerprint
          )
            throw new AgentToolError(
              "ENVIRONMENT_CHANGED",
              "冻结期间配置或记录已变化",
            );
          return {
            fingerprint: draft.planHash!,
            frozenPlan: {
              kind: "custom",
              hash: draft.planHash!,
              plannerRequestId: requestId,
            },
            scopes: frozenGoalScopes(snapshots),
            summary: snapshots.map((s) => ({
              laneName: s.lane.name,
              games: [s.arknightsPlan, s.onmyojiPlan]
                .filter((p) => !!p)
                .map((p) => ({
                  gameId: p!.gameId,
                  title: games.find((g) => g.id === p!.gameId)!.name,
                  steps: p!.skillIds,
                })),
            })),
            payload: { snapshots },
          };
        },
        validateRequested: async (principal, prepared) => {
          const lanes = (await deviceLanes.read()).lanes;
          const profiles = await arknights.read();
          assertAgentExecutionAccounts(
            principal.prompt,
            [...new Set(prepared.scopes.map((scope) => scope.laneId))],
            lanes,
            profiles,
          );
        },
        inspect: goalInspection.inspect,
        preferences: (input, principal) => {
          if (
            configuring ||
            laneJobs.size ||
            lanePreparations.size ||
            automaticReserved ||
            startupInspectionRunning ||
            starting ||
            connecting
          )
            throw new AgentToolError(
              "CONFIGURATION_BUSY",
              "正在执行或配置设备，暂不能保存新日常偏好",
            );
          return goalPreferences.save(input, principal);
        },
      });
      await goals.ready();
      // Reconcile restored receipts before publishing goals. This observes prior
      // admissions; it never submits a previously prepared or accepted plan.
      await goals.reconcile();
      goals.subscribe((view) => {
        sendObservation("gp:goal-state", view);
        for (const goal of view.goals)
          for (const attempt of goal.attempts)
            for (const id of attempt.submission.requestIds)
              executionChatOwners.set(id, goal.sessionId);
      });
      handle("gp:goal-snapshot", async (id) => {
        if (id !== undefined) await validateChatSession(id as string);
        await goals!.ready();
        return goals!.snapshot(id as string | undefined);
      });
      handle("gp:goal-cancel", async (input) => {
        const v = agentObject(input, ["goalId", "sessionId"]);
        await validateChatSession(v.sessionId as string);
        return goals!.cancel(validateRequestId(v.goalId), {
          sessionId: v.sessionId as string,
        });
      });
      const goalRefresh = async () => {
        if (!goals || quitting) return;
        const activeGoals = goals
          .snapshot()
          .goals.filter((g) =>
            [
              "preparing",
              "running",
              "waiting",
              "recovering",
              "cancelling",
            ].includes(g.status),
          );
        if (activeGoals.length) await goals.refresh();
      };
      const notifyGoal = (goal: GoalRun) => {
        if (
          quitting ||
          modelOperation ||
          chat?.busy ||
          plannerActive(planner.snapshot())
        )
          return;
        const revision = goal.resultNotification?.revision;
        const owner = { sessionId: goal.sessionId, turnId: goal.turnId };
        // Reserve only the short durable result write. Completion is generated
        // from host facts and never waits for a second model/API request.
        const controller = new AbortController();
        modelOperation = controller;
        goalNotifications.add(controller);
        const notificationJob = (async () => {
          if (!(await goals!.beginResultNotification(goal.id, owner, revision)))
            return;
          const text = goalResultReport(goal).text;
          await goals!.setReply(goal.id, owner, {
            text,
            notificationRevision: revision,
          });
        })()
          .catch(() =>
            sendObservation(
              "gp:agent-error",
              "目标结果回报未保存，请查看原任务记录",
            ),
          )
          .finally(() => {
            goalNotifications.delete(controller);
            goalNotificationJobs.delete(notificationJob);
            if (modelOperation === controller) modelOperation = undefined;
          });
        goalNotificationJobs.add(notificationJob);
      };
      goals.subscribeTerminal(notifyGoal);
      goalTimer = setInterval(
        () =>
          void goalRefresh()
            .then(() => {
              for (const goal of goals!
                .snapshot()
                .goals.filter((g) => g.resultNotification?.state === "pending"))
                notifyGoal(goal);
            })
            .catch(() => {}),
        5000,
      );
      for (const view of await chatCommands.snapshot()) {
        commandChatOwners.set(view.reviewId, view.sessionId);
        view.receipt?.requestIds.forEach((id) =>
          executionChatOwners.set(id, view.sessionId),
        );
      }
      handle("gp:chat-command-snapshot", (id) =>
        chatCommands!.snapshot(id as string | undefined),
      );
      chatIntents = new ChatIntentReviewService({
        planner: () => planner.verifiedSnapshot(),
        chat: () => chat!.snapshot(),
        commands: chatCommands,
      });
      handle("gp:chat-intent-review", (input) =>
        chatIntents.review(
          input as import("../../../packages/protocol/chat-commands").ChatIntentReviewInput,
        ),
      );
      handle("gp:chat-command-review", (input) =>
        chatCommands!.review(
          input as import("../../../packages/protocol/chat-commands").ChatCommandReviewInput,
        ),
      );
      handle("gp:chat-command-confirm", (input) =>
        chatCommands!.confirm(
          input as import("../../../packages/protocol/chat-commands").ChatCommandConfirmation,
        ),
      );
      const pauseAfterStep = async (raw: unknown) => {
        const value = agentObject(raw, ["sessionId", "requestId", "revision"]);
        await validateChatSession(value.sessionId as string);
        const request = executions.get(validateRequestId(value.requestId));
        assertControlOwner(value.sessionId as string, request.id);
        if (
          request.status !== "running" ||
          !request.laneId ||
          !laneRuntime!.isRunning(request.laneId)
        )
          throw new Error("目标请求未在运行，请查看剩余步骤");
        const task = runLedger
          .forExecution(request.id)
          .find((t) => t.status === "running");
        if (!task) throw new Error("没有正在执行的步骤，不能使用旧请求暂停");
        const input = { runId: task.runId, revision: value.revision };
        await recordAgent({
          requestId: request.id,
          sessionId: value.sessionId as string,
          runId: task.runId,
          kind: "correction",
          status: "running",
          text: "用户请求当前步骤结束后暂停；正在等待边界回执",
        });
        return laneRuntime!
          .get(request.laneId)
          .request("pause-after-step", input);
      };
      handle("gp:chat-pause-after-step", pauseAfterStep);
      if (!smoke && !plannerPreview)
        localControl = await createLocalControlServer({
          profileDir: dataDir,
          handlers: {
            ...createGameAutomationControl({
              readLanes: async () => (await deviceLanes.read()).lanes,
              findExecution: (id) =>
                executions
                  .snapshot(Number.MAX_SAFE_INTEGER)
                  .find((item) => item.id === id),
              service: (gameId) =>
                gameId === "arknights"
                  ? arknightsAutomation!
                  : onmyojiAutomation!,
              busy: () =>
                automaticReserved ||
                configuring ||
                quitting ||
                startupInspectionRunning,
              launch: async (lane, gameId, batchId) => {
                const { job } = await launchLane(
                  lane,
                  batchId,
                  false,
                  undefined,
                  undefined,
                  gameId,
                );
                void job.catch((error) =>
                  console.error("App兼容入口执行结束", error),
                );
              },
            }),
            "arknights-run-status": (input) => {
              const record = executions.get(
                validateRequestId(`${input.batchId}:${input.laneId}`),
              );
              if (!record.snapshot.arknightsPlan || record.snapshot.onmyojiPlan)
                throw Error("请求不属于独立方舟任务");
              return {
                batchId: record.batchId,
                laneId: record.laneId,
                status: record.status,
                message: record.message,
              };
            },
            "arknights-automation": () => arknightsAutomation!.state(),
            "arknights-tick": async () => {
              if (
                automaticReserved ||
                executions.active ||
                laneRuntime?.active ||
                configuring
              )
                return {
                  batches: [],
                  message: "已有任务执行中，保留内部计划等待下次检查",
                };
              return { batches: await arknightsAutomation!.tick(new Date()) };
            },
            "arknights-run-job": (input) => {
              if (automaticReserved || configuring)
                throw Error("自动计划或设置操作正在进行");
              return arknightsAutomation!.runNow(
                input as unknown as import("../../../packages/protocol/arknights-automation").RunArknightsJobInput,
              );
            },
            "arknights-run-channel": async (input) => {
              if (automaticReserved || configuring)
                throw Error("自动计划或设置操作正在进行");
              const lane = (await deviceLanes.read()).lanes.find(
                (item) => item.id === input.laneId,
              );
              if (!lane?.enabled || !lane.arknights.enabled)
                throw Error("方舟账号渠道未启用或不存在");
              const batchId = validateRequestId(input.requestId);
              validateRequestId(`${batchId}:${lane.id}`);
              const existing = executions
                .snapshot(Number.MAX_SAFE_INTEGER)
                .find((item) => item.id === `${batchId}:${lane.id}`);
              if (existing) return { batchId, status: existing.status };
              const { job } = await launchLane(
                lane,
                batchId,
                false,
                undefined,
                undefined,
                "arknights",
                { laneId: lane.id, gameId: "arknights" },
              );
              void job.catch((error) =>
                console.error("方舟兼容入口执行结束", error),
              );
              return { batchId };
            },
            status: async () => {
              const chatState = await chat!.snapshot();
              return {
                version: appVersion,
                selectedSessionId: chatState.selectedSessionId ?? null,
                chatSessions: chatState.sessions.map((s) => ({
                  id: s.id,
                  title: s.title,
                })),
                requests: executions.snapshot(24).map((r) => ({
                  requestId: r.id,
                  status: r.status,
                  laneId: r.laneId,
                  startedAt: r.startedAt,
                  finishedAt: r.finishedAt,
                  // 处置状态必须一起给出去：监督层要据此区分"未处置的未确认"与
                  // "已经核对并写下依据的未确认"。少了它，已处置的记录会被反复当成待核对。
                  resolution: r.resolution
                    ? { action: r.resolution.action, at: r.resolution.at }
                    : null,
                })),
                planner: { status: planner.snapshot().status },
              };
            },
            capabilities: () => gameAgentCatalog(),
            events: (input) => agentJournal!.page(input),
            "command-review": (input) =>
              chatCommands!.review(
                input as unknown as import("../../../packages/protocol/chat-commands").ChatCommandReviewInput,
              ),
            "command-confirm": (input) =>
              chatCommands!.confirm(
                input as unknown as import("../../../packages/protocol/chat-commands").ChatCommandConfirmation,
              ),
            "resume-review": (input) =>
              chatCommands!.review({
                sessionId: input.sessionId as string,
                text: "继续任务",
                requestId: input.requestId as string,
              }),
            "resume-confirm": (input) =>
              chatCommands!.confirm(
                input as unknown as import("../../../packages/protocol/chat-commands").ChatCommandConfirmation,
              ),
            /**
             * 显式处置一条未终态记录（与界面的 `gp:execution-resolve` 共用同一条路径）。
             *
             * 为什么需要它：准入的第二道闸门只要该设备存在未处置记录就阻止任何新准入，
             * 与游戏无关；所以监督层必须能**在核对之后**把结论明确的记录处置掉，
             * 否则"一个游戏失败拖累另一个"只能靠重启 App 开调试端口走 CDP。
             *
             * 边界：必须写清依据（note ≥ 4 字）；只处置未终态记录，已终态或已处置的一律拒绝
             * （不删除、不改写历史）；`unknown` **允许**处置——因为这是"人/agent 已经现场核对过"
             * 的显式动作，与自动策略（`planDisposition` 里禁止自动处置 unknown）是两回事。
             */
            "resolve-execution": async (input) => {
              const requestId = validateRequestId(input.requestId);
              if (!requestId) throw new Error("请提供执行请求编号");
              const note = String(input.note ?? "").trim();
              if (note.length < 4) throw new Error("请填写处置说明");
              const record = executions.get(requestId);
              if (record.resolution) throw new Error("该请求已经处置过");
              if (record.status === "succeeded")
                throw new Error("该请求已成功完成，无需处置");
              // 真正还在跑的请求必须先停：处置一条活着的记录只会把状态搞乱。
              // （进程已经不存在的遗留 `running` 记录是允许处置的，2026-10-15 就有一条。）
              if (
                record.status === "running" &&
                record.laneId &&
                record.batchId &&
                laneRuntime?.isRunningBatch(record.laneId, record.batchId)
              )
                throw new Error("该请求正在运行，请先停止再处置");
              return recovery.resolve(requestId, note);
            },
            stop: async (input) => {
              await validateChatSession(input.sessionId as string);
              if (input.requestId) {
                const r = executions.get(validateRequestId(input.requestId));
                assertControlOwner(input.sessionId as string, r.id);
                if (r.status !== "running" || !r.laneId)
                  throw new Error("此请求不在运行");
                await stopLanes([r.laneId]);
              } else await stop();
              return {
                status: "stop-requested",
                message: "已请求停止，请核对原账本终态",
              };
            },
          },
        });
      await createWindow();
      if (process.argv.includes("--run-device-lanes-once")) {
        const lanes = (await deviceLanes.read()).lanes.filter(
          (lane) => lane.enabled,
        );
        if (!lanes.length) throw new Error("请先启用至少一个设备账号");
        await Promise.all(lanes.map(assertLaneCanStart));
        const batchId = randomUUID();
        const result = await launchIndependentLanes(lanes, batchId, launchLane);
        for (const issue of result.issues ?? [])
          console.error(`账号未启动：${issue.message}`);
      }
      if (!smoke && !process.argv.includes("--run-device-lanes-once")) {
        const config = await automation.read();
        closeToTray = config.closeToTray;
        const report = async (error: unknown) => {
          if (error instanceof Error && error.name === "AbortError") return;
          const message = "自动任务未完成：" + String(error);
          if ((await automation.read()).notifyResults)
            presence?.notify(message, true);
        };
        const schedulerTargets = new Map<string, DeviceLane>();
        /**
         * 重试只依据精确原设备/账号/时段的持久回执：明确启动故障且未提交游戏任务。
         * 没有成功步骤不等于没有副作用；unknown、原生提交和部分执行都拒绝整套重放。
         */
        const laneRetryDecision = async (
          laneId: string,
          occurrence: import("./scheduler").DailyOccurrence,
          context: import("./scheduler").DailyRetryContext,
        ) => {
          const current = (await deviceLanes.read()).lanes.find(
            (lane) => lane.id === laneId,
          );
          if (!current?.enabled || dailyLaneScope(current) !== context.scope)
            return {
              allowed: false,
              reason: "设备账号配置已变化，停止自动重试",
            };
          const targetInstances = new Set(
            scheduledGames(current, false, occurrence.slot).map(
              (gameId) => freezeLaneDevice(current, [gameId]).instance,
            ),
          );
          if (targetInstances.size > 1)
            return {
              allowed: false,
              reason: "本时段游戏指向不同 MuMu 实例，请分别核对原请求后继续",
            };
          const frozen = freezeLaneExecution(
            current,
            await arknights.read(),
            false,
            context.now,
            occurrence.slot,
          );
          return scheduledStartupRetry(
            frozen,
            occurrence,
            executions.snapshot(Number.MAX_SAFE_INTEGER),
            runLedger.snapshot(Number.MAX_SAFE_INTEGER),
            context.now,
            context.attempts,
          );
        };
        const assertScheduledHistoryClear = async (
          current: DeviceLane,
          occurrence: import("./scheduler").DailyOccurrence,
        ) => {
          executions.assertHealthy();
          runLedger.assertHealthy();
          await runLedger.flush();
          const profiles = await arknights.read();
          const now = new Date();
          for (const gameId of scheduledGames(
            current,
            false,
            occurrence.slot,
          )) {
            const frozen = freezeLaneExecutionForGame(
              current,
              profiles,
              gameId,
              false,
              now,
              occurrence.slot,
            );
            if (!frozen) continue;
            assertDailyHistoryClear(
              frozen,
              executions.snapshot(Number.MAX_SAFE_INTEGER),
              runLedger.snapshot(Number.MAX_SAFE_INTEGER),
              now,
              readStartupFacts(),
              occurrence,
            );
          }
        };
        const ensureLaneSchedulers = (lane: DeviceLane) => {
          schedulerTargets.set(lane.id, lane);
          if (!laneDailySchedulers.has(lane.id))
            laneDailySchedulers.set(
              lane.id,
              new DailyScheduler(
                createChannelDailyScheduleStore(dataDir, lane),
                (date) =>
                  schedulerTargets.get(lane.id)?.onmyoji.enabled
                    ? gameDay(date)
                    : arknightsGameDay(date),
                async (occurrence) => {
                  const current = (await deviceLanes.read()).lanes.find(
                    (item) => item.id === lane.id,
                  );
                  if (!current?.enabled) return "cancelled";
                  if (
                    occurrence.slot === "secondary" &&
                    !current.arknights.enabled
                  )
                    return "skipped";
                  await assertScheduledHistoryClear(current, occurrence);
                  // P1a'：一个槽位在这个时段要跑的每个游戏**各自一个请求**，按执行顺序串行发起。
                  // 设备层的顺序不变式原样保留：同一台设备一次只跑一个游戏、上一个引擎必须干净
                  // 释放（见 lane-plan.ts 顶部注释与 tests/lane-plan.test.ts）。
                  // 一个游戏失败就停（不换引擎），但下一个游戏的**当日机会不会被消耗**：
                  // 它自己的准入只看与它相关的计划与证据。
                  const games = scheduledGames(current, false, occurrence.slot);
                  if (!games.length) return "skipped";
                  for (const game of games) {
                    const { job } = await launchLane(
                      current,
                      `${randomUUID()}:${game}`,
                      false,
                      automaticCycle?.signal,
                      occurrence,
                      game,
                    );
                    await job;
                  }
                  return "succeeded";
                },
                // 失败后允许有界重试，但只在这条槽位今天还没跑成过任何游戏步骤时。
                (occurrence, context) =>
                  laneRetryDecision(lane.id, occurrence, context),
                async (occurrence) => {
                  const current = (await deviceLanes.read()).lanes.find(
                    (item) => item.id === lane.id,
                  );
                  if (
                    current?.enabled &&
                    (occurrence.slot !== "secondary" ||
                      current.arknights.enabled)
                  )
                    await assertScheduledHistoryClear(current, occurrence);
                },
              ),
            );
          getLaneFosterScheduler(lane);
        };
        for (const lane of (await deviceLanes.read()).lanes)
          ensureLaneSchedulers(lane);
        presence = new DesktopPresence({
          show: () => {
            window?.restore();
            window?.show();
            window?.focus();
          },
          run: () => {
            void (async () => {
              if (automaticReserved || history.active)
                throw new Error("已有任务正在运行");
              const lanes = (await deviceLanes.read()).lanes.filter(
                (lane) => lane.enabled,
              );
              if (!lanes.length) throw new Error("请先启用至少一个设备账号");
              await Promise.all(lanes.map(assertLaneCanStart));
              const batchId = randomUUID();
              const result = await launchIndependentLanes(
                lanes,
                batchId,
                launchLane,
              );
              if (result.issues?.length)
                await report(
                  `部分账号未启动：${result.issues.map((issue) => issue.message).join("；")}`,
                );
            })().catch(report);
          },
          stop: () => {
            void stop().catch(report);
          },
          quit: () => app.quit(),
        });
        let lastSchedulerError = "";
        // 已就“寄养维护被暂停”通知过的槽位；闸门解除后移除，避免每 15 秒重复弹窗。
        const maintenancePausedNotified = new Set<string>();
        const tick = async (trigger = "timer") => {
          if (
            quitting ||
            starting ||
            connecting ||
            finishing ||
            configuring ||
            history.active ||
            !!context ||
            automaticReserved ||
            startupInspectionRunning
          )
            return;
          automaticReserved = true;
          automaticCycle = new AbortController();
          automaticLaneIds.clear();
          cancelledLaneCycles.clear();
          try {
            const config = await automation.read();
            const lanes = (await deviceLanes.read()).lanes.filter(
              (lane) => lane.enabled,
            );
            automaticCycle.signal.throwIfAborted();
            for (const lane of lanes) automaticLaneIds.add(lane.id);
            // Admission is ordered across games so a shared device is visible to the next scheduler.
            // tick returns after admission, leaving workers on distinct devices concurrent.
            await arknightsAutomation!.tick(new Date());
            await onmyojiAutomation!.tick(new Date());
            for (const lane of lanes) ensureLaneSchedulers(lane);
            const results = await Promise.allSettled(
              lanes
                .filter(
                  (lane) => lane.onmyoji.enabled && !lane.arknights.enabled,
                )
                .map(async (lane) => {
                  if (
                    !automaticCycle?.signal.aborted &&
                    !cancelledLaneCycles.has(lane.id) &&
                    maintenanceLanes([lane]).length
                  ) {
                    const fosterScheduler = laneFosterSchedulers.get(lane.id)!;
                    const fosterScope = dailyLaneScope(lane);
                    await fosterScheduler.tick(
                      new Date(),
                      config.fosterScheduleEnabled,
                      laneRuntime!.isRunning(lane.id),
                      fosterScope,
                    );
                    // 闸门命中时不再静默返回：否则用户只看到"每 6 小时检查寄养"仍开着，
                    // 却永远不再运行，也没有任何提示。
                    const gate = await fosterScheduler.gateState(fosterScope);
                    if (gate.blocked && config.fosterScheduleEnabled) {
                      if (!maintenancePausedNotified.has(lane.id)) {
                        maintenancePausedNotified.add(lane.id);
                        await report(
                          new Error(
                            `${lane.name} 的寄养维护已暂停：${
                              gate.blockedAt ?? "上次运行"
                            } 的结果未确认。请在任务详情核对并处置原记录，或完成新的现场观测，再重新启用寄养维护进行检查。`,
                          ),
                        );
                      }
                    } else if (maintenancePausedNotified.delete(lane.id)) {
                      // 闸门已解除，下次再暂停时重新提示一次。
                    }
                  }
                }),
            );
            for (const result of results)
              if (result.status === "rejected") await report(result.reason);
          } catch (error) {
            const message = gameDay(new Date()) + "|" + String(error);
            if (message !== lastSchedulerError) {
              lastSchedulerError = message;
              await report(error);
            }
          } finally {
            automaticReserved = false;
          }
        };
        scheduleTimer = setInterval(() => {
          void tick();
        }, 15000);
        powerMonitor.on("resume", () => {
          void tick();
        });
        void tick("startup");
      }
      if (plannerUiTest) {
        const evidence = join(
          app.getAppPath(),
          "artifacts",
          (plannerModelTest ? "agent-ui" : "agent-ui-replay") +
            (plannerRecordedTest
              ? "-recorded"
              : plannerConfiguredTest
                ? "-configured"
                : ""),
        );
        try {
          const before =
            (plannerConfiguredTest || plannerRecordedTest) && plannerModelTest
              ? await readConfiguredSnapshot(
                  join(app.getPath("home"), ".gamepilot"),
                  { history: plannerRecordedTest },
                )
              : undefined;
          await runPlannerUiSmoke(
            window!,
            evidence,
            plannerModelTest,
            plannerConfiguredTest,
            plannerRecordedTest,
          );
          if (
            before &&
            before.fingerprint !==
              (
                await readConfiguredSnapshot(
                  join(app.getPath("home"), ".gamepilot"),
                  { history: plannerRecordedTest },
                )
              ).fingerprint
          )
            throw Error("正式账号配置已改变");
        } catch (error) {
          await mkdir(evidence, { recursive: true });
          await writeFile(join(evidence, "error.txt"), String(error));
        } finally {
          await planner.close();
          app.quit();
        }
      }
      if (smoke && !plannerPreview) {
        const evidence = join(app.getAppPath(), "artifacts");
        await mkdir(evidence, { recursive: true });
        try {
          const result = await window!.webContents
            .executeJavaScript(`(async () => {
        const api = window.gamepilot;
        if (!api) throw new Error('Preload bridge missing');
        const snapshot = await api.snapshot();
        if (!snapshot.engine?.version) throw new Error(snapshot.engineError || 'Engine missing');
        let deviceCapture = null;
        if (${Boolean(process.env.GAMEPILOT_SMOKE_ADB && process.env.GAMEPILOT_SMOKE_ADDRESS)}) {
          snapshot.engine = await api.connect({ name: 'MuMu 实测', adbPath: snapshot.settings.adbPath, address: snapshot.settings.address });
          deviceCapture = await api.capture();
          if (!deviceCapture.startsWith('data:image/')) throw new Error('Invalid device screenshot');
        }
        const events = [];
        let onmyojiStopped;
        const onmyojiTerminal = new Promise(resolve => { onmyojiStopped = resolve; });
        const off = api.onEvent(event => { events.push(event); if (event.status === 'cancelled') onmyojiStopped(); });
        // 2026-10-25 定稿：每日 = 必做 6 项 + 阴阳寮麒麟（集体任务/胧车/寄养不纳入日常）。
        const onmyojiDaily = ['login','check-in','mail','daily-gift','guild-kirin','realm-raid','hana-claim'];
        const requestId = crypto.randomUUID();
        await api.start({ gameId: 'onmyoji', skillIds: onmyojiDaily, mode: 'rehearsal' }, requestId);
        let overlapRejected = false;
        try { await api.start({ gameId: 'onmyoji', skillIds: onmyojiDaily, mode: 'rehearsal' }); }
        catch { overlapRejected = true; }
        if (!overlapRejected) throw Error('Overlapping start was accepted');
        await new Promise(resolve => setTimeout(resolve, 150));
        await api.stop();
        await Promise.race([onmyojiTerminal, new Promise((_, reject) => setTimeout(() => reject(Error('Cancellation event timeout')), 5000))]);
        off();
        let replayRejected = false;
        try { await api.start({ gameId: 'onmyoji', skillIds: onmyojiDaily, mode: 'rehearsal' }, requestId); }
        catch (error) { replayRejected = String(error).includes('已受理'); }
        if (!replayRejected) throw Error('Completed request was not deduplicated');
        if (!events.some(e => e.status === 'cancelled')) throw new Error('Cancellation not acknowledged');
        const onmyojiGame = snapshot.games.find(g => g.id === 'onmyoji');
        if (!onmyojiDaily.every(id => onmyojiGame?.skills.some(skill => skill.id === id && skill.ready))) throw Error('Validated Onmyoji daily skills unavailable');
        const arkGame = snapshot.games.find(g => g.id === 'arknights');
        if (!arkGame) throw Error('Arknights registration missing');
        const arkDaily = ['login','fight','infrastructure','friends','award'];
        if (!arkDaily.every(id => arkGame.skills.some(skill => skill.id === id && skill.ready))) throw Error('Validated Arknights daily skills unavailable');
        const arkConfig = await api.arknights();
        await api.saveArknights({...arkConfig,profiles:arkConfig.profiles.map(profile=>({...profile,stage:profile.stage||'LS-6'}))});
        const internalPlans = await api.arknightsAutomation();
        if (internalPlans.version !== 1 || internalPlans.enabled || !internalPlans.jobs.length) throw Error('Internal automation inert defaults missing');
        const editedPlans = {...internalPlans, jobs:internalPlans.jobs.map((job,index)=>index===0?{...job,time:'11:23',weekdays:[1,3],skillIds:['login','fight']}:job)};
        await api.saveArknightsAutomation(editedPlans);
        const readPlans=await api.arknightsAutomation();
        if (JSON.stringify(readPlans)!==JSON.stringify(editedPlans)) throw Error('Internal automation round-trip mismatch');
        let invalidPlanRejected=false;
        try { await api.saveArknightsAutomation({...editedPlans,jobs:editedPlans.jobs.map((job,index)=>index===0?{...job,weekdays:[9]}:job)}); } catch {invalidPlanRejected=true;}
        if(!invalidPlanRejected || JSON.stringify(await api.arknightsAutomation())!==JSON.stringify(editedPlans)) throw Error('Invalid automation changed saved plans');
        await api.saveArknightsAutomation(internalPlans);
        const yysPlans=await api.onmyojiAutomation();
        if(yysPlans.version!==1 || yysPlans.enabled || !yysPlans.jobs.length) throw Error('Onmyoji inert plans missing');
        const editedYys={...yysPlans,jobs:yysPlans.jobs.map((job,index)=>index===0?{...job,time:'10:45',weekdays:[1,2,3,4],skillIds:['login','mail','hana-claim']}:job)};
        await api.saveOnmyojiAutomation(editedYys);
        if(JSON.stringify(await api.onmyojiAutomation())!==JSON.stringify(editedYys)) throw Error('Onmyoji schedule roundtrip failed');
        let badYysRejected=false;
        try { await api.saveOnmyojiAutomation({...editedYys,jobs:editedYys.jobs.map((job,index)=>index===0?{...job,skillIds:['fight']}:job)}); } catch {badYysRejected=true;}
        if(!badYysRejected || JSON.stringify(await api.onmyojiAutomation())!==JSON.stringify(editedYys)) throw Error('Cross-game schedule changed saved Onmyoji plans');
        await api.saveOnmyojiAutomation(yysPlans);
        await api.saveArknights(arkConfig);
        const activeArk = arkConfig.profiles.find(profile => profile.id === arkConfig.activeProfileId);
        if (!activeArk) throw Error('Arknights active profile missing');
        await api.saveArknights({ ...arkConfig, profiles: arkConfig.profiles.map(profile => profile.id === activeArk.id ? { ...profile, stage: '1-7' } : profile) });
        const savedArk = await api.arknights();
        if (savedArk.profiles.find(profile => profile.id === savedArk.activeProfileId)?.stage !== '1-7') throw Error('Arknights settings not persisted');
        const arkEvents = [];
        let arkStopped;
        const arkTerminal = new Promise(resolve => { arkStopped = resolve; });
        const offArk = api.onEvent(e => { arkEvents.push(e); if (e.status === 'cancelled') arkStopped(); });
        await api.start({ gameId: 'arknights', skillIds: arkDaily, mode: 'rehearsal' });
        await new Promise(resolve => setTimeout(resolve, 150));
        await api.stop();
        await Promise.race([arkTerminal, new Promise((_, reject) => setTimeout(() => reject(Error('Arknights cancellation event timeout')), 5000))]);
        offArk();
        if (!arkEvents.some(e => e.gameId === 'arknights' && e.status === 'cancelled')) throw Error('Arknights cancellation missing game identity');
        await api.saveArknights(arkConfig);
        const taskSnapshot = await api.snapshot();
        const execution = taskSnapshot.executions?.find(item => item.id === requestId);
        if (!execution || execution.status !== 'cancelled' || execution.snapshot.plan.mode !== 'rehearsal') throw Error('Execution request receipt missing');
        const review = await api.reviewExecution(requestId);
        const continuationPreview = await api.previewContinuation(requestId);
        const mergedProgress = await api.executionProgress(requestId);
        if (mergedProgress.requestId !== requestId || mergedProgress.wholePlanComplete || mergedProgress.outcome !== 'unconfirmed') throw Error('Rehearsal counted as completed original plan');
        if (continuationPreview.canContinue || !continuationPreview.reasons.some(reason => reason.includes('演练'))) throw Error('Rehearsal continuation admitted');
        let continuationRejected = false;
        try { await api.startContinuation({parentId:requestId,fingerprint:continuationPreview.fingerprint,selections:[{gameId:'onmyoji',skillIds:['mail']}],acknowledgePartial:true}); } catch { continuationRejected = true; }
        if (!continuationRejected) throw Error('Unsafe continuation started');
        if (review.canResume || !review.games[0]?.runId || review.games[0].steps.some(step => step.status === 'unrecorded')) throw Error('Recovery review missing exact request linkage');
        let rehearsalInspectionRejected = false;
        try { await api.inspectExecution(requestId); } catch(e) { rehearsalInspectionRejected = String(e).includes('演练'); }
        if (!rehearsalInspectionRejected) throw Error('Rehearsal inspection touched a real device');
        const resolution = await api.resolveExecution({id:requestId, note:'桌面演练结束，不续跑'});
        if (resolution.status !== 'cancelled' || !resolution.resolution) throw Error('Review resolution changed original result');
        const earlyEvents = [];
        const offEarly = api.onEvent(event => earlyEvents.push(event));
        const early = api.start({ gameId: 'onmyoji', skillIds: ['login'], mode: 'rehearsal' }).then(() => false, () => true);
        await api.stop();
        const cancelledBeforeStart = await early;
        offEarly();
        if (!cancelledBeforeStart || earlyEvents.some(event => event.plan)) throw Error('Early cancellation started a worker plan');
        const runIds = [events, arkEvents].map(list => list.find(e => e.plan)?.runId);
        const taskRuns = runIds.map(id => taskSnapshot.runs?.find(r => r.runId === id));
        if (taskRuns.some(r => !r || r.plan.mode !== 'rehearsal' || r.status !== 'cancelled' || !r.steps.some(s => s.status === 'not-run'))) throw Error('Task ledger did not preserve cancelled rehearsal');
        return { engine: snapshot.engine, events, onmyojiDailyReady: true, arkDailyReady: true, arkEvents, taskRuns, execution, review, resolution, continuationRejected, continuationPreview, mergedProgress, rehearsalInspectionRejected, replayRejected, cancelledBeforeStart, deviceCapture, body: document.body.innerText.slice(0, 1200) };
      })()`);
          if (result.deviceCapture) {
            await writeFile(
              join(evidence, "device-capture.png"),
              Buffer.from(result.deviceCapture.split(",")[1], "base64"),
            );
            result.deviceCapture = {
              file: "device-capture.png",
              verified: true,
            };
            await window!.loadFile(rendererFile);
            result.previewVerified = await window!.webContents
              .executeJavaScript(`(async () => {
            const wait = () => new Promise(resolve => setTimeout(resolve, 100));
            const preview = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '设备预览');
            if (preview && preview.getAttribute('aria-expanded') === 'false') { preview.click(); await wait(); }
            let capture;
            for (let i = 0; i < 100; i++) {
              capture = [...document.querySelectorAll('button')].find(button => button.textContent.includes('截取画面') && !button.disabled);
              if (capture) break;
              await wait();
            }
            if (!capture) throw new Error('Connected device not reflected in UI');
            capture.click();
            for (let i = 0; i < 100; i++) {
              const image = document.querySelector('.device-screen img');
              if (image?.complete && image.naturalWidth > 0) return true;
              await wait();
            }
            throw new Error('Device screenshot not rendered');
          })()`);
          }
          await window!.webContents.executeJavaScript(
            `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
          );
          result.workspaceUi = await window!.webContents
            .executeJavaScript(`(async () => {
            const until = async (read, label) => {
              for (let attempt = 0; attempt < 100; attempt++) {
                const value = await read();
                if (value) return value;
                await new Promise(resolve => setTimeout(resolve, 50));
              }
              throw Error('Workspace UI timeout: ' + label);
            };
            const visible = item => item && item.getClientRects().length > 0;
            const workspace = () => [...document.querySelectorAll('.game-workspace')].find(visible);
            const click = async (text) => {
              const button = await until(() => [...(workspace()?.querySelectorAll('button') || [])].find(item => visible(item) && !item.disabled && item.textContent.trim() === text), text);
              button.click();
            };
            const tab = async (text) => {
              await click(text);
              await until(() => [...(workspace()?.querySelectorAll('.workspace-tabs button') || [])].find(item => item.textContent.trim() === text && item.getAttribute('aria-current') === 'page'), text + ' tab');
            };
            const stageField = () => [...(workspace()?.querySelectorAll('.game-settings-form label') || [])].find(item => item.textContent.includes('代理作战关卡'))?.querySelector('input');
            const tools = document.querySelector('.sidebar-tools');
            if (tools) tools.open = true;
            const ark = await until(() => [...document.querySelectorAll('.sidebar-tools button')].find(item => item.textContent.includes('明日方舟') && !item.disabled), 'Arknights navigation');
            ark.click();
            const account = await until(() => workspace()?.querySelector('select[aria-label="工作区账号"]'), 'lazy account workspace');
            const configured = await window.gamepilot.deviceLanes();
            const saved = await window.gamepilot.arknights();
            const target = configured.lanes.find(item => item.enabled && item.arknights.enabled && !item.onmyoji.enabled && saved.profiles.some(profile => profile.id === item.arknights.profileId));
            if (!target) throw Error('Single-game Arknights account missing');
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(account, target.id);
            account.dispatchEvent(new Event('change', { bubbles: true }));
            await until(() => workspace()?.querySelector('select[aria-label="工作区账号"]')?.value === target.id && workspace()?.querySelector('[aria-label="所选账号任务"] h2')?.textContent.includes(target.name), 'selected account binding');
            const advanced = await until(() => [...workspace().querySelectorAll('details')].find(item => item.querySelector('summary')?.textContent.trim() === '高级设备工具' && visible(item)), 'advanced device disclosure');
            if (!advanced.open) advanced.querySelector('summary').click();
            const skill = await until(() => [...workspace().querySelectorAll('.skill-card')].find(item => visible(item) && !item.disabled && item.getAttribute('aria-pressed') === 'false'), 'lazy skill cards');
            skill.click();
            await until(() => skill.getAttribute('aria-pressed') === 'true', 'selected skill');
            await tab('游戏设置');
            try {
              const field = await until(() => { const input = stageField(); return visible(input) && !input.disabled && input; }, 'bound profile stage field');
              Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, 'LS-6');
              field.dispatchEvent(new Event('input', { bubbles: true }));
              await new Promise(resolve => requestAnimationFrame(resolve));
              await tab('执行记录'); await tab('游戏设置');
              const retained = await until(() => { const input = stageField(); return visible(input) && !input.disabled && input; }, 'retained settings form');
              if (retained !== field || retained.value !== 'LS-6') throw Error('Unsaved settings lost across tabs');
              await click('保存明日方舟设置');
              const current = await until(async () => { const value = await window.gamepilot.arknights(); return value.profiles.find(item => item.id === target.arknights.profileId)?.stage === 'LS-6' && value; }, 'bound profile persisted');
              if (current.activeProfileId !== saved.activeProfileId) throw Error('Bound profile save changed global active account');
              if (JSON.stringify(current.profiles.filter(item => item.id !== target.arknights.profileId)) !== JSON.stringify(saved.profiles.filter(item => item.id !== target.arknights.profileId))) throw Error('Bound profile save changed another account');
              await tab('适配进展'); await tab('任务');
              if (!visible(skill) || skill.getAttribute('aria-pressed') !== 'true') throw Error('Task selection lost across tabs');
              if (workspace().querySelector('select[aria-label="工作区账号"]').value !== target.id) throw Error('Workspace account changed across tabs');
              return { settingsSaved: true, draftRetained: true, taskSelectionRetained: true, channelId: target.id, profileId: target.arknights.profileId, activeProfilePreserved: true, otherProfilesPreserved: true, lazyToolsMounted: true };
            } finally { await window.gamepilot.saveArknights(saved); }
          })()`);
          await writeFile(
            join(evidence, "smoke-result.json"),
            JSON.stringify(result, null, 2),
          );
          await writeFile(
            join(evidence, "desktop.png"),
            (await window!.webContents.capturePage()).toPNG(),
          );
          const devicesReady = await window!.webContents
            .executeJavaScript(`(() => {
            const button = [...document.querySelectorAll('.sidebar button')].find(item => item.textContent.trim() === '设备与账号');
            if (!button) throw new Error('Devices navigation missing');
            button.click();
            return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.body.innerText.includes('账号渠道配置')))));
          })()`);
          if (!devicesReady) throw new Error("Device lane UI missing");
          await writeFile(
            join(evidence, "devices.png"),
            (await window!.webContents.capturePage()).toPNG(),
          );
          await failureEvidenceUiSmoke(
            window!,
            dataDir,
            evidence,
            rendererFile,
            executions,
            runLedger,
          );
          app.exit(0);
        } catch (error) {
          await writeFile(join(evidence, "smoke-error.txt"), String(error));
          app.exit(1);
        }
      }
    })
    .catch((error) => {
      console.error(error);
      app.exit(1);
    });

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  lanePreview?.invalidateAll();
  modelOperation?.abort();
  for (const controller of goalNotifications) controller.abort();
  clearInterval(goalTimer);
  clearInterval(scheduleTimer);
  cancelPreparation();
  worker?.close();
  laneRuntime?.close();
  if (history && !quitting) {
    event.preventDefault();
    quitting = true;
    void Promise.allSettled([
      history.flush(),
      arknightsAutomation?.stop(),
      onmyojiAutomation?.stop(),
      runLedger?.flush(),
      executions?.flush(),
      planner.close().then(() => chat?.close()),
      incidentAgent?.close(),
      agentExecution?.close(),
      localControl?.close(),
      ...goalNotificationJobs,
    ])
      .then(() => goals?.flush())
      .then(() => agentJournal?.close())
      .finally(() => app.quit());
  }
});
app.on("will-quit", () => {
  if (incidentTimer) clearInterval(incidentTimer);
  presence?.destroy();
  worker?.close();
  laneRuntime?.close();
});
