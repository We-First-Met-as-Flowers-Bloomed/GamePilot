import type { Device } from "../../packages/protocol";
import type { DeviceInspection } from "../../packages/protocol/recovery";
import type { Frame, Rect } from "../../packages/runtime/device";
import { arknightsPackage, type ArknightsConfig } from "./config";
import { classifyArknightsFrame, compareArknightsFrames } from "./inspection";

interface InspectionPorts {
  capture(device: Device): Promise<DeviceInspection>;
  recognize(image: string, roi?: Rect, onlyRec?: boolean): Promise<Frame>;
  wait(): Promise<void>;
}
/** Only observes; never navigates, selects accounts, dismisses overlays or starts tasks. */
export async function inspectArknightsDevice(
  device: Device,
  config: ArknightsConfig,
  ports: InspectionPorts,
): Promise<DeviceInspection> {
  let latest = await ports.capture(device);
  const recognize = async (capture: DeviceInspection) => {
    const frame =
      capture.foregroundPackage === arknightsPackage(config)
        ? await ports.recognize(capture.image)
        : { width: 1920, height: 1080, texts: [] };
    const evidence = classifyArknightsFrame(
      frame,
      capture.foregroundPackage,
      config,
    );
    if (evidence.page !== "home" || evidence.uid) return evidence;
    const roi: Rect = [
      Math.round((114 * frame.width) / 1920),
      Math.round((635 * frame.height) / 1080),
      Math.round((126 * frame.width) / 1920),
      Math.round((24 * frame.height) / 1080),
    ];
    const crop = await ports.recognize(capture.image, roi, true);
    // Merge evidence: a conflicting/duplicate UID is never silently replaced.
    return classifyArknightsFrame(
      { ...frame, texts: [...frame.texts, ...crop.texts] },
      capture.foregroundPackage,
      config,
    );
  };
  try {
    const first = await recognize(latest);
    await ports.wait();
    latest = await ports.capture(device);
    const second = await recognize(latest);
    const arknights = compareArknightsFrames(first, second, config);
    return {
      ...latest,
      accountVerified: arknights.accountVerified,
      pageVerified: arknights.pageVerified,
      arknights,
    };
  } catch (error) {
    return {
      ...latest,
      accountVerified: false,
      pageVerified: false,
      recognitionError: error instanceof Error ? error.message : String(error),
    };
  }
}
