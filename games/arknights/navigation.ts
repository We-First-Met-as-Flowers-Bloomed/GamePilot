import type { Device } from "../../packages/protocol";
import type { DeviceInspection } from "../../packages/protocol/recovery";
import { arknightsPackage, type ArknightsConfig } from "./config";
import { arknightsPageLabels } from "./inspection";

interface NavigationPorts {
  inspect(): Promise<DeviceInspection>;
  back(): Promise<void>;
  log(message: string): void;
}

/** A bounded navigation tool, never a purchase/reward/task replay. Unknown overlays stop it. */
export async function returnArknightsHome(
  device: Device,
  config: ArknightsConfig,
  signal: AbortSignal,
  ports: NavigationPorts,
): Promise<DeviceInspection> {
  for (let returns = 0; returns <= 3; returns++) {
    signal.throwIfAborted();
    const started = Date.now(),
      capture = await ports.inspect();
    signal.throwIfAborted();
    const at = Date.parse(capture.observedAt),
      scene = capture.arknights;
    if (
      capture.address !== device.address ||
      capture.foregroundPackage !== arknightsPackage(config) ||
      capture.recognitionError ||
      !Number.isFinite(at) ||
      at < started ||
      at > Date.now() ||
      Date.now() - at > 15000 ||
      !capture.pageVerified ||
      !scene?.pageVerified ||
      scene.expectedUid !== config.expectedUid ||
      scene.frames.length !== 2 ||
      scene.frames.some(
        (f) =>
          f.page !== scene.page ||
          (config.expectedUid && f.uid && f.uid !== config.expectedUid),
      )
    )
      throw Error("导航现场不新鲜、设备/客户端/账号或双帧不符，停止返回");
    if (
      scene.page === "profile" &&
      (!scene.frames[0].uid || scene.frames[0].uid !== scene.frames[1].uid)
    )
      throw Error("个人名片缺少双帧一致的完整ID，不使用公共菜单标题执行返回");
    if (scene.page === "home") {
      ports.log(
        `导航恢复：已双帧确认主页（返回${returns}次），没有重复提交任务`,
      );
      return capture;
    }
    if (!["credit-shop", "friends-list", "profile"].includes(scene.page))
      throw Error(
        `导航恢复：${arknightsPageLabels[scene.page]}没有已验证退出规则，停止返回`,
      );
    if (returns === 3)
      throw Error("导航恢复：返回3次仍未确认主页，停止且不重做任务");
    ports.log(
      `导航恢复：双帧确认${arknightsPageLabels[scene.page]}，执行返回（${returns + 1}/3）`,
    );
    signal.throwIfAborted();
    await ports.back();
    signal.throwIfAborted();
  }
  throw Error("导航恢复未完成");
}
