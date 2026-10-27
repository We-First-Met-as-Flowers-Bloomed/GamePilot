/** 打包入口：自检的判定与修复计划（都可测的纯函数）。 */
export {
  normalizeExe,
  renderPreflight,
  runPreflightChecks,
  type PreflightCheck,
  type PreflightFacts,
  type PreflightReport,
} from "./checks";
export { planFixes, type FixAction, type FixKind } from "./fix";
