import type { AndroidDisplay } from "../../packages/runtime/android-display";
export {
  captureAndroidDisplay,
  readAndroidDisplay,
} from "../../packages/runtime/android-capture";

interface SurveyFrame {
  image: Buffer;
  display: AndroidDisplay;
}
interface SurveyPorts {
  capture(): Promise<SurveyFrame>;
  readDisplay(): Promise<AndroidDisplay>;
  input(args: string[]): Promise<void>;
  wait(milliseconds: number): Promise<void>;
}
export function scaleSurveyPoint(
  point: [number, number],
  width: number,
  height: number,
): [number, number] {
  const [x, y] = point;
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    x >= 1920 ||
    y < 0 ||
    y >= 1080
  ) {
    throw new Error("勘查点击坐标必须位于 1920×1080 范围内");
  }
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error("勘查截图尺寸无效");
  }
  return [
    Math.min(width - 1, Math.round((x * width) / 1920)),
    Math.min(height - 1, Math.round((y * height) / 1080)),
  ];
}

function sameDisplay(expected: AndroidDisplay, actual: AndroidDisplay) {
  if (
    expected.logicalId !== actual.logicalId ||
    expected.physicalId !== actual.physicalId ||
    expected.foregroundPackage !== actual.foregroundPackage ||
    expected.width !== actual.width ||
    expected.height !== actual.height
  ) {
    throw new Error("勘查期间显示映射或前台应用已改变，停止导航");
  }
}

export async function navigateSurvey(
  taps: [number, number][],
  waitMs: number,
  ports: SurveyPorts,
): Promise<SurveyFrame> {
  // Validate the whole requested sequence before making any device call.
  for (const point of taps) scaleSurveyPoint(point, 1, 1);
  if (!Number.isFinite(waitMs) || waitMs < 0)
    throw new Error("勘查等待时间无效");
  let frame = await ports.capture();
  if (!taps.length) return frame;
  const expected = frame.display;
  if (!expected.foregroundPackage)
    throw new Error("无法核对前台应用，拒绝勘查点击");
  for (const point of taps) {
    sameDisplay(expected, frame.display);
    const [x, y] = scaleSurveyPoint(
      point,
      frame.image.readUInt32BE(16),
      frame.image.readUInt32BE(20),
    );
    // Recheck immediately before input; Android input uses the logical ID,
    // whereas screencap uses the physical decimal string.
    sameDisplay(expected, await ports.readDisplay());
    await ports.input([
      "shell",
      "input",
      "-d",
      String(expected.logicalId),
      "tap",
      String(x),
      String(y),
    ]);
    await ports.wait(waitMs);
    frame = await ports.capture();
    sameDisplay(expected, frame.display);
  }
  return frame;
}
