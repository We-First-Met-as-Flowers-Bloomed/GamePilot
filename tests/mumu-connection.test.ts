import { afterEach, describe, expect, it, vi } from "vitest";
import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import {
  deriveMumuConnection,
  resolveMumuConnection,
} from "../packages/runtime/mumu-connection";

vi.mock("node:fs/promises", () => ({ stat: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

const device = {
  name: "MuMu",
  adbPath: "D:/模拟器/MuMuPlayer/nx_main/adb.exe",
  address: "127.0.0.1:16416",
};
const windows =
  "Display: mDisplayId=0\n mCurrentFocus=Window{a u0 app.launcher/.Main}\n" +
  "Display: mDisplayId=2\n mCurrentFocus=Window{b u0 com.example.game/.Main}\n" +
  "mTopFocusedDisplayId=2\n";
const displays =
  "mViewports=[DisplayViewport{valid=true, isActive=true, displayId=0, uniqueId='local:4619827820427265280'}," +
  "DisplayViewport{valid=true, isActive=true, displayId=2, uniqueId='local:4619827767814508545'}]";

afterEach(() => vi.resetAllMocks());

describe("MuMu instance transport identity", () => {
  it.each([
    ["D:/模拟器/MuMuPlayer/nx_main/adb.exe", "D:\\模拟器\\MuMuPlayer"],
    ["D:\\MuMuPlayer\\shell\\adb.exe", "D:\\MuMuPlayer"],
    [
      "D:/MuMuPlayer/nx_device/15.0/shell/adb.exe",
      "D:\\MuMuPlayer\\nx_device\\15.0",
    ],
    ["D:/MuMuPlayer/NX_MAIN/ADB.EXE", "D:\\MuMuPlayer"],
  ])(
    "derives a trusted %s installation and exact instance",
    (adbPath, path) => {
      expect(deriveMumuConnection(adbPath, device.address)).toEqual({
        path,
        index: 1,
      });
    },
  );

  it.each([
    "adb.exe",
    "D:/platform-tools/adb.exe",
    "D:/tools/shell/adb.exe",
    "../MuMuPlayer/nx_main/adb.exe",
  ])("leaves an unrelated or relative adb path unchanged: %s", (adbPath) =>
    expect(deriveMumuConnection(adbPath, "other-device")).toBeUndefined(),
  );

  it.each([
    "127.0.0.1:16385",
    "127.0.0.1:16383",
    "localhost:16384",
    "emulator-5554",
    "192.168.1.2:16384",
    "127.0.0.1:65536",
  ])(
    "rejects an ambiguous MuMu instance address without selecting instance zero: %s",
    (address) =>
      expect(() => deriveMumuConnection(device.adbPath, address)).toThrow(
        "MuMu",
      ),
  );

  it("checks the SDK and chooses the package from the focused display", async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as Awaited<
      ReturnType<typeof stat>
    >);
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      args: string[],
      _options: unknown,
      done: Function,
    ) => {
      done(null, args.includes("window") ? windows : displays, "");
    }) as typeof execFile);
    expect(await resolveMumuConnection(device)).toEqual({
      path: "D:\\模拟器\\MuMuPlayer",
      index: 1,
      appPackage: "com.example.game",
      libraryPath:
        "D:\\模拟器\\MuMuPlayer\\nx_main\\sdk\\external_renderer_ipc.dll",
    });
    expect(vi.mocked(execFile).mock.calls.map((call) => call[1])).toEqual([
      ["-s", device.address, "shell", "dumpsys", "window"],
      ["-s", device.address, "shell", "dumpsys", "display"],
    ]);
  });

  it("fails closed when the trusted MuMu installation has no usable SDK", async () => {
    vi.mocked(stat).mockRejectedValue(Error("missing"));
    await expect(resolveMumuConnection(device)).rejects.toThrow("SDK");
    expect(execFile).not.toHaveBeenCalled();
  });
});
