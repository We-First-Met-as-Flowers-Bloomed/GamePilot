/**
 * 游戏模式 · 打包入口：一次只加载一个游戏的引擎栈，避免两套原生层同进程互相干扰。
 */
export {
  gameModePlans,
  planFor,
  stepsForDay,
  onmyojiMode,
  arknightsMode,
} from "./plans";
export { classifyFailure, decideRecovery } from "./recovery";
export {
  completionState,
  isSettledOutcome,
  stepOutcomeFromResult,
} from "./outcome";
export {
  renderReport,
  summarizeRun,
  mergeRunOutcomes,
  gameModeRunSucceeded,
} from "./report";
export { mergeStatus, renderStatus, renderDailyReport } from "./status";
export { planCatchup, renderCatchup, executeCatchupQueue } from "./catchup";
export {
  planRecovery,
  renderRecovery,
  deviceIsReachable,
  executeDeviceRecovery,
} from "./recovery-device";
export { planDisposition, dispositionsFromReport } from "./disposition";
export {
  reserveActorAttempt,
  finishActorAttempt,
  readActorAttempts,
} from "./attempts";
export {
  actorIdOf,
  planActors,
  renderActorDecision,
  DEFAULT_STAGGER_MS,
  deriveActorStats,
} from "../actors/runtime";
export { liveSkills, resolveLiveSkill } from "../live/skills";
export { inspectDevice } from "../../packages/runtime/device-inspection";
export { inspectDeviceForPackage } from "../../packages/runtime/device-inspection";
export { inspectDeviceCandidates } from "../../packages/runtime/device-inspection";
export { pressAndroidBack } from "../../packages/runtime/android-capture";
export { inspectArknightsDevice } from "../../games/arknights/inspect-device";
export { returnArknightsHome } from "../../games/arknights/navigation";
export { activeArknightsConfig } from "../../games/arknights/config";
export { arknightsPackage } from "../../games/arknights/config";
