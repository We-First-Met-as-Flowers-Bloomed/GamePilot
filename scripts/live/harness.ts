/**
 * 实机技能 harness 的打包入口：把仓库自己的底层与判据 re-export 给 run.mjs。
 *
 * 只做 re-export，保证 harness 用的就是 App worker 用的那一套实现
 * （`MaaEngine` 同一份 MaaFramework 控制器、同一份 OCR 资源、同一个 1920 坐标系）。
 */
export { MaaEngine } from "../../packages/runtime/maa";
export { OnmyojiDaily } from "../../games/onmyoji/daily";
export { liveSkills, resolveLiveSkill } from "./skills";
export {
  isCourtyard,
  isCourtyardTasks,
  isGuildRealm,
  isShopDistrict,
  isGiftHouse,
  isExploration,
  isMap,
  isKirinHunt,
  isHanaPage,
  isTrainingPage,
  isMailbox,
} from "../../games/onmyoji/policy";
