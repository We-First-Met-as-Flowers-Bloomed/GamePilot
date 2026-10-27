import { describe, expect, it, vi } from "vitest";
import {
  navigateSurvey,
  scaleSurveyPoint,
} from "../scripts/game-mode/survey-route";
import type { AndroidDisplay } from "../packages/runtime/android-display";

const display: AndroidDisplay = {
  logicalId: 2,
  physicalId: "4619827767814508545",
  foregroundPackage: "com.example.game",
  width: 960,
  height: 540,
};
// The capture port already validates PNG data; these bytes supply its IHDR size.
function frame(
  width = 960,
  height = 540,
): { image: Buffer; display: AndroidDisplay } {
  const image = Buffer.alloc(24);
  image.writeUInt32BE(width, 16);
  image.writeUInt32BE(height, 20);
  return { image, display: { ...display, width, height } };
}
function fixture() {
  return {
    capture: vi.fn(async () => frame()),
    readDisplay: vi.fn(async () => ({ ...display })),
    input: vi.fn(async (_args: string[]) => {}),
    wait: vi.fn(async (_milliseconds: number) => {}),
  };
}

describe("survey navigation keeps capture and input on the same display", () => {
  it("only captures when no navigation was requested", async () => {
    const ports = fixture();
    const result = await navigateSurvey([], 1500, ports);
    expect(result.display).toEqual(display);
    expect(ports.capture).toHaveBeenCalledTimes(1);
    expect(ports.input).not.toHaveBeenCalled();
  });
  it("scales from actual captured dimensions and explicitly targets the logical display", async () => {
    const ports = fixture();
    await navigateSurvey([[960, 540]], 250, ports);
    expect(ports.input).toHaveBeenCalledExactlyOnceWith([
      "shell",
      "input",
      "-d",
      "2",
      "tap",
      "480",
      "270",
    ]);
    expect(ports.readDisplay).toHaveBeenCalledBefore(ports.input);
    expect(ports.wait).toHaveBeenCalledExactlyOnceWith(250);
    expect(ports.capture).toHaveBeenCalledTimes(2);
  });
  it.each([
    { logicalId: 0 },
    { physicalId: "4619827820427265280" },
    { foregroundPackage: "app.example.launcher" },
    { width: 1280, height: 720 },
  ])(
    "rejects a changed display or package before input: %j",
    async (change) => {
      const ports = fixture();
      ports.readDisplay.mockResolvedValue({ ...display, ...change });
      await expect(navigateSurvey([[960, 540]], 0, ports)).rejects.toThrow(
        /显示|前台/,
      );
      expect(ports.input).not.toHaveBeenCalled();
    },
  );
  it("stops a sequence when the first click changes the foreground package", async () => {
    const ports = fixture();
    ports.capture.mockResolvedValueOnce(frame()).mockResolvedValue({
      ...frame(),
      display: { ...display, foregroundPackage: "other.app" },
    });
    await expect(
      navigateSurvey(
        [
          [100, 100],
          [200, 200],
        ],
        0,
        ports,
      ),
    ).rejects.toThrow(/显示|前台/);
    expect(ports.input).toHaveBeenCalledTimes(1);
  });
  it("requires a known foreground package before clicking", async () => {
    const ports = fixture();
    ports.capture.mockResolvedValue({
      ...frame(),
      display: { ...display, foregroundPackage: undefined },
    });
    await expect(navigateSurvey([[100, 100]], 0, ports)).rejects.toThrow(
      /前台/,
    );
    expect(ports.input).not.toHaveBeenCalled();
  });
  it("validates all navigation points before even requesting a capture", async () => {
    const ports = fixture();
    await expect(
      navigateSurvey(
        [
          [100, 100],
          [NaN, 1],
        ],
        0,
        ports,
      ),
    ).rejects.toThrow(/坐标/);
    expect(ports.capture).not.toHaveBeenCalled();
    expect(ports.input).not.toHaveBeenCalled();
  });
  it("does not send input when focus revalidation fails", async () => {
    const ports = fixture();
    ports.readDisplay.mockRejectedValue(new Error("display unavailable"));
    await expect(navigateSurvey([[100, 100]], 0, ports)).rejects.toThrow(
      "display unavailable",
    );
    expect(ports.input).not.toHaveBeenCalled();
  });
  it("keeps rounding inside actual pixel bounds", () => {
    expect(scaleSurveyPoint([1919, 1079], 1, 1)).toEqual([0, 0]);
    expect(scaleSurveyPoint([960, 540], 1280, 720)).toEqual([640, 360]);
  });
  it.each([
    [0, 720],
    [1280, -1],
    [NaN, 1],
    [2.5, 1],
  ])("rejects invalid actual dimensions %j", (width, height) => {
    expect(() => scaleSurveyPoint([100, 100], width, height)).toThrow(/尺寸/);
  });
});
