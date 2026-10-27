/**
 * 方舟实机 harness 的打包入口：把 App worker 用的同一套方舟模块 re-export 出去。
 *
 * 复用而不是重写：`createArknightsWorkerAdapter` 就是 App 跑方舟日常的那份实现
 * （含 login 双帧 UID 核对、信用购物后置核验、启动崩溃诊断），
 * `executeArknightsTask` 是它内部的单任务执行器，`MaaCoreClient` 是 MaaCore 桥客户端。
 */
export { createArknightsWorkerAdapter } from "../../games/arknights/worker-adapter";
export { inspectDevice } from "../../packages/runtime/device-inspection";
export { pressAndroidBack } from "../../packages/runtime/android-capture";
export { inspectArknightsDevice } from "../../games/arknights/inspect-device";
export { returnArknightsHome } from "../../games/arknights/navigation";
export { MaaCoreClient } from "../../packages/runtime/maacore";
export {
  activeArknightsConfig,
  arknightsPackage,
  defaultArknightsConfig,
  taskFor,
} from "../../games/arknights/config";
